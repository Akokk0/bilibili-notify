import {
	type Disposable,
	fail,
	type Logger,
	type MessageBus,
	ok,
	type Result,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Api } from "../../api/api";
import { LoginFlow } from "../login-flow";
import type { BiliLoginState } from "../login-state";

/**
 * 登录流程的内部原形(private,括号取)。3a-29 提交 ⑤ 之前这些断言比旧快照的数值状态(`current().status`),
 * 现在一一对应地比原形的 `status`:LOGGED_IN→"logged-in"、NOT_LOGIN→"logged-out"、LOADING_LOGIN_INFO→"checking"、
 * LOGIN_FAILED→"failed"、LOGIN_QR→"qr"/ready、LOGGING_QR→"qr"/waiting-*。
 */
const rawOf = (flow: LoginFlow): BiliLoginState =>
	(flow as unknown as { state: BiliLoginState }).state;

/**
 * Minimal stub of Api exposing only the methods LoginFlow calls.
 * Each is a vi.fn so individual tests override per-call behaviour.
 */
function makeFakeApi() {
	const fake = {
		fetchMyselfInfo: vi.fn(),
		fetchUserCard: vi.fn(),
		fetchLoginQrCode: vi.fn(),
		fetchLoginStatus: vi.fn(),
		getCookiesJson: vi.fn(() => '[{"key":"SESSDATA","value":"x"}]'),
		commitLogin: vi.fn(async (_refreshToken?: string): Promise<Result> => ok()),
		/** 登录代:真 `Api` 在一段登录成立(与结束)时让它往前走;这里只有扫码确认成功那一下走,别的由用例自己加。 */
		loginGeneration: 0,
		/**
		 * 扫码确认成功走的口。照真 `Api` 的次序:登录代先往前走(同步、落盘之前),再落盘 —— 落盘就是上面那个
		 * `commitLogin`,所以用例照旧在它身上摆结果、数次数。
		 */
		commitScannedLogin: vi.fn((refreshToken?: string): Promise<Result> => {
			fake.loginGeneration += 1;
			return fake.commitLogin(refreshToken);
		}),
		/** 扫码拿的闸:每拿一次记一道,看它什么时候被放。 */
		holds: [] as Array<{ disposed: boolean }>,
		holdLoginSaves: vi.fn((): Disposable => {
			const hold = { disposed: false };
			fake.holds.push(hold);
			return {
				dispose() {
					hold.disposed = true;
				},
			};
		}),
	};
	return fake;
}

type FakeApi = ReturnType<typeof makeFakeApi>;

interface FakeTimer extends Disposable {
	fire(): void | Promise<void>;
	disposed: boolean;
}

/**
 * ServiceContext fake. setInterval/setTimeout return tracked Disposable handles
 * so tests can verify dispose() ran and (when needed) trigger the scheduled fn manually.
 */
function makeFakeServiceCtx() {
	const intervals: Array<{ fn: () => void | Promise<void>; ms: number; handle: FakeTimer }> = [];
	const timeouts: Array<{ fn: () => void | Promise<void>; ms: number; handle: FakeTimer }> = [];
	const disposeHooks: Array<() => void | Promise<void>> = [];
	/** 交进 `track` 的后台活(切片 ③)。 */
	const tracked: Promise<unknown>[] = [];

	const logger: Logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	};

	function makeHandle(): FakeTimer {
		const h: FakeTimer = {
			disposed: false,
			dispose: vi.fn(() => {
				h.disposed = true;
			}),
			fire: () => undefined,
		};
		return h;
	}

	const sc: ServiceContext = {
		logger,
		setInterval(fn, ms) {
			const handle = makeHandle();
			handle.fire = () => fn();
			intervals.push({ fn, ms, handle });
			return handle;
		},
		setTimeout(fn, ms) {
			const handle = makeHandle();
			handle.fire = () => fn();
			timeouts.push({ fn, ms, handle });
			return handle;
		},
		onDispose(fn) {
			disposeHooks.push(fn);
		},
		signal: new AbortController().signal,
		track: (task) => {
			tracked.push(task);
		},
	};

	return { sc, intervals, timeouts, disposeHooks, logger, tracked };
}

interface RecordedEvent {
	event: string;
	payload: unknown;
}

function makeFakeBus(): { bus: MessageBus; events: RecordedEvent[] } {
	const events: RecordedEvent[] = [];
	const bus: MessageBus = {
		emit(event, payload?: unknown) {
			events.push({ event, payload });
		},
		on() {
			return { dispose: vi.fn() };
		},
	};
	return { bus, events };
}

interface Harness {
	flow: LoginFlow;
	api: FakeApi;
	bus: MessageBus;
	events: RecordedEvent[];
	scFake: ReturnType<typeof makeFakeServiceCtx>;
}

function makeFlow(
	opts: { healthCheckMs?: number; fetchAvatar?: (url: string) => Promise<string | undefined> } = {},
): Harness {
	const api = makeFakeApi();
	const { bus, events } = makeFakeBus();
	const scFake = makeFakeServiceCtx();
	const flow = new LoginFlow({
		serviceCtx: scFake.sc,
		api: api as unknown as Api,
		bus,
		healthCheckMs: opts.healthCheckMs ?? 0,
		fetchAvatar: opts.fetchAvatar,
	});
	return { flow, api, bus, events, scFake };
}

function eventsOfKind(events: RecordedEvent[], kind: string): RecordedEvent[] {
	return events.filter((e) => e.event === kind);
}

describe("LoginFlow.reportAccountInfo()", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeFlow();
	});

	it("code === 0 transitions to LOGGED_IN and notifies onChange once", async () => {
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({
			code: 0,
			data: { card: { mid: "42", name: "n" } },
		});
		const changes = vi.fn();
		h.flow.onChange(changes);

		await h.flow.reportAccountInfo();

		expect(rawOf(h.flow).status).toBe("logged-in");
		expect(changes).toHaveBeenCalledTimes(1);
		expect(h.flow.authState()).toMatchObject({ status: "logged-in" });
	});

	it("code === -101 transitions to NOT_LOGIN and emits auth-lost only when previously LOGGED_IN", async () => {
		// First, get into LOGGED_IN
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();
		const baselineEvents = h.events.length;
		const changes = vi.fn();
		h.flow.onChange(changes);

		// Then expire
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: -101, data: { mid: 0 } });
		await h.flow.reportAccountInfo();

		expect(rawOf(h.flow).status).toBe("logged-out");
		const newEvents = h.events.slice(baselineEvents);
		expect(changes).toHaveBeenCalledTimes(1);
		expect(eventsOfKind(newEvents, "auth-lost")).toHaveLength(1);
	});

	it("code === -101 from cold start does NOT emit auth-lost (was never LOGGED_IN)", async () => {
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: -101, data: { mid: 0 } });
		await h.flow.reportAccountInfo();

		expect(rawOf(h.flow).status).toBe("logged-out");
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(0);
	});

	it("auth-restored fires once per NOT_LOGIN → LOGGED_IN recovery, never on a clean start", async () => {
		// Cold start straight to LOGGED_IN — nothing was ever parked, so no auth-restored.
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(0);

		// Become invalid (LOGGED_IN → NOT_LOGIN sets needsRestore = true)
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: -101, data: { mid: 0 } });
		await h.flow.reportAccountInfo();
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(1);
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(0);

		// Recover → fires auth-restored exactly once.
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(1);

		// And does NOT fire again on subsequent identical successes.
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(1);
	});
});

describe("LoginFlow.transition() dedupe", () => {
	it("entering the same state twice notifies onChange only once", async () => {
		const h = makeFlow();
		const changes = vi.fn();
		h.flow.onChange(changes);
		// Cold start → NOT_LOGIN via reportLoggedOut, twice.
		h.flow.reportLoggedOut("notLogin");
		h.flow.reportLoggedOut("notLogin");

		expect(changes).toHaveBeenCalledTimes(1);
		expect(rawOf(h.flow).status).toBe("logged-out");
	});
});

describe("LoginFlow.beginLogin()", () => {
	it("fetchLoginQrCode failure: no transition, no QR poll started", async () => {
		const h = makeFlow();
		const changes = vi.fn();
		h.flow.onChange(changes);
		h.api.fetchLoginQrCode.mockRejectedValueOnce(new Error("net down"));

		await h.flow.beginLogin(async () => "ignored");

		expect(changes).not.toHaveBeenCalled();
		expect(h.scFake.intervals).toHaveLength(0);
		expect(h.scFake.timeouts).toHaveLength(0);
	});

	it("renderQr failure: emits qrRenderFailed transition and does not start poll", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});

		await h.flow.beginLogin(async () => {
			throw new Error("canvas exploded");
		});

		expect(rawOf(h.flow).status).toBe("failed");
		expect(h.scFake.intervals).toHaveLength(0);
		expect(h.scFake.timeouts).toHaveLength(0);
	});

	it("fetchLoginQrCode returns non-zero code: reports QR failure and does not start poll", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({ code: -1, data: null });

		await h.flow.beginLogin(async () => "ignored");

		expect(rawOf(h.flow).status).toBe("failed");
		expect(h.scFake.intervals).toHaveLength(0);
	});

	it("poll code === 0: commits the login, transitions to LOGGED_IN, calls reportAccountInfo", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		h.api.fetchLoginStatus.mockResolvedValueOnce({
			code: 0,
			data: { code: 0, refresh_token: "rt-xyz" },
		});
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });

		await h.flow.beginLogin(async (url) => `data:image/png;base64,${url}`);

		// Interval registered. Fire it once.
		expect(h.scFake.intervals).toHaveLength(1);
		await h.scFake.intervals[0]?.handle.fire();

		expect(h.api.commitLogin).toHaveBeenCalledTimes(1);
		expect(h.api.commitLogin).toHaveBeenCalledWith("rt-xyz");
		expect(h.api.fetchMyselfInfo).toHaveBeenCalledTimes(1);
		expect(rawOf(h.flow).status).toBe("logged-in");
		// The interval timer must have been cleared.
		expect(h.scFake.intervals[0]?.handle.disposed).toBe(true);
	});

	it("poll code === 86038 (qr invalidated): cleans up the poll timer", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		h.api.fetchLoginStatus.mockResolvedValueOnce({ code: 0, data: { code: 86038 } });

		await h.flow.beginLogin(async () => "data:url");
		expect(h.scFake.intervals).toHaveLength(1);
		await h.scFake.intervals[0]?.handle.fire();

		expect(h.scFake.intervals[0]?.handle.disposed).toBe(true);
		expect(rawOf(h.flow).status).toBe("failed");
	});

	it("poll code === 86101 (waitScan): keeps polling, no save, snapshot in LOGGING_QR", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		h.api.fetchLoginStatus.mockResolvedValueOnce({ code: 0, data: { code: 86101 } });

		await h.flow.beginLogin(async () => "data:url");
		await h.scFake.intervals[0]?.handle.fire();

		expect(rawOf(h.flow)).toMatchObject({ status: "qr", phase: "waiting-scan" });
		expect(h.api.commitLogin).not.toHaveBeenCalled();
		expect(h.scFake.intervals[0]?.handle.disposed).toBe(false);
	});

	it("LOGIN_QR → LOGGING_QR (waitScan/waitConfirm) preserves the QR data field", async () => {
		// Regression: prior implementation dropped `data` on the LOGGING_QR
		// transition, so the dashboard's QR card flickered to "二维码加载中"
		// the moment polling reported 86101/86090.
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		h.api.fetchLoginStatus.mockResolvedValueOnce({ code: 0, data: { code: 86101 } });

		await h.flow.beginLogin(async () => "data:image/png;base64,QR_BASE64_PAYLOAD");
		expect(rawOf(h.flow)).toMatchObject({ status: "qr", phase: "ready" });
		expect(rawOf(h.flow)).toMatchObject({ dataUrl: "data:image/png;base64,QR_BASE64_PAYLOAD" });

		await h.scFake.intervals[0]?.handle.fire();

		expect(rawOf(h.flow)).toMatchObject({ status: "qr", phase: "waiting-scan" });
		// The QR is still useful (user hasn't confirmed on phone yet) — must not be dropped.
		expect(rawOf(h.flow)).toMatchObject({ dataUrl: "data:image/png;base64,QR_BASE64_PAYLOAD" });
	});
});

