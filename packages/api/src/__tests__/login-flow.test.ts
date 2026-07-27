import type { Disposable, Logger, MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BilibiliAPI } from "../bilibili-api";
import { LoginFlow } from "../login-flow";
import { BiliLoginStatus } from "../types";

/**
 * Minimal stub of BilibiliAPI exposing only the methods LoginFlow calls.
 * Each is a vi.fn so individual tests override per-call behaviour.
 */
function makeFakeApi() {
	const fake = {
		getMyselfInfo: vi.fn(),
		getUserCardInfo: vi.fn(),
		getLoginQRCode: vi.fn(),
		getLoginStatus: vi.fn(),
		getCookiesJson: vi.fn(() => '[{"key":"SESSDATA","value":"x"}]'),
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
	};

	return { sc, intervals, timeouts, disposeHooks, logger };
}

interface RecordedEvent {
	event: string;
	args: unknown[];
}

function makeFakeBus(): { bus: MessageBus; events: RecordedEvent[] } {
	const events: RecordedEvent[] = [];
	const bus: MessageBus = {
		emit(event, ...args) {
			events.push({ event: event as string, args: args as unknown[] });
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
	saveCookies: ReturnType<typeof vi.fn>;
}

function makeFlow(opts: { healthCheckMs?: number } = {}): Harness {
	const api = makeFakeApi();
	const { bus, events } = makeFakeBus();
	const scFake = makeFakeServiceCtx();
	const saveCookies = vi.fn(async () => {});
	const flow = new LoginFlow({
		serviceCtx: scFake.sc,
		api: api as unknown as BilibiliAPI,
		bus,
		healthCheckMs: opts.healthCheckMs ?? 0,
		saveCookies,
	});
	return { flow, api, bus, events, scFake, saveCookies };
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
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({
			code: 0,
			data: { card: { mid: "42", name: "n" } },
		});

		await h.flow.reportAccountInfo();

		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGED_IN);
		const reports = eventsOfKind(h.events, "login-status-report");
		expect(reports).toHaveLength(1);
		expect(reports[0].args[0]).toMatchObject({ status: BiliLoginStatus.LOGGED_IN });
	});

	it("code === -101 transitions to NOT_LOGIN and emits auth-lost only when previously LOGGED_IN", async () => {
		// First, get into LOGGED_IN
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();
		const baselineEvents = h.events.length;

		// Then expire
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: -101, data: { mid: 0 } });
		await h.flow.reportAccountInfo();

		expect(h.flow.current().status).toBe(BiliLoginStatus.NOT_LOGIN);
		const newEvents = h.events.slice(baselineEvents);
		expect(eventsOfKind(newEvents, "login-status-report")).toHaveLength(1);
		expect(eventsOfKind(newEvents, "auth-lost")).toHaveLength(1);
	});

	it("code === -101 from cold start does NOT emit auth-lost (was never LOGGED_IN)", async () => {
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: -101, data: { mid: 0 } });
		await h.flow.reportAccountInfo();

		expect(h.flow.current().status).toBe(BiliLoginStatus.NOT_LOGIN);
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(0);
	});

	it("auth-restored fires once per NOT_LOGIN → LOGGED_IN recovery, never on a clean start", async () => {
		// Cold start straight to LOGGED_IN — nothing was ever parked, so no auth-restored.
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(0);

		// Become invalid (LOGGED_IN → NOT_LOGIN sets needsRestore = true)
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: -101, data: { mid: 0 } });
		await h.flow.reportAccountInfo();
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(1);
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(0);

		// Recover → fires auth-restored exactly once.
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(1);

		// And does NOT fire again on subsequent identical successes.
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
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
		expect(reports[0].args[0]).toMatchObject({ status: BiliLoginStatus.NOT_LOGIN });
	});
});

