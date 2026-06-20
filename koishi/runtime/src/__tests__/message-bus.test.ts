import type { Context } from "koishi";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeKoishiMessageBus } from "../message-bus";

type Listener = (...args: unknown[]) => void;

/**
 * Minimal koishi `Context` test double exposing only `emit` / `on`.
 * `on` returns a release function the way koishi does.
 */
function makeFakeKoishiCtx() {
	const listeners = new Map<string, Set<Listener>>();
	const ctx = {
		emit(name: string, ...args: unknown[]) {
			const set = listeners.get(name);
			if (!set) return;
			// snapshot to avoid mutation during iteration
			for (const h of [...set]) h(...args);
		},
		on(name: string, h: Listener) {
			let set = listeners.get(name);
			if (!set) {
				set = new Set();
				listeners.set(name, set);
			}
			set.add(h);
			return () => {
				listeners.get(name)?.delete(h);
				return true;
			};
		},
		__listeners: listeners,
	};
	return ctx as unknown as Context & { __listeners: Map<string, Set<Listener>> };
}

describe("makeKoishiMessageBus()", () => {
	it("bus.emit fires the prefixed bilibili-notify/<event> on the underlying ctx exactly once", () => {
		const ctx = makeFakeKoishiCtx();
		const handler = vi.fn();
		// biome-ignore lint/suspicious/noExplicitAny: tests bypass koishi's typed Events
		(ctx.on as any)("bilibili-notify/auth-lost", handler);

		const bus = makeKoishiMessageBus(ctx);
		bus.emit("auth-lost");

		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith();
	});

	it("bus.on receives events emitted by bus.emit on the same key, exactly once (no recursion)", () => {
		const ctx = makeFakeKoishiCtx();
		const bus = makeKoishiMessageBus(ctx);
		const handler = vi.fn();
		bus.on("auth-lost", handler);

		bus.emit("auth-lost");
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("bus.on(...).dispose() detaches the listener so subsequent emits do not fire", () => {
		const ctx = makeFakeKoishiCtx();
		const bus = makeKoishiMessageBus(ctx);
		const handler = vi.fn();

		const sub = bus.on("auth-lost", handler);
		bus.emit("auth-lost");
		sub.dispose();
		bus.emit("auth-lost");

		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("different events do not cross-pollute", () => {
		const ctx = makeFakeKoishiCtx();
		const bus = makeKoishiMessageBus(ctx);
		const lost = vi.fn();
		const restored = vi.fn();

		bus.on("auth-lost", lost);
		bus.on("auth-restored", restored);

		bus.emit("auth-lost");
		expect(lost).toHaveBeenCalledTimes(1);
		expect(restored).not.toHaveBeenCalled();
	});

	it("multiple bus.on listeners on the same event all fire", () => {
		const ctx = makeFakeKoishiCtx();
		const bus = makeKoishiMessageBus(ctx);
		const a = vi.fn();
		const b = vi.fn();

		bus.on("subscription-changed", a);
		bus.on("subscription-changed", b);
		bus.emit("subscription-changed", []);

		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it("bus.emit forwards payload arguments to the koishi listener", () => {
		const ctx = makeFakeKoishiCtx();
		const bus = makeKoishiMessageBus(ctx);
		const handler = vi.fn();
		bus.on("engine-error", handler);

		bus.emit("engine-error", "live", "boom");

		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith("live", "boom");
	});

	it("a koishi-side listener registered via ctx.on must not be re-fired by bus.on (no bridge)", () => {
		// regression guard for the circular-bridge bug fixed in b732983.
		// If a future refactor adds "bus.on must forward to ctx.emit", a single
		// bus.emit will fire the koishi-side handler twice (once via emit, once via the bridge).
		const ctx = makeFakeKoishiCtx();
		const bus = makeKoishiMessageBus(ctx);

		const koishiSide = vi.fn();
		// biome-ignore lint/suspicious/noExplicitAny: tests bypass koishi's typed Events
		(ctx.on as any)("bilibili-notify/auth-lost", koishiSide);

		const busSide = vi.fn();
		bus.on("auth-lost", busSide);

		bus.emit("auth-lost");

		expect(koishiSide).toHaveBeenCalledTimes(1);
		expect(busSide).toHaveBeenCalledTimes(1);
	});
});