/**
 * 关停(切片 ③)。扫码成功的那一拍把 cookie 与令牌提交进集成的密钥存储 —— 轮询回调是同步签名的定时器
 * 回调,不登记进 `ctx.track()` 的话,关停对它一无所知,cookie 写道关门时它可能还没落完。
 */
describe("LoginFlow.beginLogin() — 轮询登记进 track", () => {
	function loggedInPoll(h: Harness) {
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		h.api.fetchLoginStatus.mockResolvedValueOnce({
			code: 0,
			data: { code: 0, refresh_token: "rt" },
		});
		h.api.fetchMyselfInfo.mockResolvedValue({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValue({ code: 0, data: { card: { mid: "42" } } });
	}

	it("扫码成功那一拍:cookie 落盘之后它才落定", async () => {
		const h = makeFlow();
		loggedInPoll(h);
		const save = deferred<Result>();
		h.api.commitLogin.mockReturnValueOnce(save.promise);
		await h.flow.beginLogin(async () => "data:url");

		void h.scFake.intervals[0]?.handle.fire();
		await flush();

		expect(h.scFake.tracked).toHaveLength(1);
		expect(h.api.commitLogin).toHaveBeenCalledTimes(1);
		let settled = false;
		void h.scFake.tracked[0]?.then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false); // cookie 还没落盘,登记的这件事不许落

		save.resolve(ok());
		await h.scFake.tracked[0];
		expect(rawOf(h.flow).status).toBe("logged-in");
	});

	it("轮询里抛了错:登记进去的这件事不拒,记一条 warn,下一拍还能轮询", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		h.api.fetchLoginStatus.mockResolvedValueOnce({ code: 0, data: { code: 86101 } });
		await h.flow.beginLogin(async () => "data:url");
		// waitScan 之后的状态汇报炸了 —— 以前这是定时器回调里的 unhandledRejection。
		vi.spyOn(
			h.flow as unknown as { reportQrPending: () => void },
			"reportQrPending",
		).mockImplementation(() => {
			throw new Error("boom");
		});

		await h.scFake.intervals[0]?.handle.fire();

		await expect(h.scFake.tracked[0]).resolves.toBeUndefined();
		expect(h.scFake.logger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
		h.api.fetchLoginStatus.mockResolvedValueOnce({ code: 0, data: { code: 86101 } });
		await h.scFake.intervals[0]?.handle.fire();
		expect(h.scFake.tracked).toHaveLength(2); // polling 标志复位了,下一拍照常轮询
	});
});

/**
 * 扫码那道闸(登录回应的 Set-Cookie 先进罐子、令牌后到,这中间罐子不许自动存):起轮询时拿,轮询结束的每一条路放;
 * 成功那一支在提交之后才放。放闸收在 `clearLoginTimer` 一处。
 */
describe("LoginFlow.beginLogin() — 扫码期间的存盘闸", () => {
	function qrReady(h: Harness) {
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
	}

	it("起轮询时拿一道闸;还在等扫码时一直握着", async () => {
		const h = makeFlow();
		qrReady(h);
		h.api.fetchLoginStatus.mockResolvedValueOnce({ code: 0, data: { code: 86101 } });
		await h.flow.beginLogin(async () => "data:url");
		expect(h.api.holds).toHaveLength(1);
		expect(h.api.holds[0]?.disposed).toBe(false);

		await h.scFake.intervals[0]?.handle.fire();

		expect(h.api.holds[0]?.disposed).toBe(false);
	});

	it("拿不到二维码:没起轮询,也就没拿闸", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({ code: -1, data: null });
		await h.flow.beginLogin(async () => "ignored");
		expect(h.api.holdLoginSaves).not.toHaveBeenCalled();
	});

	it.each([
		["二维码失效(86038)", { code: 0, data: { code: 86038 } }],
		["登录失败(外层 code 非 0)", { code: -1, data: null }],
		["未知的 data.code", { code: 0, data: { code: 12345 } }],
	])("%s:放闸", async (_name, reply) => {
		const h = makeFlow();
		qrReady(h);
		h.api.fetchLoginStatus.mockResolvedValueOnce(reply);
		await h.flow.beginLogin(async () => "data:url");
		expect(h.api.holds[0]?.disposed).toBe(false);

		await h.scFake.intervals[0]?.handle.fire();

		expect(h.api.holds[0]?.disposed).toBe(true);
	});

	it("3 分钟过期:放闸", async () => {
		const h = makeFlow();
		qrReady(h);
		await h.flow.beginLogin(async () => "data:url");
		expect(h.api.holds[0]?.disposed).toBe(false);

		await h.scFake.timeouts[0]?.handle.fire();

		expect(h.api.holds[0]?.disposed).toBe(true);
	});

	it("stop():放闸", async () => {
		const h = makeFlow();
		qrReady(h);
		await h.flow.beginLogin(async () => "data:url");

		h.flow.stop();

		expect(h.api.holds[0]?.disposed).toBe(true);
	});

	it("重新开始扫码:旧的闸放掉、换一道新的(同一时刻只有一道扫码闸)", async () => {
		const h = makeFlow();
		qrReady(h);
		qrReady(h);
		await h.flow.beginLogin(async () => "data:url");
		await h.flow.beginLogin(async () => "data:url");

		expect(h.api.holds.map((hold) => hold.disposed)).toEqual([true, false]);
	});

	it("登录成功:提交还没落定时闸还握着;提交落定之后才放", async () => {
		const h = makeFlow();
		qrReady(h);
		h.api.fetchLoginStatus.mockResolvedValueOnce({
			code: 0,
			data: { code: 0, refresh_token: "rt" },
		});
		h.api.fetchMyselfInfo.mockResolvedValue({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValue({ code: 0, data: { card: { mid: "42" } } });
		const commit = deferred<Result>();
		h.api.commitLogin.mockReturnValueOnce(commit.promise);
		await h.flow.beginLogin(async () => "data:url");

		void h.scFake.intervals[0]?.handle.fire();
		await flush();

		// 轮询定时器已经收了,但闸要等提交。
		expect(h.scFake.intervals[0]?.handle.disposed).toBe(true);
		expect(h.api.commitLogin).toHaveBeenCalledTimes(1);
		expect(h.api.holds[0]?.disposed).toBe(false);

		commit.resolve(ok());
		await h.scFake.tracked[0];

		expect(h.api.holds[0]?.disposed).toBe(true);
	});

	it("登录成功但罐子是空的:放弃保存,闸照样放", async () => {
		const h = makeFlow();
		qrReady(h);
		h.api.fetchLoginStatus.mockResolvedValueOnce({
			code: 0,
			data: { code: 0, refresh_token: "rt" },
		});
		h.api.getCookiesJson.mockReturnValueOnce("[]");
		await h.flow.beginLogin(async () => "data:url");

		await h.scFake.intervals[0]?.handle.fire();

		expect(h.api.commitLogin).not.toHaveBeenCalled();
		expect(h.api.holds[0]?.disposed).toBe(true);
	});

	it("提交失败:记 error,闸照样放(留闸是 commitLogin 自己的事)", async () => {
		const h = makeFlow();
		qrReady(h);
		h.api.fetchLoginStatus.mockResolvedValueOnce({
			code: 0,
			data: { code: 0, refresh_token: "rt" },
		});
		h.api.fetchMyselfInfo.mockResolvedValue({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValue({ code: 0, data: { card: { mid: "42" } } });
		h.api.commitLogin.mockResolvedValueOnce(fail("unavailable", "disk full"));
		await h.flow.beginLogin(async () => "data:url");

		await h.scFake.intervals[0]?.handle.fire();

		expect(h.scFake.logger.error).toHaveBeenCalledWith(expect.stringContaining("disk full"));
		expect(h.api.holds[0]?.disposed).toBe(true);
		expect(rawOf(h.flow).status).toBe("logged-in");
	});
});

describe("LoginFlow.stop()", () => {
	it("is idempotent (calling twice does not throw)", () => {
		const h = makeFlow();
		expect(() => {
			h.flow.stop();
			h.flow.stop();
		}).not.toThrow();
	});

	it("after beginLogin, stop() disposes the active QR poll + expiry timer", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		await h.flow.beginLogin(async () => "data:url");

		expect(h.scFake.intervals).toHaveLength(1);
		expect(h.scFake.timeouts).toHaveLength(1);

		h.flow.stop();
		expect(h.scFake.intervals[0]?.handle.disposed).toBe(true);
		expect(h.scFake.timeouts[0]?.handle.disposed).toBe(true);
	});
});

describe("LoginFlow — 冷启动即登录过期,重新登录后必须放行 auth-restored", () => {
	it("启动时 cookie 已失效 → 重新登录后仍发 auth-restored(下游引擎靠它复活)", async () => {
		const h = makeFlow();
		// 冷启动探测:cookie 过期。此时快照还是 LOADING_LOGIN_INFO,不是 LOGGED_IN。
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: -101, data: { mid: 0 } });
		await h.flow.reportAccountInfo();
		expect(rawOf(h.flow).status).toBe("logged-out");

		// 主人扫码重新登录成功。
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();

		// 动态引擎在自己撞上 -101 时就已经停了 cron,并明写「待 auth-restored 重启」。
		// 它是否收到这条事件,与登录流当初有没有发过 auth-lost 无关。
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(1);
	});
});

/** 手动兑现的 Promise —— 把「请求还在途中」这个状态钉在测试里。 */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (v: T) => void;
	reject: (e: unknown) => void;
} {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** 还活着(没被 dispose)的定时器。心跳有没有被悄悄重挂,看这个。 */
function liveTimers(h: Harness): unknown[] {
	return h.scFake.intervals.filter((i) => !i.handle.disposed);
}

/** 让所有已排队的微任务跑完。 */
function flush(): Promise<void> {
	return new Promise<void>((r) => setTimeout(r, 0));
}

describe("LoginFlow — 会话已死时,在途探活的迟到成功不得把它救活", () => {
	/*
	 * 线上实况(2026-07-27 20:15:12):cookie 刷新链拿到 -101,拦截器同步发
	 * `auth-lost`,动态检测暂停、三个直播间连接全关。**33 毫秒后**却冒出一条
	 * `auth-restored`,于是直播监听重建、动态检测重启、五个订阅补关注 —— 全部
	 * 再撞一遍 -101,主人的 QQ 被刷了六条私聊,其中「账号登录已失效」两条。
	 *
	 * 根因不是谁乱发事件,而是**在会话被判死之前发出去的那次探活**迟到返回了
	 * code 0:`reportLoggedIn` 只看「上一帧不是 LOGGED_IN」+「needsRestore」,
	 * 没有任何判据能认出这份成功已经过期。
	 *
	 * 健康检查默认 30 分钟、cookie 刷新固定 60 分钟,两者每小时对齐一次 ——
	 * 这个窗口不是理论上的,是每小时都要经过一遍的。
	 */

	it("心跳探活在途时会话被判死 → 迟到的 code 0 不得触发 auth-restored", async () => {
		const h = makeFlow({ healthCheckMs: 30 * 60_000 });
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();
		expect(rawOf(h.flow).status).toBe("logged-in");

		// 心跳发出探活请求,此刻会话还活着,B 站也还认。
		const probe = deferred<{ code: number; data: { mid: number } }>();
		h.api.fetchMyselfInfo.mockReturnValueOnce(probe.promise);
		h.scFake.intervals[0]?.handle.fire();
		await flush();

		// 探活在途期间,cookie 刷新链撞上 -101 —— 拦截器同步走到这里。
		await h.flow.handleAuthLost();
		expect(rawOf(h.flow).status).toBe("logged-out");
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(1);

		// 迟到的答复:它问的是那个已经死掉的会话,答案早就不作数了。
		probe.resolve({ code: 0, data: { mid: 42 } });
		await flush();

		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(0);
		expect(rawOf(h.flow).status).toBe("logged-out");
	});

	it("取用户卡片在途时会话被判死 → 不得报回 LOGGED_IN", async () => {
		// `reportAccountInfo` 在探活成功与 `reportLoggedIn` 之间还夹着一次
		// `fetchUserCard` 网络往返,那是第二个同样宽的窗口。
		const h = makeFlow();
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();

		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		const card = deferred<{ code: number; data: { card: { mid: string } } }>();
		h.api.fetchUserCard.mockReturnValueOnce(card.promise);
		const pending = h.flow.reportAccountInfo();
		await flush();

		await h.flow.handleAuthLost();
		card.resolve({ code: 0, data: { card: { mid: "42" } } });
		await pending;

		expect(rawOf(h.flow).status).toBe("logged-out");
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(0);
	});

	it("主人手动退出登录后,在途探活不得把他登回去", async () => {
		// 同一个洞的另一面,而且这一面是安全问题:点了「退出登录」,盘上 cookie
		// 已清、内存 jar 已清,快照却被一次迟到的探活推回「已登录」。
		const h = makeFlow({ healthCheckMs: 30 * 60_000 });
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();

		const probe = deferred<{ code: number; data: { mid: number } }>();
		h.api.fetchMyselfInfo.mockReturnValueOnce(probe.promise);
		h.scFake.intervals[0]?.handle.fire();
		await flush();

		h.flow.reportLoggedOut("notLogin");
		probe.resolve({ code: 0, data: { mid: 42 } });
		await flush();

		expect(rawOf(h.flow).status).toBe("logged-out");
	});

	/*
	 * 下面三条守的是同一个洞的另一头:`reportAccountInfo` 在失败路径上会
	 * `attachHealthCheck()`,而 `reportLoggedOut` 是**刻意**把心跳摘掉的
	 * (登出后 runHealthCheck 只会一路 skip,留着就是个空转定时器 —— 那正是
	 * 当初 P2 修过的问题)。一次迟到的答复不该把它重新挂回来。
	 */

	it("迟到的探活返回风控码 → 不得把已被摘掉的心跳重新挂上", async () => {
		const h = makeFlow({ healthCheckMs: 30 * 60_000 });
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();
		expect(liveTimers(h)).toHaveLength(1);

		const probe = deferred<{ code: number; data: { mid: number } }>();
		h.api.fetchMyselfInfo.mockReturnValueOnce(probe.promise);
		const pending = h.flow.reportAccountInfo();
		await flush();

		await h.flow.handleAuthLost();
		expect(liveTimers(h)).toHaveLength(0);

		// -352 既不是 0 也不是 -101,走的正是「瞬时失败 + 重挂心跳」那条路。
		probe.resolve({ code: -352, data: { mid: 0 } });
		await pending;

		expect(liveTimers(h)).toHaveLength(0);
	});

	it("迟到的探活抛网络异常 → 同样不得复活心跳", async () => {
		const h = makeFlow({ healthCheckMs: 30 * 60_000 });
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();

		const probe = deferred<{ code: number; data: { mid: number } }>();
		h.api.fetchMyselfInfo.mockReturnValueOnce(probe.promise);
		const pending = h.flow.reportAccountInfo();
		await flush();

		await h.flow.handleAuthLost();
		probe.reject(new Error("net down"));
		await pending;

		expect(liveTimers(h)).toHaveLength(0);
	});

	it("主人手动退出后,迟到的 -101 不得把「已退出」改写成「登录已失效」", async () => {
		const h = makeFlow();
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();

		const probe = deferred<{ code: number; data: { mid: number } }>();
		h.api.fetchMyselfInfo.mockReturnValueOnce(probe.promise);
		const pending = h.flow.reportAccountInfo();
		await flush();

		// 主人自己点了「退出登录」。
		h.flow.reportLoggedOut("notLogin");
		const stateAfterLogout = rawOf(h.flow);

		probe.resolve({ code: -101, data: { mid: 0 } });
		await pending;

		// 面板上该显示「请点击扫码登录」,而不是吓人的「登录已失效」。
		expect(rawOf(h.flow)).toEqual(stateAfterLogout);
		expect(h.flow.authState()).toEqual({ status: "logged-out" });
	});

	it("登出与探活无交叠时,一切照旧 —— 守卫不得误伤正常恢复", async () => {
		const h = makeFlow();
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();

		await h.flow.handleAuthLost();
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(1);

		// 登出**先**落定,之后才发起的探活是问新状态的,必须照常放行。
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();

		expect(rawOf(h.flow).status).toBe("logged-in");
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(1);
	});
});

/**
 * `healthCheckNow`:把登录心跳提前到现在(宿主 devtools「现在就跑」)。走的就是定时器
 * 到点跑的那次心跳:登录着才查(一次 fetchMyselfInfo),没登录 / 扫码中就跳过、回 false。
 */
describe("LoginFlow.healthCheckNow()", () => {
	it("登录着:立刻查一次,-101 就翻成未登录并发 auth-lost", async () => {
		const h = makeFlow();
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({
			code: 0,
			data: { card: { mid: "42", name: "n" } },
		});
		await h.flow.reportAccountInfo();
		h.api.fetchMyselfInfo.mockClear();

		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: -101, data: { mid: 0 } });
		expect(await h.flow.healthCheckNow()).toBe(true);

		expect(h.api.fetchMyselfInfo).toHaveBeenCalledTimes(1);
		expect(rawOf(h.flow).status).toBe("logged-out");
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(1);
	});

	it("没登录:跳过,不打请求,回 false", async () => {
		const h = makeFlow();
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: -101, data: { mid: 0 } });
		await h.flow.reportAccountInfo();
		h.api.fetchMyselfInfo.mockClear();

		expect(await h.flow.healthCheckNow()).toBe(false);
		expect(h.api.fetchMyselfInfo).not.toHaveBeenCalled();
	});
});