describe("LoginFlow.beginLogin()", () => {
	it("getLoginQRCode failure: no transition, no QR poll started", async () => {
		const h = makeFlow();
		h.api.getLoginQRCode.mockRejectedValueOnce(new Error("net down"));

		await h.flow.beginLogin(async () => "ignored");

		expect(eventsOfKind(h.events, "login-status-report")).toHaveLength(0);
		expect(h.scFake.intervals).toHaveLength(0);
		expect(h.scFake.timeouts).toHaveLength(0);
	});

	it("renderQr failure: emits qrRenderFailed transition and does not start poll", async () => {
		const h = makeFlow();
		h.api.getLoginQRCode.mockResolvedValueOnce({
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

	it("getLoginQRCode returns non-zero code: reports QR failure and does not start poll", async () => {
		const h = makeFlow();
		h.api.getLoginQRCode.mockResolvedValueOnce({ code: -1, data: null });

		await h.flow.beginLogin(async () => "ignored");

		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGIN_FAILED);
		expect(h.scFake.intervals).toHaveLength(0);
	});

	it("poll code === 0: saves cookies, transitions to LOGGED_IN, calls reportAccountInfo", async () => {
		const h = makeFlow();
		h.api.getLoginQRCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		h.api.getLoginStatus.mockResolvedValueOnce({
			code: 0,
			data: { code: 0, refresh_token: "rt-xyz" },
		});
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });

		await h.flow.beginLogin(async (url) => `data:image/png;base64,${url}`);

		// Interval registered. Fire it once.
		expect(h.scFake.intervals).toHaveLength(1);
		await h.scFake.intervals[0].handle.fire();

		expect(h.saveCookies).toHaveBeenCalledTimes(1);
		expect(h.saveCookies).toHaveBeenCalledWith({
			cookiesJson: '[{"key":"SESSDATA","value":"x"}]',
			refreshToken: "rt-xyz",
		});
		expect(h.api.getMyselfInfo).toHaveBeenCalledTimes(1);
		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGED_IN);
		// The interval timer must have been cleared.
		expect(h.scFake.intervals[0].handle.disposed).toBe(true);
	});

	it("poll code === 86038 (qr invalidated): cleans up the poll timer", async () => {
		const h = makeFlow();
		h.api.getLoginQRCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		h.api.getLoginStatus.mockResolvedValueOnce({ code: 0, data: { code: 86038 } });

		await h.flow.beginLogin(async () => "data:url");
		expect(h.scFake.intervals).toHaveLength(1);
		await h.scFake.intervals[0].handle.fire();

		expect(h.scFake.intervals[0].handle.disposed).toBe(true);
		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGIN_FAILED);
	});

	it("poll code === 86101 (waitScan): keeps polling, no save, snapshot in LOGGING_QR", async () => {
		const h = makeFlow();
		h.api.getLoginQRCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		h.api.getLoginStatus.mockResolvedValueOnce({ code: 0, data: { code: 86101 } });

		await h.flow.beginLogin(async () => "data:url");
		await h.scFake.intervals[0].handle.fire();

		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGING_QR);
		expect(h.saveCookies).not.toHaveBeenCalled();
		expect(h.scFake.intervals[0].handle.disposed).toBe(false);
	});

	it("LOGIN_QR → LOGGING_QR (waitScan/waitConfirm) preserves the QR data field", async () => {
		// Regression: prior implementation dropped `data` on the LOGGING_QR
		// transition, so the dashboard's QR card flickered to "二维码加载中"
		// the moment polling reported 86101/86090.
		const h = makeFlow();
		h.api.getLoginQRCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		h.api.getLoginStatus.mockResolvedValueOnce({ code: 0, data: { code: 86101 } });

		await h.flow.beginLogin(async () => "data:image/png;base64,QR_BASE64_PAYLOAD");
		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGIN_QR);
		expect(h.flow.current().data).toBe("data:image/png;base64,QR_BASE64_PAYLOAD");

		await h.scFake.intervals[0].handle.fire();

		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGING_QR);
		// The QR is still useful (user hasn't confirmed on phone yet) — must not be dropped.
		expect(h.flow.current().data).toBe("data:image/png;base64,QR_BASE64_PAYLOAD");
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
		h.api.getLoginQRCode.mockResolvedValueOnce({
			code: 0,
			data: { url: "https://qr", qrcode_key: "k" },
		});
		await h.flow.beginLogin(async () => "data:url");

		expect(h.scFake.intervals).toHaveLength(1);
		expect(h.scFake.timeouts).toHaveLength(1);

		h.flow.stop();
		expect(h.scFake.intervals[0].handle.disposed).toBe(true);
		expect(h.scFake.timeouts[0].handle.disposed).toBe(true);
	});
});

describe("LoginFlow — 冷启动即登录过期,重新登录后必须放行 auth-restored", () => {
	it("启动时 cookie 已失效 → 重新登录后仍发 auth-restored(下游引擎靠它复活)", async () => {
		const h = makeFlow();
		// 冷启动探测:cookie 过期。此时快照还是 LOADING_LOGIN_INFO,不是 LOGGED_IN。
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: -101, data: { mid: 0 } });
		await h.flow.reportAccountInfo();
		expect(h.flow.current().status).toBe(BiliLoginStatus.NOT_LOGIN);

		// 主人扫码重新登录成功。
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
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
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();
		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGED_IN);

		// 心跳发出探活请求,此刻会话还活着,B 站也还认。
		const probe = deferred<{ code: number; data: { mid: number } }>();
		h.api.getMyselfInfo.mockReturnValueOnce(probe.promise);
		h.scFake.intervals[0].handle.fire();
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
		// `getUserCardInfo` 网络往返,那是第二个同样宽的窗口。
		const h = makeFlow();
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();

		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		const card = deferred<{ code: number; data: { card: { mid: string } } }>();
		h.api.getUserCardInfo.mockReturnValueOnce(card.promise);
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
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();

		const probe = deferred<{ code: number; data: { mid: number } }>();
		h.api.getMyselfInfo.mockReturnValueOnce(probe.promise);
		h.scFake.intervals[0].handle.fire();
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
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();
		expect(liveTimers(h)).toHaveLength(1);

		const probe = deferred<{ code: number; data: { mid: number } }>();
		h.api.getMyselfInfo.mockReturnValueOnce(probe.promise);
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
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();

		const probe = deferred<{ code: number; data: { mid: number } }>();
		h.api.getMyselfInfo.mockReturnValueOnce(probe.promise);
		const pending = h.flow.reportAccountInfo();
		await flush();

		await h.flow.handleAuthLost();
		probe.reject(new Error("net down"));
		await pending;

		expect(liveTimers(h)).toHaveLength(0);
	});

	it("主人手动退出后,迟到的 -101 不得把「已退出」改写成「登录已失效」", async () => {
		const h = makeFlow();
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();

		const probe = deferred<{ code: number; data: { mid: number } }>();
		h.api.getMyselfInfo.mockReturnValueOnce(probe.promise);
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
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();

		await h.flow.handleAuthLost();
		expect(eventsOfKind(h.events, "auth-lost")).toHaveLength(1);

		// 登出**先**落定,之后才发起的探活是问新状态的,必须照常放行。
		h.api.getMyselfInfo.mockResolvedValueOnce({ code: 0, data: { mid: 42 } });
		h.api.getUserCardInfo.mockResolvedValueOnce({ code: 0, data: { card: { mid: "42" } } });
		await h.flow.reportAccountInfo();

		expect(h.flow.current().status).toBe(BiliLoginStatus.LOGGED_IN);
		expect(eventsOfKind(h.events, "auth-restored")).toHaveLength(1);
	});
});
