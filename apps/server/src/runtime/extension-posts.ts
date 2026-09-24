import {
	type BoundWorkPush,
	blockedNotice,
	type DynamicFilterConfig,
	deliverWork,
	filterByText,
	type WorkDeliveryConfig,
	type WorkDeliveryDeps,
	type WorkSubscriptionSettings,
} from "@bilibili-notify/dynamic";
import type {
	Disposable,
	ExtensionSubscription,
	Logger,
	MessageBus,
	Subscription,
	SubscriptionReportValue,
} from "@bilibili-notify/internal";
import { createSerialGate, type SerialGate } from "@bilibili-notify/live";
import { extensionPostFilterText, extensionPostWork } from "./extension-post-work.js";
import {
	type ExtensionSourceLookups,
	extensionCardAuthor,
	extensionSubscriptionName,
	extensionSubscriptionPushable,
} from "./extension-push-common.js";

/**
 * **拓展报的作品接进推送链**(ADR-0019 决策 53 / 62 / 66 / 69–72 / 77):bus 上 `subscription-reported` 里
 * `kind === "post"` 的那些,逐条订阅推出去。
 *
 * 一条订阅一条作品:
 * 1. 再核一次这条订阅还该推(还在、启用着、拓展在跑)—— 停用的收下不推(决策 62);动态总开关关着的
 *    也不出卡(推送层反正会挡,白出一张卡、白调一次 AI);
 * 2. 过滤只看内容(决策 70):关键词 / 正则 / 白名单,全局 + 按 UP 覆盖照常折叠,四个类型开关一律不看;
 *    被挡下时「屏蔽后提醒」照 B 站的规矩(`notify` 开着才发),措辞按平台的叫法;
 * 3. 作者按决策 54 取好,翻成中立作品,交给与 B 站同一份的装配(`deliverWork`)。
 *
 * - **同一条订阅的作品按到达顺序串行**(每条订阅一道 `createSerialGate`):拓展一口气报两条时,先报的那条
 *   出卡慢也先送到;不同订阅互不排队。
 * - **不判新、不去重、不限流**(决策 53):拓展报什么就接什么。
 * - **意外抛错只记错误日志、不重试**(决策 77):拓展的事件只来一次,BN 不替它重放;发不出去的目标推送层
 *   自己接住、落历史「失败」,可以人工重推。
 * - 上报的调用不等这里(决策 62):bus 的回调同步返回,活排进闸里。
 */

type Post = SubscriptionReportValue<"post">;

/** 一条拓展订阅折好的作品设置:装配那几格 + 过滤(已折好全局)+ 动态总开关。 */
export interface ExtensionPostSettings extends WorkSubscriptionSettings {
	/** 这条订阅生效的过滤(per-UP 覆盖 ?? 全局)。 */
	filter: DynamicFilterConfig & { notify?: boolean };
	/** 动态总开关(全局 + per-UP 折好的 `features.dynamic`)。 */
	dynamic: boolean;
}

export interface BindExtensionPostsOptions {
	bus: MessageBus;
	logger: Logger;
	/** 此刻的这条订阅(现取)。 */
	subscription(id: string): Subscription | undefined;
	/** 订阅资料里的名字(资料缓存,现取)。 */
	profileName(id: string): string | undefined;
	/** 这条订阅折好的作品设置(现折,与 B 站那头同一份,见 `dynamicWorkSettings`)。 */
	settings(sub: ExtensionSubscription): ExtensionPostSettings;
	/** 拓展在不在跑、平台叫法、存下的头像。 */
	sources: ExtensionSourceLookups;
	/** 绑到这条订阅上的作品发送(`boundWorkPush(bindSubscriptionPush(push, id))`)。 */
	pushFor(subscriptionId: string): BoundWorkPush;
	/** 装配的全局那几样 —— 与 B 站动态同一份(`dynamicConfig()`),现取。 */
	deliveryConfig(): WorkDeliveryConfig;
	/** 装配用到的服务:渲染器与 AI 会被热换,现取;出图失败的计数两条路同一份。 */
	deliveryDeps(): WorkDeliveryDeps;
}