describe("LoginFlow.beginLogin() — 回结果形状(3a-29 提交 ②)", () => {
	it("取码请求抛错:回 unavailable 与固定的话,状态不动、不发事件", async () => {
		const h = makeFlow();
		const changes = vi.fn();
		h.flow.onChange(changes);
		h.api.fetchLoginQrCode.mockRejectedValueOnce(new Error("net down"));

		const r = await h.flow.beginLogin(async () => "ignored");

		expect(r).toEqual(fail("unavailable", "获取二维码失败，请重试"));
		expect(rawOf(h.flow).status).toBe("checking");
		expect(changes).not.toHaveBeenCalled();
	});

	it("B 站回非 0 码:进失败状态,回 unavailable 并带 upstreamCode", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({ code: -1, data: null });

		const r = await h.flow.beginLogin(async () => "ignored");

		expect(r).toEqual(fail("unavailable", "获取二维码失败，请重试", { upstreamCode: -1 }));
		expect(rawOf(h.flow).status).toBe("failed");
	});

	it.each([-352, -403])("B 站回 %i(风控):回 rate_limited", async (code) => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({ code, data: null });

		const r = await h.flow.beginLogin(async () => "ignored");

		expect(r).toEqual(fail("rate_limited", "获取二维码失败，请重试", { upstreamCode: code }));
		expect(rawOf(h.flow).status).toBe("failed");
	});

	it("渲染二维码失败:进失败状态,回 unavailable", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});

		const r = await h.flow.beginLogin(async () => {
			throw new Error("canvas exploded");
		});

		expect(r).toEqual(fail("unavailable", "生成二维码失败"));
		expect(rawOf(h.flow).status).toBe("failed");
	});

	it("成功:回 ok,进等待扫码", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});

		const r = await h.flow.beginLogin(async () => "data:url");

		expect(r).toEqual(ok());
		expect(rawOf(h.flow)).toMatchObject({ status: "qr", phase: "ready" });
	});
});

/**
 * 两个边事件 `auth-lost` / `auth-restored` 的刻画测试(3a-29 提交 ②):钉的是今天的行为,
 * 后面改状态机外壳时它们不许动。真 `LoginFlow` + 假 `Api` + 手动拨的假定时器。
 */
