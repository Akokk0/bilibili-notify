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
		commitLogin: vi.fn(async (): Promise<Result> => ok()),
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
		await liveHeartbeat(h)?.handle.fire();
		await flush();

		expect(rawOf(h.flow).status).toBe("logged-in");
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