export function bindExtensionPosts(opts: BindExtensionPostsOptions): Disposable {
	const log = opts.logger;
	/** 每条订阅一道闸。订阅删了就扔掉(还排着的照跑完,跑到时发现订阅不在了就不推)。 */
	const gates = new Map<string, SerialGate>();
	let disposed = false;

	const gateOf = (id: string): SerialGate => {
		let gate = gates.get(id);
		if (!gate) {
			gate = createSerialGate();
			gates.set(id, gate);
		}
		return gate;
	};

	/** 这条订阅现在还该推吗。关机之后一律不推。 */
	const pushable = (id: string): ExtensionSubscription | undefined => {
		if (disposed) return undefined;
		const sub = opts.subscription(id);
		return extensionSubscriptionPushable(sub, opts.sources.running) ? sub : undefined;
	};

	async function deliverOne(id: string, post: Post): Promise<void> {
		const sub = pushable(id);
		if (!sub) {
			log.debug(`[ext-post] 订阅 ${id} 已停用 / 已删 / 它的拓展没在跑,作品 ${post.id} 不推`);
			return;
		}
		const settings = opts.settings(sub);
		if (!settings.dynamic) {
			log.debug(`[ext-post] 订阅 ${id} 的动态推送关着,作品 ${post.id} 不推`);
			return;
		}
		const postNoun = opts.sources.postNoun(sub.extensionId);
		const profileName = opts.profileName(id);
		const push = opts.pushFor(id);

		const filtered = filterByText(extensionPostFilterText(post), settings.filter, log);
		if (filtered.blocked && filtered.reason) {
			log.debug(`[ext-post] 订阅 ${id} 的作品 ${post.id} 被过滤,原因:${filtered.reason}`);
			if (settings.filter.notify) {
				const name = extensionSubscriptionName(sub, { eventName: post.author?.name, profileName });
				// 与 B 站同一条规矩:提醒是 best-effort,发不出就算了。
				try {
					await push.broadcast(
						[{ type: "text", text: blockedNotice(name, filtered.reason, postNoun) }],
						"dynamic",
					);
				} catch (e) {
					log.warn(`[ext-post] 屏蔽提示发送失败(忽略): ${(e as Error).message}`);
				}
			}
			return;
		}

		const author = await extensionCardAuthor(sub, {
			event: post.author,
			profileName,
			readStoredAvatar: () => opts.sources.readAvatar(id),
		});
		const outcome = await deliverWork({
			work: extensionPostWork(post, { author, postNoun }),
			settings,
			push,
			// 出卡、点评几个 await 之后再核一次:期间停用了订阅 / 停了拓展 / 删了它,就不发。
			stillSubscribed: () => pushable(id) !== undefined,
			config: opts.deliveryConfig(),
			deps: opts.deliveryDeps(),
			logLabel: `sub=${id}`,
		});
		if (outcome === "unsubscribed") {
			log.debug(`[ext-post] 订阅 ${id} 在出卡途中停用 / 删掉了,作品 ${post.id} 没发`);
		}
	}

	const watches: Disposable[] = [
		opts.bus.on("subscription-reported", (delivery) => {
			if (delivery.report.kind !== "post") return;
			const post = delivery.report.value;
			for (const id of delivery.subscriptionIds) {
				void gateOf(id)
					.run(() => deliverOne(id, post))
					.catch((err) => {
						log.error(
							`[ext-post] 订阅 ${id} 的作品 ${post.id} 推送途中出错(不重试): ${err instanceof Error ? err.message : String(err)}`,
						);
					});
			}
		}),
		opts.bus.on("subscription-changed", (ops) => {
			for (const op of ops) if (op.type === "remove") gates.delete(op.sub.id);
		}),
	];

	return {
		dispose() {
			disposed = true;
			for (const watch of watches) watch.dispose();
			gates.clear();
		},
	};
}