describe("LoginFlow — 两个边事件今天的确切语义", () => {
	const HEALTH_MS = 60_000;

	/** 找出还没被收掉的心跳定时器(间隔等于健康检查间隔的那一个)。 */
	function liveHeartbeat(h: Harness) {
		return h.scFake.intervals.filter((i) => i.ms === HEALTH_MS && !i.handle.disposed).at(-1);
	}

	async function logIn(h: Harness): Promise<void> {
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();
		expect(rawOf(h.flow).status).toBe("logged-in");
	}

	it("已登录时再扫码、不扫、等超时:不发 auth-lost;心跳把快照推回已登录,不发 auth-restored", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		await logIn(h);
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});

		await h.flow.beginLogin(async () => "data:url");
		expect(rawOf(h.flow)).toMatchObject({ status: "qr", phase: "ready" });
		await h.scFake.timeouts.at(-1)?.handle.fire(); // 3 分钟到了
		expect(rawOf(h.flow).status).toBe("failed");

		// LOGIN_FAILED 不在心跳的跳过名单里:到点照查。
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		// 失败回来的这一帧没带账号:心跳成功后补取一次卡片(3a-29 S3)。
		h.api.fetchUserCard.mockResolvedValueOnce({
			code: 0,
			data: { card: { mid: "42", name: "n" } },
		});
		await liveHeartbeat(h)?.handle.fire();
		await flush();

		expect(rawOf(h.flow).status).toBe("logged-in");
		expect(h.flow.account()).toEqual({ name: "n" });
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(0);
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(0);
	});

	it("冷启动探活网络失败(停在 LOADING)之后心跳成功:不发 auth-restored", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		h.api.fetchMyselfInfo.mockRejectedValueOnce(new Error("net down"));
		await h.flow.reportAccountInfo();
		expect(rawOf(h.flow).status).toBe("checking");

		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		await liveHeartbeat(h)?.handle.fire();
		await flush();

		expect(rawOf(h.flow).status).toBe("logged-in");
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(0);
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(0);
	});

	it('手动退出登录(reportLoggedOut("notLogin")):上一帧是已登录就发一次 auth-lost,没登录时不发', async () => {
		const h = makeFlow();
		await logIn(h);

		h.flow.reportLoggedOut("notLogin");
		expect(rawOf(h.flow).status).toBe("logged-out");
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(1);

		h.flow.reportLoggedOut("notLogin"); // 已经是未登录:再退不再发
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(1);
	});
});

/** 对外的状态与账号(3a-29 提交 ③):`onChange` 的去重、头像这条后台线。 */
describe("LoginFlow — onChange(对外状态与账号)", () => {
	const cardOf = (face: string) => ({ card: { mid: "42", name: "n", face } });

	/** 此刻对外读到的(状态,账号),每次 onChange 记一份。 */
	function watch(h: Harness) {
		const seen: Array<{ status: string; name?: string; avatar?: string }> = [];
		h.flow.onChange(() => {
			const acct = h.flow.account();
			seen.push({ status: h.flow.authState().status, name: acct?.name, avatar: acct?.avatar });
		});
		return seen;
	}

	async function logIn(h: Harness, face = "https://i0.hdslb.com/a.jpg") {
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: cardOf(face) });
		await h.flow.reportAccountInfo();
		await Promise.all(h.scFake.tracked);
	}

	it("对外状态与账号都没变就不叫:重复登出、账号信息暂时取不到都不叫", async () => {
		const h = makeFlow();
		await logIn(h);
		const seen = watch(h);

		// 探活抛网络异常:旧快照的话变了(「获取个人信息失败」),对外状态与账号都没变。
		h.api.fetchMyselfInfo.mockRejectedValueOnce(new Error("net down"));
		await h.flow.reportAccountInfo();
		expect(seen).toHaveLength(0);

		h.flow.reportLoggedOut("notLogin");
		expect(seen).toHaveLength(1);
		h.flow.reportLoggedOut("notLogin");
		expect(seen).toHaveLength(1);
	});

	it("扫码成功:进已登录叫一声(账号还没有),账号到了叫一声,头像到了再叫一声", async () => {
		const h = makeFlow({ fetchAvatar: async () => "avatar-ref" });
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		h.api.fetchLoginStatus.mockResolvedValueOnce({
			code: 0,
			data: { code: 0, refresh_token: "rt" },
		});
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({
			code: 0,
			data: cardOf("https://i0.hdslb.com/a.jpg"),
		});
		await h.flow.beginLogin(async () => "data:url");
		const seen = watch(h);

		await h.scFake.intervals[0]?.handle.fire();
		await Promise.all(h.scFake.tracked);

		expect(seen).toEqual([
			{ status: "logged-in", name: undefined, avatar: undefined },
			{ status: "logged-in", name: "n", avatar: undefined },
			{ status: "logged-in", name: "n", avatar: "avatar-ref" },
		]);
	});

	it("被登出作废的迟到探活不叫", async () => {
		const h = makeFlow();
		await logIn(h);
		const seen = watch(h);
		const probe = deferred<{ code: number; data: { mid: number } }>();
		h.api.fetchMyselfInfo.mockReturnValueOnce(probe.promise);

		const pending = h.flow.reportAccountInfo();
		h.flow.reportLoggedOut("notLogin");
		expect(seen).toHaveLength(1);
		probe.resolve({ code: 0, data: { mid: 42 } });
		await pending;

		expect(seen).toHaveLength(1);
		expect(h.flow.authState().status).toBe("logged-out");
	});

	it("等待扫码 → 已扫等确认:从 pollOnce 驱动,叫一声且 message 是「已扫码」那句;还没扫的那拍不叫", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		await h.flow.beginLogin(async () => "data:url");
		const seen = watch(h);

		h.api.fetchLoginStatus.mockResolvedValueOnce({ code: 0, data: { code: 86101 } });
		await h.scFake.intervals[0]?.handle.fire();
		expect(seen).toHaveLength(0); // ready → waiting-scan:对外都是 awaiting-scan

		h.api.fetchLoginStatus.mockResolvedValueOnce({ code: 0, data: { code: 86090 } });
		await h.scFake.intervals[0]?.handle.fire();
		expect(seen).toHaveLength(1);
		expect(h.flow.authState()).toEqual({ status: "confirming", message: "已扫码，请在手机上确认" });
	});

	it("开机没确认上:对外是 confirming 且 message 是「正在向 B 站确认」那句,不是登录", () => {
		const h = makeFlow();
		expect(h.flow.authState()).toEqual({
			status: "confirming",
			message: "正在向 B 站确认登录状态，暂时连不上的话会自动重试",
		});
		expect(h.flow.account()).toBeNull();
	});

	it("loggedInAt 在同一段登录里不随卡片补到而变", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		h.api.fetchLoginStatus.mockResolvedValueOnce({
			code: 0,
			data: { code: 0, refresh_token: "rt" },
		});
		const probe = deferred<{ code: number; data: { mid: number } }>();
		h.api.fetchMyselfInfo.mockReturnValueOnce(probe.promise);
		h.api.fetchUserCard.mockResolvedValueOnce({
			code: 0,
			data: cardOf("https://i0.hdslb.com/a.jpg"),
		});
		await h.flow.beginLogin(async () => "data:url");
		const polling = h.scFake.intervals[0]?.handle.fire();
		await flush();
		const first = h.flow.authState();
		expect(first.status).toBe("logged-in"); // 卡片还没取到的那一小段
		await new Promise((r) => setTimeout(r, 5));
		probe.resolve({ code: 0, data: { mid: 42 } });
		await polling;
		await Promise.all(h.scFake.tracked);

		expect(h.flow.authState()).toEqual(first);
		expect(h.flow.account()?.name).toBe("n");
	});
});

describe("LoginFlow — 账号头像这条后台线", () => {
	const HEALTH_MS = 60_000;
	const cardOf = (face: string) => ({ card: { mid: "42", name: "n", face } });
	const A = "https://i0.hdslb.com/a.jpg";
	const B = "https://i0.hdslb.com/b.jpg";

	async function logIn(h: Harness, face = A) {
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: cardOf(face) });
		await h.flow.reportAccountInfo();
	}

	it("取到卡片后抓一次:account().avatar 有值;网址没变不重抓", async () => {
		const fetchAvatar = vi.fn(async (_url: string): Promise<string | undefined> => "ref-a");
		const h = makeFlow({ healthCheckMs: HEALTH_MS, fetchAvatar });

		await logIn(h);
		await Promise.all(h.scFake.tracked);
		expect(fetchAvatar).toHaveBeenCalledTimes(1);
		expect(fetchAvatar).toHaveBeenCalledWith(A);
		expect(h.flow.account()).toEqual({ name: "n", avatar: "ref-a" });

		// 同一个头像网址的第二次探活与心跳:不重抓。
		await logIn(h);
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		await h.scFake.intervals.at(-1)?.handle.fire();
		await flush();
		await Promise.all(h.scFake.tracked);
		expect(fetchAvatar).toHaveBeenCalledTimes(1);
	});

	it("抓不到(回空):账号照常、头像缺着,登录状态与事件一个字不动", async () => {
		const h = makeFlow({ fetchAvatar: async () => undefined });
		await logIn(h);
		const eventsBefore = h.events.length;
		await Promise.all(h.scFake.tracked);

		expect(h.flow.account()).toEqual({ name: "n" });
		expect(h.flow.authState().status).toBe("logged-in");
		expect(h.events.length).toBe(eventsBefore);
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(0);
	});

	it("抓头像抛了:记 warn,账号照常、状态不变,不走到登出与瞬时失败", async () => {
		const h = makeFlow({
			fetchAvatar: async () => {
				throw new Error("boom");
			},
		});
		await logIn(h);
		const eventsBefore = h.events.length;
		await Promise.all(h.scFake.tracked);

		expect(h.flow.account()).toEqual({ name: "n" });
		expect(rawOf(h.flow)).toMatchObject({ status: "logged-in", reason: "loggedIn" });
		expect(h.events.length).toBe(eventsBefore);
		expect(h.scFake.logger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
	});

	it("抓的途中退出登录:结果丢掉,账号没了;之后重新登录同一个头像网址会重抓", async () => {
		const first = deferred<string | undefined>();
		const fetchAvatar = vi
			.fn<(url: string) => Promise<string | undefined>>()
			.mockReturnValueOnce(first.promise)
			.mockResolvedValue("ref-new");
		const h = makeFlow({ fetchAvatar });
		await logIn(h);
		expect(fetchAvatar).toHaveBeenCalledTimes(1);

		h.flow.reportLoggedOut("notLogin");
		await logIn(h); // 同一个网址、新的一段登录
		await Promise.all(h.scFake.tracked.slice(1));
		expect(fetchAvatar).toHaveBeenCalledTimes(2);
		expect(h.flow.account()).toEqual({ name: "n", avatar: "ref-new" });

		first.resolve("ref-old"); // 迟到的旧结果
		await Promise.all(h.scFake.tracked);
		expect(h.flow.account()).toEqual({ name: "n", avatar: "ref-new" });
	});

	it("抓的途中退出登录且没有再登录:迟到的结果丢掉,账号是 null", async () => {
		const pending = deferred<string | undefined>();
		const h = makeFlow({ fetchAvatar: () => pending.promise });
		await logIn(h);
		h.flow.reportLoggedOut("notLogin");
		pending.resolve("ref-a");
		await Promise.all(h.scFake.tracked);
		expect(h.flow.account()).toBeNull();
	});

	it("抓的途中头像网址变了:旧网址的结果丢掉,新网址的留着", async () => {
		const first = deferred<string | undefined>();
		const fetchAvatar = vi
			.fn<(url: string) => Promise<string | undefined>>()
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce("ref-b");
		const h = makeFlow({ fetchAvatar });
		await logIn(h, A);
		await logIn(h, B); // 恢复备份之类:同一段登录里账号换了头像
		await Promise.all(h.scFake.tracked.slice(1));
		expect(h.flow.account()).toEqual({ name: "n", avatar: "ref-b" });

		first.resolve("ref-a");
		await Promise.all(h.scFake.tracked);
		expect(h.flow.account()).toEqual({ name: "n", avatar: "ref-b" });
	});

	it("心跳成功且头像缺着(上次没抓成):补抓一次;心跳的判定不等它", async () => {
		const fetchAvatar = vi
			.fn<(url: string) => Promise<string | undefined>>()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce("ref-a");
		const h = makeFlow({ healthCheckMs: HEALTH_MS, fetchAvatar });
		await logIn(h);
		await Promise.all(h.scFake.tracked);
		expect(h.flow.account()).toEqual({ name: "n" });

		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		await h.scFake.intervals.at(-1)?.handle.fire();
		await flush();
		await Promise.all(h.scFake.tracked);

		expect(fetchAvatar).toHaveBeenCalledTimes(2);
		expect(h.flow.account()).toEqual({ name: "n", avatar: "ref-a" });
	});

	it("重启后(新的实例,内存清空)取到卡片就重抓一次", async () => {
		const fetchAvatar = vi.fn(async (_url: string): Promise<string | undefined> => "ref-a");
		const before = makeFlow({ fetchAvatar });
		await logIn(before);
		await Promise.all(before.scFake.tracked);
		const after = makeFlow({ fetchAvatar });
		await logIn(after);
		await Promise.all(after.scFake.tracked);

		expect(fetchAvatar).toHaveBeenCalledTimes(2);
		expect(after.flow.account()).toEqual({ name: "n", avatar: "ref-a" });
	});
});

