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
				const r = (handler as (...a: unknown[]) => unknown)(...args);
				// BiliEvents handler 类型上是同步 (=> void)。防御兜底:若某处注册了
				// async handler,其 reject 此前会逃逸成 unhandled rejection。该 infra
				// 原语不持 logger,console.error 是最后一道网(不改同步抛出语义,
				// 也不影响 koishi/runtime message-bus.test.ts 的“每监听器恰一次”契约)。
				if (r && typeof (r as { then?: unknown }).then === "function") {
					(r as Promise<unknown>).catch((e) => {
						console.error(`[message-bus] async handler for "${String(event)}" rejected:`, e);
					});
				}
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
