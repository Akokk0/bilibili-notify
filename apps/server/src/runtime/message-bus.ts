import { EventEmitter } from "node:events";
import type { BiliEvents, MessageBus } from "@bilibili-notify/internal";

/**
 * In-process MessageBus for the standalone end. Backed by a single Node EventEmitter.
 *
 * Critical invariant (regression-tested in koishi/runtime/__tests__/message-bus.test.ts):
 * `bus.emit("X")` must fire each `bus.on("X", h)` listener EXACTLY ONCE. We deliberately
 * do not bridge to any other event channel here — there is no koishi `ctx` in this end —
 * so the no-self-loop concern is structural rather than a hazard, but we keep the same
 * shape so the koishi end's test contract carries over.
 */
export function createNodeMessageBus(): MessageBus {
	const emitter = new EventEmitter();
	emitter.setMaxListeners(0); // unbounded; the bus is internally shared by every engine

	return {
		emit<E extends keyof BiliEvents>(event: E, ...args: Parameters<BiliEvents[E]>) {
			emitter.emit(event as string, ...(args as unknown[]));
		},
		on<E extends keyof BiliEvents>(event: E, handler: BiliEvents[E]) {
			const wrapped = (...args: unknown[]) => {
				(handler as (...a: unknown[]) => void)(...args);
			};
			emitter.on(event as string, wrapped);
			return {
				dispose() {
					emitter.off(event as string, wrapped);
				},
			};
		},
	};
}