/**
 * M1:B 站的用户卡片回应是外部数据。形状不对(非 0 码带别的 data、`code 0` 缺格、data 是 null)时按「卡片没取到」走:
 * 状态照常是已登录、`auth-restored` 照发、心跳照挂、`account()` 是 `null`(方案 §3.2:没取到就是 null)、什么都不抛。
 */
describe("LoginFlow — 卡片回应形状不对(M1)", () => {
	const HEALTH_MS = 60_000;
	const BAD: Array<[string, unknown]> = [
		["非 0 码带别的 data(风控 v_voucher)", { code: -352, data: { v_voucher: "voucher_x" } }],
		[
			"非 0 码但 data 里带着看起来正常的 card",
			{ code: -352, data: { card: { name: "x", face: "" } } },
		],
		["code 0 但 data 是空对象(缺 card)", { code: 0, data: {} }],
		["code 0 但 data 是 null", { code: 0, data: null }],
		["code 0 但 card 缺名字", { code: 0, data: { card: { face: "https://i0.hdslb.com/a.jpg" } } }],
		["整个回应是 undefined", undefined],
	];

	function liveHeartbeat(h: Harness) {
		return h.scFake.intervals.filter((i) => i.ms === HEALTH_MS && !i.handle.disposed).at(-1);
	}

	it.each(BAD)(
		"%s:不抛,已登录,auth-restored 照发,心跳照挂,account() 是 null",
		async (_name, bad) => {
			const h = makeFlow({ healthCheckMs: HEALTH_MS });
			h.flow.reportLoggedOut("notLogin"); // 记账:needsRestore
			h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
			h.api.fetchUserCard.mockResolvedValueOnce(bad);

			await expect(h.flow.reportAccountInfo()).resolves.toBeUndefined();

			expect(rawOf(h.flow).status).toBe("logged-in");
			expect(h.flow.authState().status).toBe("logged-in");
			expect(h.flow.account()).toBeNull();
			expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(1);
			expect(liveHeartbeat(h)).toBeDefined();
			// 只记上游的码,不把整个回应(可能带 voucher)写进日志。
			expect(JSON.stringify(vi.mocked(h.scFake.logger.warn).mock.calls)).not.toContain("voucher_x");
		},
	);

	it("非 0 码的 warn 带上游的码", async () => {
		const h = makeFlow();
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: -352, data: { v_voucher: "voucher_x" } });
		await h.flow.reportAccountInfo();
		expect(h.scFake.logger.warn).toHaveBeenCalledWith(expect.stringContaining("code=-352"));
	});

	it("个人信息里没有用户 id:同样当卡片没取到,不抛", async () => {
		const h = makeFlow();
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: {} });
		await expect(h.flow.reportAccountInfo()).resolves.toBeUndefined();
		expect(rawOf(h.flow).status).toBe("logged-in");
		expect(h.flow.account()).toBeNull();
		expect(h.api.fetchUserCard).not.toHaveBeenCalled();
	});

	it("有名字没头像地址:有账号、没头像,不抓头像", async () => {
		const fetchAvatar = vi.fn(async () => "ref");
		const h = makeFlow({ fetchAvatar });
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { name: "n" } } });
		await h.flow.reportAccountInfo();
		await Promise.all(h.scFake.tracked);
		expect(h.flow.account()).toEqual({ name: "n" });
		expect(fetchAvatar).not.toHaveBeenCalled();
	});

	it("订阅方的回调抛了:不影响状态机(auth-restored 照发、心跳照挂),记 error", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		h.flow.onChange(() => {
			throw new Error("listener boom");
		});
		h.flow.reportLoggedOut("notLogin");
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { name: "n", face: "" } } });

		await expect(h.flow.reportAccountInfo()).resolves.toBeUndefined();

		expect(rawOf(h.flow).status).toBe("logged-in");
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(1);
		expect(liveHeartbeat(h)).toBeDefined();
		expect(h.scFake.logger.error).toHaveBeenCalledWith(expect.stringContaining("listener boom"));
	});

	it("算对外的变化本身抛了(防御):接住记 error,状态机照走", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		h.flow.reportLoggedOut("notLogin");
		vi.spyOn(h.flow, "account").mockImplementation(() => {
			throw new Error("account boom");
		});
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { name: "n", face: "" } } });

		await expect(h.flow.reportAccountInfo()).resolves.toBeUndefined();

		expect(rawOf(h.flow).status).toBe("logged-in");
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(1);
		expect(liveHeartbeat(h)).toBeDefined();
		expect(h.scFake.logger.error).toHaveBeenCalledWith(expect.stringContaining("account boom"));
	});
});

/** S3:已登录而账号缺着时,心跳成功顺手补取一次卡片(每次心跳至多一次,取不到不影响登录状态)。 */
describe("LoginFlow — 心跳补取账号(S3)", () => {
	const HEALTH_MS = 60_000;

	it("账号缺着:每次心跳成功补取一次;取到了之后就不再取", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		h.api.fetchMyselfInfo.mockResolvedValue({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: -352, data: null }); // 登录那次取不到
		await h.flow.reportAccountInfo();
		expect(h.flow.account()).toBeNull();
		const beat = () =>
			h.scFake.intervals.filter((i) => i.ms === HEALTH_MS && !i.handle.disposed).at(-1);

		h.api.fetchUserCard.mockResolvedValueOnce({ code: -352, data: null }); // 心跳补取也失败:只试一次
		await beat()?.handle.fire();
		await flush();
		expect(h.api.fetchUserCard).toHaveBeenCalledTimes(2);
		expect(h.flow.account()).toBeNull();
		expect(rawOf(h.flow).status).toBe("logged-in");

		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { name: "n", face: "" } } });
		await beat()?.handle.fire();
		await flush();
		expect(h.flow.account()).toEqual({ name: "n" });

		await beat()?.handle.fire();
		await flush();
		expect(h.api.fetchUserCard).toHaveBeenCalledTimes(3); // 有账号了,不再取
	});

	it("补取的途中登出:结果丢掉", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		h.api.fetchMyselfInfo.mockResolvedValue({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: -352, data: null });
		await h.flow.reportAccountInfo();
		const slow = deferred<unknown>();
		h.api.fetchUserCard.mockReturnValueOnce(slow.promise);
		const beating = h.scFake.intervals
			.filter((i) => i.ms === HEALTH_MS && !i.handle.disposed)
			.at(-1)
			?.handle.fire();
		await flush();

		h.flow.reportLoggedOut("notLogin");
		slow.resolve({ code: 0, data: { card: { name: "n", face: "" } } });
		// 心跳定时器的回调是 `() => void this.runHealthCheck()`,`fire()` 的返回等不到补取的续延 ——
		// 不多等几轮的话断言在续延之前就跑了(3a-29 复审 A3 的假绿)。
		await beating;
		await flush();

		expect(rawOf(h.flow).status).toBe("logged-out");
		expect(h.flow.account()).toBeNull();
	});

	// 代数比对单独钉:登出后又登回来(状态又是已登录、账号缺着),旧会话在途的补取结果不得落到新一段登录上。
	// 这一条里「状态是不是已登录」那道防线挡不住,只有 `supersededSince(gen)` 能挡。
	it("补取的途中登出又登回:旧会话的结果丢掉,账号仍缺着", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		h.api.fetchMyselfInfo.mockResolvedValue({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: -352, data: null });
		await h.flow.reportAccountInfo();
		const slow = deferred<unknown>();
		h.api.fetchUserCard.mockReturnValueOnce(slow.promise);
		const beating = h.scFake.intervals
			.filter((i) => i.ms === HEALTH_MS && !i.handle.disposed)
			.at(-1)
			?.handle.fire();
		await flush();

		h.flow.reportLoggedOut("notLogin");
		h.api.fetchUserCard.mockResolvedValueOnce({ code: -352, data: null });
		await h.flow.reportAccountInfo(); // 登回来了,账号还缺着
		expect(rawOf(h.flow).status).toBe("logged-in");
		slow.resolve({ code: 0, data: { card: { name: "n", face: "" } } });
		await beating;
		await flush();

		expect(rawOf(h.flow).status).toBe("logged-in");
		expect(h.flow.account()).toBeNull();
	});

	// 3a-29 复审 A1:补取卡片的途中主人发起了重扫,回来的结果不得把等待扫码的二维码盖成已登录。
	it("补取的途中主人发起重扫:结果丢掉,状态停在等待扫码、二维码还在", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		h.api.fetchMyselfInfo.mockResolvedValue({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: -352, data: null });
		await h.flow.reportAccountInfo();
		const slow = deferred<unknown>();
		h.api.fetchUserCard.mockReturnValueOnce(slow.promise);
		const beating = h.scFake.intervals
			.filter((i) => i.ms === HEALTH_MS && !i.handle.disposed)
			.at(-1)
			?.handle.fire();
		await flush();

		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr/x", qrcode_key: "x" },
		});
		await h.flow.beginLogin(async () => "data:x");
		expect(h.flow.authState()).toMatchObject({ status: "awaiting-scan" });
		slow.resolve({ code: 0, data: { card: { name: "n", face: "" } } });
		await beating;
		await flush();

		expect(h.flow.authState()).toMatchObject({
			status: "awaiting-scan",
			qr: { dataUrl: "data:x" },
		});
		expect(h.flow.account()).toBeNull();
	});

	// 同款窗口在探活那一步:探活在途时主人发起重扫,回来的 code 0 不得盖掉二维码。
	it("探活的途中主人发起重扫:回来的成功丢掉,不补取、状态停在等待扫码", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { name: "n", face: "" } } });
		await h.flow.reportAccountInfo();
		const probe = deferred<unknown>();
		h.api.fetchMyselfInfo.mockReturnValueOnce(probe.promise);
		const beating = h.scFake.intervals
			.filter((i) => i.ms === HEALTH_MS && !i.handle.disposed)
			.at(-1)
			?.handle.fire();
		await flush();

		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr/x", qrcode_key: "x" },
		});
		await h.flow.beginLogin(async () => "data:x");
		probe.resolve({ code: 0, data: { mid: 42 } });
		await beating;
		await flush();

		expect(h.flow.authState()).toMatchObject({
			status: "awaiting-scan",
			qr: { dataUrl: "data:x" },
		});
		expect(h.api.fetchUserCard).toHaveBeenCalledTimes(1);
	});
});

