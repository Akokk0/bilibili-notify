/**
 * **作品装配入口**(`PostQueue`,ADR-0028):来源(B 站动态引擎、拓展作品绑定)把一条作品交进核心就走这一个口。
 * 来源只负责生产 —— 交完就算,不等装配、不看结果;怎么消费(过滤、出卡、点评、推送、图集)是核心的事。
 *
 * `enqueue` 同步返回、没有返回值、永不抛。入口里依次:
 *
 * 1. 订阅不该推(不在 / 停用 / 作品开关关着 / 来源没在跑)→ 丢,不发事件;
 * 2. 同步发 `post-detected`(**旁路通知**,给统计;事件总线不在推送链上)—— 排在串行闸与过滤**之前**,
 *    所以被过滤的、前面还排着慢作品的,同样算 UP 的产出,统计不被拖住;
 * 3. 按订阅排进一道串行闸(同一条订阅的作品按入队次序一条条装配,先交的出卡慢也先送到;不同订阅互不排队),
 *    闸里跑 {@link deliverPost}。
 *
 * - **不判新、不去重、不限流**:来源交什么就接什么;
 * - **意外抛错只记错误日志、不重试**(ADR-0019 决策 77):作品只交一次,核心不替来源重放;发不出去的目标推送层
 *   自己接住、落历史「失败」,可以人工重推;
 * - 每条作品的活登记进 `serviceCtx.track`:发出去不等,关停等它推完 —— 推送落历史的那一笔得赶在各写道关门之前交进去。
 */

import type {
	Disposable,
	Logger,
	MessageBus,
	PostEvent,
	ServiceContext,
} from "@bilibili-notify/internal";
import { createSerialGate, type SerialGate } from "@bilibili-notify/internal";
import { errorMessageOf } from "../util/error-message.js";
import { type DeliverPostDeps, deliverPost } from "./deliver-post";

export interface PostQueueOptions {
	logger: Logger;
	bus: Pick<MessageBus, "emit" | "on">;
	serviceCtx: Pick<ServiceContext, "track">;
	deps: DeliverPostDeps;
}

export interface PostQueue extends Disposable {
	/** 把一条作品交进装配。同步返回、没有返回值、永不抛。 */
	enqueue(event: PostEvent): void;
}

export function createPostQueue(options: PostQueueOptions): PostQueue {
	const { logger, bus, serviceCtx } = options;
	/** 每条订阅一道闸。订阅删了就扔掉(还排着的照跑完,跑到时现折设置发现订阅不在了就不推)。 */
	const gates = new Map<string, SerialGate>();
	let disposed = false;

	// 关停之后一步都不往下走:设置读口认「队列已关」,装配开头的现折与回问两处都会回 undefined。
	const deps: DeliverPostDeps = {
		...options.deps,
		settings: (subscriptionId) => (disposed ? undefined : options.deps.settings(subscriptionId)),
	};

	const gateOf = (subscriptionId: string): SerialGate => {
		let gate = gates.get(subscriptionId);
		if (!gate) {
			gate = createSerialGate();
			gates.set(subscriptionId, gate);
		}
		return gate;
	};

	const watch = bus.on("subscription-changed", ({ ops }) => {
		for (const op of ops) if (op.kind === "remove") gates.delete(op.sub.id);
	});

	return {
		enqueue(event) {
			// 关了之后:`deps.settings` 回 undefined,下面第一步就丢掉。
			const id = event.subscriptionId;
			try {
				if (deps.settings(id) === undefined) {
					logger.debug(`[post] 订阅 ${id} 已停用 / 已删 / 不该推,作品 ${event.postId} 不收`);
					return;
				}
				try {
					bus.emit("post-detected", event);
				} catch (e) {
					// 总线上的监听者坏了不该挡住装配:这条作品照常往下走。
					logger.error(`[post] post-detected 的监听者抛错(忽略): ${errorMessageOf(e)}`);
				}
				serviceCtx.track(
					gateOf(id)
						.run(() => deliverPost(event, deps))
						.catch((err: unknown) => {
							logger.error(
								`[post] 订阅 ${id} 的作品 ${event.postId} 推送途中出错(不重试): ${errorMessageOf(err)}`,
							);
						}),
				);
			} catch (e) {
				// 入口永不抛:连设置读口自己出了意外也只记一笔。
				logger.error(`[post] 订阅 ${id} 的作品 ${event.postId} 入队失败: ${errorMessageOf(e)}`);
			}
		},
		dispose() {
			disposed = true;
			watch.dispose();
			gates.clear();
		},
	};
}
