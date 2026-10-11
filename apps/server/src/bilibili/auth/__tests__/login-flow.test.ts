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
import { BiliLoginStatus } from "../../api/types";
import { LoginFlow } from "../login-flow";

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

function makeFlow(opts: { healthCheckMs?: number } = {}): Harness {
	const api = makeFakeApi();
	const { bus, events } = makeFakeBus();
	const scFake = makeFakeServiceCtx();
	const flow = new LoginFlow({
		serviceCtx: scFake.sc,
		api: api as unknown as Api,
		bus,
		healthCheckMs: opts.healthCheckMs ?? 0,
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

	it("code === 0 transitions to LOGGED_IN and emits login-status-report once", async () => {
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({
			code: 0,
			data: { card: { mid: "42", name: "n" } },
		});

		await h.flow.reportAccountInfo();

		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGED_IN);
		const reports = eventsOfKind(h.events, "login-status-report");
		expect(reports).toHaveLength(1);
		expect(reports[0]?.payload).toMatchObject({ status: BiliLoginStatus.LOGGED_IN });
	});

	it("code === -101 transitions to NOT_LOGIN and emits auth-lost only when previously LOGGED_IN", async () => {
		// First, get into LOGGED_IN
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.fetchUserCard.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();
		const baselineEvents = h.events.length;

		// Then expire
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: -101, data: { mid: 0 } });
		await h.flow.reportAccountInfo();

		expect(h.flow.current().status).toBe(BiliLoginStatus.NOT_LOGIN);
		const newEvents = h.events.slice(baselineEvents);
		expect(eventsOfKind(newEvents, "login-status-report")).toHaveLength(1);
		expect(eventsOfKind(newEvents, "auth-lost")).toHaveLength(1);
	});

	it("code === -101 from cold start does NOT emit auth-lost (was never LOGGED_IN)", async () => {
		h.api.fetchMyselfInfo.mockResolvedValueOnce({ code: -101, data: { mid: 0 } });
		await h.flow.reportAccountInfo();

		expect(h.flow.current().status).toBe(BiliLoginStatus.NOT_LOGIN);
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
	it("emitting the same snapshot twice fires login-status-report only once", async () => {
		const h = makeFlow();
		// Cold start → NOT_LOGIN via reportLoggedOut, twice.
		h.flow.reportLoggedOut("notLogin");
		h.flow.reportLoggedOut("notLogin");

		const reports = eventsOfKind(h.events, "login-status-report");
		expect(reports).toHaveLength(1);
		expect(reports[0]?.payload).toMatchObject({ status: BiliLoginStatus.NOT_LOGIN });
	});
});

describe("LoginFlow.beginLogin()", () => {
	it("fetchLoginQrCode failure: no transition, no QR poll started", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockRejectedValueOnce(new Error("net down"));

		await h.flow.beginLogin(async () => "ignored");

		expect(eventsOfKind(h.events, "login-status-report")).toHaveLength(0);
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

		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGIN_FAILED);
		expect(h.scFake.intervals).toHaveLength(0);
		expect(h.scFake.timeouts).toHaveLength(0);
	});

	it("fetchLoginQrCode returns non-zero code: reports QR failure and does not start poll", async () => {
		const h = makeFlow();
		h.api.fetchLoginQrCode.mockResolvedValueOnce({ code: -1, data: null });

		await h.flow.beginLogin(async () => "ignored");

		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGIN_FAILED);
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
		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGED_IN);
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
		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGIN_FAILED);
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

		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGING_QR);
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
		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGIN_QR);
		expect(h.flow.current().data).toBe("data:image/png;base64,QR_BASE64_PAYLOAD");

		await h.scFake.intervals[0]?.handle.fire();

		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGING_QR);
		// The QR is still useful (user hasn't confirmed on phone yet) — must not be dropped.
		expect(h.flow.current().data).toBe("data:image/png;base64,QR_BASE64_PAYLOAD");
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
		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGED_IN);
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
		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGED_IN);
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
		expect(h.flow.current().status).toBe(BiliLoginStatus.NOT_LOGIN);

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
		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGED_IN);

		// 心跳发出探活请求,此刻会话还活着,B 站也还认。
		const probe = deferred<{ code: number; data: { mid: number } }>();
		h.api.fetchMyselfInfo.mockReturnValueOnce(probe.promise);
		h.scFake.intervals[0]?.handle.fire();
		await flush();

		// 探活在途期间,cookie 刷新链撞上 -101 —— 拦截器同步走到这里。
		await h.flow.handleAuthLost();
		expect(h.flow.current().status).toBe(BiliLoginStatus.NOT_LOGIN);
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(1);

		// 迟到的答复:它问的是那个已经死掉的会话,答案早就不作数了。
		probe.resolve({ code: 0, data: { mid: 42 } });
		await flush();

		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(0);
		expect(h.flow.current().status).toBe(BiliLoginStatus.NOT_LOGIN);
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

		expect(h.flow.current().status).toBe(BiliLoginStatus.NOT_LOGIN);
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

		expect(h.flow.current().status).toBe(BiliLoginStatus.NOT_LOGIN);
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
		const msgAfterLogout = h.flow.current().msg;

		probe.resolve({ code: -101, data: { mid: 0 } });
		await pending;

		// 面板上该显示「请点击扫码登录」,而不是吓人的「登录已失效」。
		expect(h.flow.current().msg).toBe(msgAfterLogout);
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

		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGED_IN);
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
		expect(h.flow.current().status).toBe(BiliLoginStatus.NOT_LOGIN);
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
