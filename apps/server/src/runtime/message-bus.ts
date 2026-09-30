import { EventEmitter } from "node:events";
import type { BusEvents, MessageBus } from "@bilibili-notify/internal";

/**
 * In-process MessageBus for the standalone end. Backed by a single Node EventEmitter.
 *
 * Critical invariant (regression-tested in __tests__/message-bus.test.ts):
 * `bus.emit("X")` must fire each `bus.on("X", h)` listener EXACTLY ONCE. We deliberately
 * do not bridge to any other event channel here — the WS channels are a one-way
 * downstream — so a self-feeding loop cannot form.
 */
export function createNodeMessageBus(): MessageBus {
	const emitter = new EventEmitter();
	emitter.setMaxListeners(0); // unbounded; the bus is internally shared by every engine

	return {
		// 载荷只有一个(或没有):`BusEvents` 每个事件一个具名对象,这里原样递给监听者。
		emit(event: keyof BusEvents, ...payload: unknown[]) {
			emitter.emit(event, ...payload);
		},
		on(event: keyof BusEvents, handler: (payload: never) => unknown) {
			const wrapped = (payload: unknown) => {
				const r = handler(payload as never);
				// 监听者类型上是同步 (=> void)。防御兜底:若某处注册了
				// async handler,其 reject 此前会逃逸成 unhandled rejection。该 infra
				// 原语不持 logger,console.error 是最后一道网(不改同步抛出语义,
				// 也不影响 runtime message-bus.test.ts 的“每监听器恰一次”契约)。
				if (r && typeof (r as { then?: unknown }).then === "function") {
					(r as Promise<unknown>).catch((e) => {
						console.error(`[message-bus] async handler for "${String(event)}" rejected:`, e);
					});
				}
			};
			emitter.on(event, wrapped);
			return {
				dispose() {
					emitter.off(event, wrapped);
				},
			};
		},
	};
}