/**
 * S1:每次扫码有自己的会话记号。旧码在途的回应迟到时不得盖掉新码(或登出 / 失效 / 超时之后的结果);
 * 唯一的例外是旧码回「确认成功」且其间没登出过 —— 登录已经成立,新发起的那次作废。
 */
describe("LoginFlow — 扫码会话互不覆盖(S1)", () => {
	async function begin(h: Harness, tag: string): Promise<Result> {
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: `https://qr/${tag}`, qrcode_key: tag },
		});
		return h.flow.beginLogin(async () => `data:${tag}`);
	}

	/** 让当前最新那条轮询打一拍,但回应还没到。回「回应」的 deferred 与那一拍。 */
	function tickInFlight(h: Harness, which = 0) {
		const slow = deferred<unknown>();
		h.api.fetchLoginStatus.mockReturnValueOnce(slow.promise);
		const tick = h.scFake.intervals[which]?.handle.fire();
		return { slow, tick };
	}

	const NEW_QR = { status: "awaiting-scan", qr: { dataUrl: "data:new" } };

	it.each([
		["已扫未确认(86090)", { data: { code: 86090 } }],
		["还没扫(86101)", { data: { code: 86101 } }],
		["二维码失效(86038)", { data: { code: 86038 } }],
		["别的失败(外层 code 非 0)", { code: -1, data: {} }],
	])("旧码在途,新码已出,旧码迟到回 %s:新码状态不变", async (_name, late) => {
		const h = makeFlow();
		await begin(h, "old");
		const { slow, tick } = tickInFlight(h);
		await begin(h, "new");

		slow.resolve(late);
		await tick;

		expect(h.flow.authState()).toMatchObject(NEW_QR);
		expect(h.api.commitLogin).not.toHaveBeenCalled();
		// 新码的轮询还活着(旧码的被收掉了)。
		expect(h.scFake.intervals[0]?.handle.disposed).toBe(true);
		expect(h.scFake.intervals[1]?.handle.disposed).toBe(false);
	});

	it("旧码在取新码途中确认成功:登录成立优先,新发起的那次作废(回 conflict),状态不被盖成等待扫码", async () => {
		const h = makeFlow();
		await begin(h, "old");
		const { slow, tick } = tickInFlight(h);
		const qrFetch = deferred<unknown>();
		h.api.fetchLoginQrCode.mockReturnValueOnce(qrFetch.promise);
		const beginning = h.flow.beginLogin(async () => "data:new");
		h.api.fetchMyselfInfo.mockResolvedValue({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValue({ code: 0, data: { card: { name: "n", face: "" } } });

		slow.resolve({ code: 0, data: { code: 0, refresh_token: "rt" } });
		await tick;
		expect(h.api.commitLogin).toHaveBeenCalledTimes(1);
		expect(h.flow.authState().status).toBe("logged-in");

		qrFetch.resolve({ code: 0, data: { url: "https://qr/new", qrcode_key: "new" } });
		const r = await beginning;

		expect(r).toMatchObject({ ok: false, code: "conflict" });
		expect(h.flow.authState().status).toBe("logged-in");
		expect(h.scFake.intervals).toHaveLength(1); // 新的那次没建轮询
		expect(h.api.holdLoginSaves).toHaveBeenCalledTimes(1);
	});

	it("两次发起交叠:先发的取码还没回、后发的已经出码,先发的回来时作废(回 conflict),不盖后发的", async () => {
		const h = makeFlow();
		const first = deferred<unknown>();
		h.api.fetchLoginQrCode.mockReturnValueOnce(first.promise);
		const firstBegin = h.flow.beginLogin(async () => "data:first");
		await begin(h, "new");

		first.resolve({ code: 0, data: { url: "https://qr/first", qrcode_key: "first" } });
		const r = await firstBegin;

		expect(r).toMatchObject({ ok: false, code: "conflict" });
		expect(h.flow.authState()).toMatchObject(NEW_QR);
		expect(h.scFake.intervals).toHaveLength(1);
	});

	// 3a-29 复审 A4:取码回来那一次会话比对(渲染之前)只有这条能钉 —— 先发的取码迟到且回非 0 码,
	// 没有这次比对会把后发的新码盖成「出错」。
	it("先发的取码迟到且回非 0 码、后发的已经出码:先发的作废(回 conflict),不把新码盖成出错", async () => {
		const h = makeFlow();
		const first = deferred<unknown>();
		h.api.fetchLoginQrCode.mockReturnValueOnce(first.promise);
		const firstBegin = h.flow.beginLogin(async () => "data:first");
		await begin(h, "new");

		first.resolve({ code: -352, data: null });
		const r = await firstBegin;

		expect(r).toMatchObject({ ok: false, code: "conflict" });
		expect(h.flow.authState()).toMatchObject(NEW_QR);
		expect(h.scFake.intervals).toHaveLength(1);
	});

	// 3a-29 复审记一笔 9:两种作废各说各的。
	it("发起之后退出登录、取码才回来:回 conflict,话说的是退出登录,不说「被新的一次取代」", async () => {
		const h = makeFlow();
		const qr = deferred<unknown>();
		h.api.fetchLoginQrCode.mockReturnValueOnce(qr.promise);
		const beginning = h.flow.beginLogin(async () => "data:x");
		h.flow.reportLoggedOut("notLogin");

		qr.resolve({ code: 0, data: { url: "https://qr/x", qrcode_key: "x" } });
		const r = await beginning;

		expect(r).toMatchObject({
			ok: false,
			code: "conflict",
			message: expect.stringContaining("退出登录"),
		});
		expect((r as { message: string }).message).not.toContain("取代");
		expect(h.flow.authState().status).toBe("logged-out");
	});

	it("被新的一次取代的那句话还是「被新的一次取代」", async () => {
		const h = makeFlow();
		const first = deferred<unknown>();
		h.api.fetchLoginQrCode.mockReturnValueOnce(first.promise);
		const firstBegin = h.flow.beginLogin(async () => "data:first");
		await begin(h, "new");

		first.resolve({ code: 0, data: { url: "https://qr/first", qrcode_key: "first" } });
		const r = await firstBegin;

		expect(r).toMatchObject({
			ok: false,
			code: "conflict",
			message: expect.stringContaining("取代"),
		});
	});

	it("先发的渲染二维码还没完、后发的已经出码:先发的渲染完回来时同样作废", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr/first", qrcode_key: "first" },
		});
		const slowRender = deferred<string>();
		const firstBegin = h.flow.beginLogin(() => slowRender.promise);
		await flush();
		await begin(h, "new");

		slowRender.resolve("data:first");
		const r = await firstBegin;

		expect(r).toMatchObject({ ok: false, code: "conflict" });
		expect(h.flow.authState()).toMatchObject(NEW_QR);
		expect(h.scFake.intervals).toHaveLength(1);
	});

	it("发起时取码抛错而上一次的码还显示着:旧码已作废,不能留着没人轮询的码 —— 进出错", async () => {
		const h = makeFlow();
		await begin(h, "old");
		h.api.fetchLoginQrCode.mockRejectedValueOnce(new Error("net down"));

		const r = await h.flow.beginLogin(async () => "ignored");

		expect(r).toMatchObject({ ok: false, code: "unavailable" });
		expect(h.flow.authState()).toMatchObject({ status: "error" });
		expect(h.scFake.intervals[0]?.handle.disposed).toBe(true);
	});

	// 注意这条钉的是 `reportQrPending` 里「上一帧不是 qr 就不动」那道防线,不是轮询里的会话比对
	// (删掉会话比对它照样绿;会话比对由上面的 86090 / 86038 / 外层非 0 码三条和「发起之后退出登录」钉着)。
	it("超时之后迟到的一拍(reportQrPending 的防线):状态还是「出错」,不被盖成没登录,也不停在 qr", async () => {
		const h = makeFlow();
		await begin(h, "q");
		const { slow, tick } = tickInFlight(h);
		await h.scFake.timeouts.at(-1)?.handle.fire(); // 3 分钟到了
		expect(h.flow.authState()).toMatchObject({ status: "error" });

		slow.resolve({ data: { code: 86101 } });
		await tick;

		expect(h.flow.authState()).toMatchObject({ status: "error" });
		expect(rawOf(h.flow).status).toBe("failed");
	});

	it("超时回调属于旧的一次:新码出来之后旧的超时即使被触发也不动新码", async () => {
		const h = makeFlow();
		await begin(h, "old");
		await begin(h, "new");

		await h.scFake.timeouts[0]?.handle.fire(); // 旧的超时回调(假定时器里还能手动触发)

		expect(h.flow.authState()).toMatchObject(NEW_QR);
	});

	// 同上:迟到的是 86090(已扫),挡住它的是 `reportQrPending` 的防线;「登出结束扫码会话」本身钉在定时器都收了这几句上。
	it("扫码进行中被判登录失效(reportQrPending 的防线):「登录已失效」不被迟到的一拍盖掉,扫码定时器都收了", async () => {
		const h = makeFlow();
		await begin(h, "q");
		const { slow, tick } = tickInFlight(h);

		h.flow.reportLoggedOut("authLost");
		expect(h.flow.authState().status).toBe("expired");
		expect(h.scFake.intervals[0]?.handle.disposed).toBe(true);
		expect(h.scFake.timeouts[0]?.handle.disposed).toBe(true);

		slow.resolve({ data: { code: 86090 } });
		await tick;

		expect(h.flow.authState().status).toBe("expired");
	});

	it("发起之后退出登录:在途的旧码回「确认成功」也丢掉(登出之后不能把人登回去)", async () => {
		const h = makeFlow();
		await begin(h, "q");
		const { slow, tick } = tickInFlight(h);

		h.flow.reportLoggedOut("notLogin");
		slow.resolve({ data: { code: 0, refresh_token: "rt" } });
		await tick;

		expect(h.api.commitLogin).not.toHaveBeenCalled();
		expect(h.flow.authState().status).toBe("logged-out");
	});

	it("没有交叠时一切照旧:同一次扫码里 未扫 → 已扫 → 确认成功", async () => {
		const h = makeFlow();
		h.api.fetchMyselfInfo.mockResolvedValue({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValue({ code: 0, data: { card: { name: "n", face: "" } } });
		await begin(h, "q");

		h.api.fetchLoginStatus.mockResolvedValueOnce({ data: { code: 86101 } });
		await h.scFake.intervals[0]?.handle.fire();
		expect(h.flow.authState().status).toBe("awaiting-scan");
		h.api.fetchLoginStatus.mockResolvedValueOnce({ data: { code: 86090 } });
		await h.scFake.intervals[0]?.handle.fire();
		expect(h.flow.authState().status).toBe("confirming");
		h.api.fetchLoginStatus.mockResolvedValueOnce({ data: { code: 0, refresh_token: "rt" } });
		await h.scFake.intervals[0]?.handle.fire();

		expect(h.flow.authState().status).toBe("logged-in");
		expect(h.api.commitLogin).toHaveBeenCalledTimes(1);
	});
});

