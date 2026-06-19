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

	it("auth-restored only fires after a prior LOGGED_IN → NOT_LOGIN cycle (needsRestore)", async () => {
		// Cold start → LOGGED_IN. No auth-restored expected.
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
