import type { Context } from "koishi";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeKoishiServiceContext } from "../service-context";

interface FakeLogger {
	info: ReturnType<typeof vi.fn>;
	warn: ReturnType<typeof vi.fn>;
	error: ReturnType<typeof vi.fn>;
	debug: ReturnType<typeof vi.fn>;
	level: number;
}

function makeFakeKoishiCtx() {
	const koishiLogger: FakeLogger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		level: 2,
	};

	// Map of event name -> listeners (used for "dispose" listeners only here).
	const disposeListeners = new Set<() => void | Promise<void>>();

	const setIntervalRelease = vi.fn(() => true);
	const setTimeoutRelease = vi.fn(() => true);

	const ctx = {
		logger: vi.fn((_name: string) => koishiLogger),
		setInterval: vi.fn((_fn: () => void, _ms: number) => setIntervalRelease),
		setTimeout: vi.fn((_fn: () => void, _ms: number) => setTimeoutRelease),
		on: vi.fn((name: string, fn: () => void) => {
			if (name === "dispose") disposeListeners.add(fn);
			return () => {
				disposeListeners.delete(fn);
				return true;
			};
		}),
		__koishiLogger: koishiLogger,
		__disposeListeners: disposeListeners,
		__setIntervalRelease: setIntervalRelease,
		__setTimeoutRelease: setTimeoutRelease,
	};
	return ctx as unknown as Context & {
		__koishiLogger: FakeLogger;
		__disposeListeners: Set<() => void | Promise<void>>;
		__setIntervalRelease: ReturnType<typeof vi.fn>;
		__setTimeoutRelease: ReturnType<typeof vi.fn>;
	};
}

describe("makeKoishiServiceContext()", () => {
	it("logger.info/warn/error/debug delegate to the koishi logger", () => {
		const ctx = makeFakeKoishiCtx();
		const sc = makeKoishiServiceContext(ctx, "test");

		sc.logger.info("hello", 1);
		sc.logger.warn("hmm");
		sc.logger.error("boom", "x");
		sc.logger.debug("trace");

		expect(ctx.__koishiLogger.info).toHaveBeenCalledWith("hello", 1);
		expect(ctx.__koishiLogger.warn).toHaveBeenCalledWith("hmm");
		expect(ctx.__koishiLogger.error).toHaveBeenCalledWith("boom", "x");
		expect(ctx.__koishiLogger.debug).toHaveBeenCalledWith("trace");
	});

	it("logLevel parameter sets koishiLogger.level when provided", () => {
		const ctx = makeFakeKoishiCtx();
		expect(ctx.__koishiLogger.level).toBe(2);

		makeKoishiServiceContext(ctx, "test", 4);

		expect(ctx.__koishiLogger.level).toBe(4);
	});

	it("logLevel left undefined does not touch koishiLogger.level", () => {
		const ctx = makeFakeKoishiCtx();
		makeKoishiServiceContext(ctx, "test");
		expect(ctx.__koishiLogger.level).toBe(2);
	});

	it("setInterval returns Disposable that calls koishi's release function on dispose", () => {
		const ctx = makeFakeKoishiCtx();
		const sc = makeKoishiServiceContext(ctx, "test");
		const fn = vi.fn();

		const handle = sc.setInterval(fn, 1000);
		expect(ctx.setInterval).toHaveBeenCalledWith(fn, 1000);
		expect(ctx.__setIntervalRelease).not.toHaveBeenCalled();

		handle.dispose();
		expect(ctx.__setIntervalRelease).toHaveBeenCalledTimes(1);
	});

	it("setTimeout returns Disposable that calls koishi's release function on dispose", () => {
		const ctx = makeFakeKoishiCtx();
		const sc = makeKoishiServiceContext(ctx, "test");
		const fn = vi.fn();

		const handle = sc.setTimeout(fn, 500);
		expect(ctx.setTimeout).toHaveBeenCalledWith(fn, 500);
		expect(ctx.__setTimeoutRelease).not.toHaveBeenCalled();

		handle.dispose();
		expect(ctx.__setTimeoutRelease).toHaveBeenCalledTimes(1);
	});

	it("onDispose registers a koishi 'dispose' listener", () => {
		const ctx = makeFakeKoishiCtx();
		const sc = makeKoishiServiceContext(ctx, "test");
		const cleanup = vi.fn();

		sc.onDispose(cleanup);

		expect(ctx.on).toHaveBeenCalledWith("dispose", cleanup);
		expect(ctx.__disposeListeners.has(cleanup)).toBe(true);
	});
});