describe("LoginFlow — 扫码成功后取账号的途中又发起重扫", () => {
	it("取卡片在途时主人又发起一次:状态停在等待扫码、二维码还在、账号没写进去", async () => {
		const h = makeFlow();
		const begin = (tag: string) => {
			h.api.fetchLoginQrCode.mockResolvedValueOnce({
				code: 0,
				data: { url: `https://qr/${tag}`, qrcode_key: tag },
			});
			return h.flow.beginLogin(async () => `data:${tag}`);
		};
		await begin("old");
		h.api.fetchLoginStatus.mockResolvedValueOnce({ data: { code: 0, refresh_token: "rt" } });
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		const card = deferred<unknown>();
		h.api.fetchUserCard.mockReturnValueOnce(card.promise);
		const tick = h.scFake.intervals[0]?.handle.fire();
		await flush();
		expect(rawOf(h.flow).status).toBe("logged-in"); // 卡片还在途

		await begin("new");
		expect(h.flow.authState()).toMatchObject({ status: "awaiting-scan" });
		card.resolve({ code: 0, data: { card: { name: "n", face: "" } } });
		await tick;
		await flush();

		expect(h.flow.authState()).toMatchObject({
			status: "awaiting-scan",
			qr: { dataUrl: "data:new" },
		});
		expect(h.flow.account()).toBeNull();
	});
});

/** 3a-29 复审 A2:「确认成功」落盘的那一段里进来的发起,不得把已成立的登录盖成等待扫码。 */
describe("LoginFlow — 确认成功正在落盘时又发起一次(A2)", () => {
	async function begin(h: Harness, tag: string): Promise<Result> {
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: `https://qr/${tag}`, qrcode_key: tag },
		});
		return h.flow.beginLogin(async () => `data:${tag}`);
	}

	it("落盘途中发起:回 conflict、不取新码;落盘完成后是已登录,没建新的轮询", async () => {
		const h = makeFlow();
		h.api.fetchMyselfInfo.mockResolvedValue({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValue({ code: 0, data: { card: { name: "n", face: "" } } });
		await begin(h, "old");
		const commit = deferred<Result>();
		h.api.commitLogin.mockReturnValueOnce(commit.promise);
		h.api.fetchLoginStatus.mockResolvedValueOnce({ data: { code: 0, refresh_token: "rt" } });
		const tick = h.scFake.intervals[0]?.handle.fire();
		await flush();
		expect(h.api.commitLogin).toHaveBeenCalledTimes(1);

		const r = await begin(h, "new"); // 落盘还没回

		expect(r).toMatchObject({ ok: false, code: "conflict" });
		expect(h.api.fetchLoginQrCode).toHaveBeenCalledTimes(1); // 新码没去取
		commit.resolve(ok());
		await tick;
		await Promise.all(h.scFake.tracked);

		expect(h.flow.authState().status).toBe("logged-in");
		expect(h.scFake.intervals).toHaveLength(1);
	});

	it("落盘抛错:放开,之后能正常再发起", async () => {
		const h = makeFlow();
		await begin(h, "old");
		h.api.commitLogin.mockRejectedValueOnce(new Error("disk full"));
		h.api.fetchLoginStatus.mockResolvedValueOnce({ data: { code: 0, refresh_token: "rt" } });
		await h.scFake.intervals[0]?.handle.fire();
		await Promise.all(h.scFake.tracked);

		const r = await begin(h, "again");

		expect(r).toEqual(ok());
		expect(h.flow.authState()).toMatchObject({
			status: "awaiting-scan",
			qr: { dataUrl: "data:again" },
		});
	});

	it("没拿到任何 cookie 放弃保存:放开,之后能正常再发起", async () => {
		const h = makeFlow();
		await begin(h, "old");
		h.api.getCookiesJson.mockReturnValueOnce("[]");
		h.api.fetchLoginStatus.mockResolvedValueOnce({ data: { code: 0, refresh_token: "rt" } });
		await h.scFake.intervals[0]?.handle.fire();
		await Promise.all(h.scFake.tracked);
		expect(h.flow.authState().status).toBe("error");

		const r = await begin(h, "again");

		expect(r).toEqual(ok());
		expect(h.flow.authState()).toMatchObject({
			status: "awaiting-scan",
			qr: { dataUrl: "data:again" },
		});
	});
});

/** 3a-29 复审记一笔 1 / 2:边事件在前、通知在后;边事件的监听者抛错不吞掉通知。 */
describe("LoginFlow — 边事件与通知的先后、监听者抛错", () => {
	function makeFlowWith(bus: MessageBus): Harness {
		const api = makeFakeApi();
		const scFake = makeFakeServiceCtx();
		const flow = new LoginFlow({
			serviceCtx: scFake.sc,
			api: api as unknown as Api,
			bus,
			healthCheckMs: 0,
		});
		return { flow, api, bus, events: [], scFake };
	}

	function orderedBus(order: string[], throwOn?: string): MessageBus {
		return {
			emit(event, _payload?: unknown) {
				order.push(`emit:${String(event)}`);
				if (event === throwOn) throw new Error("listener boom");
			},
			on() {
				return { dispose: vi.fn() };
			},
		};
	}

	async function loggedInWithAccount(h: Harness) {
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { name: "n", face: "" } } });
		await h.flow.reportAccountInfo();
	}

	it("先发边事件、后通知订阅方:登出(auth-lost)与登回(auth-restored)都是", async () => {
		const order: string[] = [];
		const h = makeFlowWith(orderedBus(order));
		await loggedInWithAccount(h);
		h.flow.onChange(() => order.push("notify"));
		order.length = 0;

		h.flow.reportLoggedOut("authLost");
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: -352, data: null });
		await h.flow.reportAccountInfo();

		expect(order).toEqual(["emit:auth-lost", "notify", "emit:auth-restored", "notify"]);
	});

	it("auth-lost 的监听者抛错:抛错照旧往外传,订阅方照样收到状态变化", async () => {
		const order: string[] = [];
		const h = makeFlowWith(orderedBus(order, "auth-lost"));
		await loggedInWithAccount(h);
		h.flow.onChange(() => order.push("notify"));
		order.length = 0;

		expect(() => h.flow.reportLoggedOut("authLost")).toThrow("listener boom");

		expect(order).toEqual(["emit:auth-lost", "notify"]);
		expect(h.flow.authState().status).toBe("expired");
	});

	it("auth-restored 的监听者抛错:抛错照旧往外传,订阅方照样收到状态变化", async () => {
		const order: string[] = [];
		const h = makeFlowWith(orderedBus(order, "auth-restored"));
		await loggedInWithAccount(h);
		h.flow.reportLoggedOut("authLost");
		h.flow.onChange(() => order.push("notify"));
		order.length = 0;
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: -352, data: null });

		await expect(h.flow.reportAccountInfo()).rejects.toThrow("listener boom");

		expect(order).toEqual(["emit:auth-restored", "notify"]);
		expect(h.flow.authState().status).toBe("logged-in");
	});
});

/**
 * 3a-30 复审 A1 / A2:登录检查(心跳、补取、开机确认)与扫码的交叠。
 *
 * 前三条钉的是**不许变**的现状(记号只在新登录成立时往前走,发起重扫不走);其余是这次修的:
 * 检查发出去之后一段新登录成立了,它回来的结果(成功、`-101`、抛错、取到的账号)问的都是上一段,整份丢掉。
 */
