import { EventEmitter } from "node:events";
import type { BusEvents, MessageBus } from "@bilibili-notify/internal";
import { consoleErrorRedacted } from "../logs/console-fallback.js";

/**
 * In-process MessageBus. Backed by a single Node EventEmitter.
 *
 * Critical invariant (regression-tested in __tests__/message-bus.test.ts):
 * `bus.emit("X")` must fire each `bus.on("X", h)` listener EXACTLY ONCE. We deliberately
 * do not bridge to any other event channel here — the WS channels are a one-way
 * downstream — so a self-feeding loop cannot form.
 */
export interface NodeMessageBusOptions {
	/**
	 * 异步监听者 reject 时怎么报。装配处接到 serviceCtx 的 logger(过入口打码、进面板日志页与归档);
	 * 不给就退回 `console.error`,写出去前同样打码。总线不订阅日志,日志也不发总线事件。
	 */
	onHandlerError?: (event: keyof BusEvents, error: unknown) => void;
}

export function createNodeMessageBus(options: NodeMessageBusOptions = {}): MessageBus {
	const reportHandlerError =
		options.onHandlerError ??
		((event, error) =>
			consoleErrorRedacted(`[message-bus] async handler for "${String(event)}" rejected:`, error));
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
				// 原语不持 logger,出错怎么报由装配处经 `onHandlerError` 接(不改同步抛出语义,
				// 也不影响 runtime message-bus.test.ts 的“每监听器恰一次”契约)。
				if (r && typeof (r as { then?: unknown }).then === "function") {
					(r as Promise<unknown>).catch((e) => reportHandlerError(event, e));
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