describe("LoginFlow — 检查在途时扫码(3a-30 复审 A1 / A2)", () => {
	const HEALTH_MS = 60_000;
	const POLL_MS = 1000;
	const CARD = (name: string) => ({ code: 0, data: { card: { name, face: "" } } });

	const liveBeats = (h: Harness) =>
		h.scFake.intervals.filter((i) => i.ms === HEALTH_MS && !i.handle.disposed);
	const livePolls = (h: Harness) =>
		h.scFake.intervals.filter((i) => i.ms === POLL_MS && !i.handle.disposed);

	async function begin(h: Harness, tag: string): Promise<Result> {
		h.api.fetchLoginQrCode.mockResolvedValueOnce({
			code: 0,
			data: { url: `https://qr/${tag}`, qrcode_key: tag },
		});
		return h.flow.beginLogin(async () => `data:${tag}`);
	}

	/** 摆成已登录、带账号、心跳挂着。 */
	async function loggedIn(h: Harness, name = "old"): Promise<void> {
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 1 } });
		h.api.fetchUserCard.mockResolvedValueOnce(CARD(name));
		await h.flow.reportAccountInfo();
		expect(rawOf(h.flow).status).toBe("logged-in");
		expect(liveBeats(h)).toHaveLength(1);
	}

	/** 让挂着的心跳打一拍,探活停在途中。 */
	async function beatInFlight(h: Harness) {
		const probe = deferred<unknown>();
		h.api.fetchMyselfInfo.mockReturnValueOnce(probe.promise);
		const beating = liveBeats(h).at(-1)?.handle.fire();
		await flush();
		return { probe, beating };
	}

	/**
	 * 当前这张码回「确认成功」并落盘、进已登录;扫码成功后那次取账号的探活停在途中。
	 * 回那次探活的 deferred 与轮询那一拍。
	 */
	async function confirmScan(h: Harness) {
		const newProbe = deferred<unknown>();
		h.api.fetchLoginStatus.mockResolvedValueOnce({ data: { code: 0, refresh_token: "rt" } });
		h.api.fetchMyselfInfo.mockReturnValueOnce(newProbe.promise);
		const tick = livePolls(h).at(-1)?.handle.fire();
		await flush();
		expect(rawOf(h.flow)).toMatchObject({ status: "logged-in", reason: "loginJustSucceeded" });
		return { newProbe, tick };
	}

	// ---- 钉现状(动实现之前就是绿的) ----

	// 验红:把 `runHealthCheck` 里「回 0 且在扫码就丢掉」的条件去掉 `res.code === 0`(扫码中一律丢),这条红。
	it("心跳在途 → 发起重扫(没扫成)→ 回 -101:照旧失效、这次扫码被结束、不发 auth-lost", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		await loggedIn(h);
		const { probe, beating } = await beatInFlight(h);
		await begin(h, "new");
		expect(livePolls(h)).toHaveLength(1);

		probe.resolve({ code: -101 });
		await beating;
		await flush();

		expect(h.flow.authState().status).toBe("expired");
		expect(livePolls(h)).toHaveLength(0);
		expect(liveBeats(h)).toHaveLength(0);
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(0);
	});

	// 验红:把 `runHealthCheck` 里那一支的条件从 `status === "qr"` 放宽到也含 `failed`,这条红。
	it("心跳在途 → 发起重扫 → 重扫超时停在出错 → 回 0:回到已登录(旧会话其实还在)", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		await loggedIn(h);
		const { probe, beating } = await beatInFlight(h);
		await begin(h, "new");
		await h.scFake.timeouts.at(-1)?.handle.fire(); // 3 分钟到了
		expect(h.flow.authState().status).toBe("error");

		probe.resolve({ code: 0, data: { mid: 1 } });
		await beating;
		await flush();

		expect(h.flow.authState().status).toBe("logged-in");
		expect(liveBeats(h)).toHaveLength(1);
	});

	// 验红:把 `reportLoggedIn` 里发 `auth-restored` 的条件改成「上一帧不是 checking」(已登录时再进已登录也发),这条红。
	it("心跳在途 → 再来一次心跳:两份都落地,状态、登录时刻、心跳、边事件都不变", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		await loggedIn(h);
		const before = rawOf(h.flow);
		const first = await beatInFlight(h);
		const second = await beatInFlight(h);

		second.probe.resolve({ code: 0, data: { mid: 1 } });
		first.probe.resolve({ code: 0, data: { mid: 1 } });
		await first.beating;
		await second.beating;
		await flush();

		expect(rawOf(h.flow)).toMatchObject({
			status: "logged-in",
			loggedInAt: (before as { loggedInAt: string }).loggedInAt,
		});
		expect(h.flow.account()).toEqual({ name: "old" });
		expect(liveBeats(h)).toHaveLength(1);
		expect(h.events).toHaveLength(0);
	});

	// ---- A1:检查在途时一段新登录成立了 ----

	// 复审探针 L1。
	it("心跳在途 → 重扫并扫码成功 → 旧心跳回 -101:新登录不被判失效,新会话的探活照常落地、心跳挂着", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		await loggedIn(h);
		const { probe, beating } = await beatInFlight(h);
		await begin(h, "new");
		const { newProbe, tick } = await confirmScan(h);

		probe.resolve({ code: -101 });
		await beating;
		await flush();

		expect(h.flow.authState().status).toBe("logged-in");
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(0);

		h.api.fetchUserCard.mockResolvedValueOnce(CARD("new"));
		newProbe.resolve({ code: 0, data: { mid: 2 } });
		await tick;
		await Promise.all(h.scFake.tracked);

		expect(h.flow.authState().status).toBe("logged-in");
		expect(h.flow.account()).toEqual({ name: "new" });
		expect(liveBeats(h)).toHaveLength(1);
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(0);
	});

	it("心跳在途 → 重扫并扫码成功 → 旧心跳回 0:同样丢掉,不拿旧会话的用户 id 去补取账号", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		await loggedIn(h);
		const { probe, beating } = await beatInFlight(h);
		await begin(h, "new");
		const { newProbe, tick } = await confirmScan(h);
		expect(h.flow.account()).toBeNull(); // 新登录的账号还没取到
		h.api.fetchUserCard.mockResolvedValue(CARD("stale"));

		probe.resolve({ code: 0, data: { mid: 1 } });
		await beating;
		await flush();

		expect(h.api.fetchUserCard).toHaveBeenCalledTimes(1); // 只有摆成已登录那一次
		expect(h.flow.account()).toBeNull();
		expect(rawOf(h.flow)).toMatchObject({ status: "logged-in", reason: "loginJustSucceeded" });

		h.api.fetchUserCard.mockReset();
		h.api.fetchUserCard.mockResolvedValueOnce(CARD("new"));
		newProbe.resolve({ code: 0, data: { mid: 2 } });
		await tick;
		await Promise.all(h.scFake.tracked);
		expect(h.flow.account()).toEqual({ name: "new" });
	});

	it("心跳补取账号在途 → 重扫并扫码成功 → 旧的卡片才回来:不把上一段登录的账号写到新登录上", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 1 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: -352, data: null }); // 账号缺着
		await h.flow.reportAccountInfo();
		const staleCard = deferred<unknown>();
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 1 } });
		h.api.fetchUserCard.mockReturnValueOnce(staleCard.promise);
		const beating = liveBeats(h).at(-1)?.handle.fire();
		await flush();
		expect(h.api.fetchUserCard).toHaveBeenCalledTimes(2); // 补取已发出

		await begin(h, "new");
		const { newProbe, tick } = await confirmScan(h);
		staleCard.resolve(CARD("stale"));
		await beating;
		await flush();

		expect(h.flow.account()).toBeNull();

		h.api.fetchUserCard.mockResolvedValueOnce(CARD("new"));
		newProbe.resolve({ code: 0, data: { mid: 2 } });
		await tick;
		await Promise.all(h.scFake.tracked);
		expect(h.flow.account()).toEqual({ name: "new" });
	});

	it("开机确认在途 → 扫码成功 → 开机那次探活回 -101:新登录不被判失效", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		const bootProbe = deferred<unknown>();
		h.api.fetchMyselfInfo.mockReturnValueOnce(bootProbe.promise);
		const booting = h.flow.reportAccountInfo();
		await flush();
		await begin(h, "new");
		const { newProbe, tick } = await confirmScan(h);

		bootProbe.resolve({ code: -101 });
		await booting;

		expect(h.flow.authState().status).toBe("logged-in");
		expect(liveBeats(h)).toHaveLength(0); // 被取代的那次不挂心跳,等新登录自己那次

		h.api.fetchUserCard.mockResolvedValueOnce(CARD("new"));
		newProbe.resolve({ code: 0, data: { mid: 2 } });
		await tick;
		await Promise.all(h.scFake.tracked);
		expect(h.flow.authState().status).toBe("logged-in");
		expect(liveBeats(h)).toHaveLength(1);
	});

	it("开机确认在途 → 扫码成功 → 开机那次探活抛错:不把新登录标成「取账号失败」、不替它挂心跳", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		const bootProbe = deferred<unknown>();
		h.api.fetchMyselfInfo.mockReturnValueOnce(bootProbe.promise);
		const booting = h.flow.reportAccountInfo();
		await flush();
		await begin(h, "new");
		const { newProbe, tick } = await confirmScan(h);

		bootProbe.reject(new Error("net down"));
		await booting;

		expect(rawOf(h.flow)).toMatchObject({ status: "logged-in", reason: "loginJustSucceeded" });
		expect(liveBeats(h)).toHaveLength(0);

		h.api.fetchUserCard.mockResolvedValueOnce(CARD("new"));
		newProbe.resolve({ code: 0, data: { mid: 2 } });
		await tick;
		await Promise.all(h.scFake.tracked);
		expect(liveBeats(h)).toHaveLength(1);
	});

	it("开机确认取卡片在途 → 扫码成功 → 旧卡片才回来:不把上一段登录的账号写到新登录上", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 1 } });
		const staleCard = deferred<unknown>();
		h.api.fetchUserCard.mockReturnValueOnce(staleCard.promise);
		const booting = h.flow.reportAccountInfo();
		await flush();
		await begin(h, "new");
		const { newProbe, tick } = await confirmScan(h);

		staleCard.resolve(CARD("stale"));
		await booting;

		expect(h.flow.account()).toBeNull();
		expect(rawOf(h.flow)).toMatchObject({ status: "logged-in", reason: "loginJustSucceeded" });

		h.api.fetchUserCard.mockResolvedValueOnce(CARD("new"));
		newProbe.resolve({ code: 0, data: { mid: 2 } });
		await tick;
		await Promise.all(h.scFake.tracked);
		expect(h.flow.account()).toEqual({ name: "new" });
	});

	it("落盘失败照样算一段新登录:旧心跳迟到的 -101 同样丢掉", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		await loggedIn(h);
		const { probe, beating } = await beatInFlight(h);
		await begin(h, "new");
		h.api.commitLogin.mockResolvedValueOnce(fail("unavailable", "disk full"));
		const { newProbe, tick } = await confirmScan(h);

		probe.resolve({ code: -101 });
		await beating;
		await flush();

		expect(h.flow.authState().status).toBe("logged-in");
		h.api.fetchUserCard.mockResolvedValueOnce(CARD("new"));
		newProbe.resolve({ code: 0, data: { mid: 2 } });
		await tick;
		await Promise.all(h.scFake.tracked);
		expect(h.flow.authState().status).toBe("logged-in");
	});

	// ---- A2:丢弃「取账号的成功」时心跳要挂着 ----

	// 复审探针 L2。
	it("没登录 → 扫码成功 → 取账号在途 → 又发起一次:那份成功丢掉但心跳挂上;新码超时后心跳把状态带回已登录", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		h.flow.reportLoggedOut("notLogin");
		expect(liveBeats(h)).toHaveLength(0);
		await begin(h, "old");
		h.api.fetchLoginStatus.mockResolvedValueOnce({ data: { code: 0, refresh_token: "rt" } });
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 2 } });
		const card = deferred<unknown>();
		h.api.fetchUserCard.mockReturnValueOnce(card.promise);
		const tick = livePolls(h).at(-1)?.handle.fire();
		await flush();
		expect(rawOf(h.flow).status).toBe("logged-in"); // 卡片还在途

		await begin(h, "new");
		card.resolve(CARD("new"));
		await tick;
		await Promise.all(h.scFake.tracked);

		expect(h.flow.authState()).toMatchObject({
			status: "awaiting-scan",
			qr: { dataUrl: "data:new" },
		});
		expect(liveBeats(h)).toHaveLength(1);

		await h.scFake.timeouts.at(-1)?.handle.fire(); // 新码 3 分钟到了
		expect(h.flow.authState().status).toBe("error");
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 2 } });
		h.api.fetchUserCard.mockResolvedValueOnce(CARD("new"));
		await liveBeats(h).at(-1)?.handle.fire();
		await flush();

		expect(h.flow.authState().status).toBe("logged-in");
		expect(h.flow.account()).toEqual({ name: "new" });
	});

	it("开机确认取卡片在途 → 发起扫码:那份成功丢掉但心跳挂上", async () => {
		const h = makeFlow({ healthCheckMs: HEALTH_MS });
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 1 } });
		const card = deferred<unknown>();
		h.api.fetchUserCard.mockReturnValueOnce(card.promise);
		const booting = h.flow.reportAccountInfo();
		await flush();

		await begin(h, "new");
		card.resolve(CARD("old"));
		await booting;

		expect(h.flow.authState()).toMatchObject({ status: "awaiting-scan" });
		expect(liveBeats(h)).toHaveLength(1);
	});
});
