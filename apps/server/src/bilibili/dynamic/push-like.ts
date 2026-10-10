/**
 * 平台中立的推送出口接口与最小订阅视图。
 *
 * dynamic-engine 不直接 import `@bilibili-notify/push`;宿主(独立端 runtime)在装配
 * DynamicEngine 时实现 PushLike,并桥接到 PushRouter 的 channel 路由。
 *
 * 这里的接口仅声明 dynamic-engine 实际调用到的方法;任何字段/方法的扩展应该先在
 * 业务代码中显现需求,再回填到此接口,避免接口与实现脱节。
 */

import type { PostFilterReason } from "@bilibili-notify/internal";
import type { WorkSubscriptionSettings } from "../../posts/deliver-post";
import type { PostFilterRules } from "../../posts/post-filter";
import type { PostPushAnchor } from "../../posts/post-push";

/**
 * 一次作品推送,整个交给宿主:主卡加图集是同一次(历史落同一行)。特性恒为作品,所以没有
 * 特性那一格;`uid` 由宿主换成订阅 id。
 */
export interface PostPush {
	uid: string;
	/** 按顺序排好的锚点。本体至多一个,有的话排第一个。 */
	anchors: PostPushAnchor[];
}

/**
 * 一条被过滤挡下的作品,交给宿主留痕(推送历史里的一行 `filtered`,ADR-0021 决策 34 的 🔗)。它不是推送:
 * 不出卡、不抓图、不调 AI,所以不走 {@link PushLike},走引擎选项里的 `onPostFiltered`。`uid` 由宿主换成订阅 id。
 */
export interface FilteredPost {
	uid: string;
	/** 被哪一类规则挡下的。 */
	filteredBy: PostFilterReason;
	/** 这条作品的整条文字:`postText(post, "plain")`,过滤看的就是这一份。没截过,摘要由宿主截。 */
	text: string;
	/** 原帖地址(动态页)。 */
	url: string;
}

export interface PushLike {
	/**
	 * 把一次作品推送交给推送层。开关、静音与免扰在交出去那一刻判一次;本体发完时返回,
	 * 附加项在后台按锚点先后接着发。
	 */
	push(push: PostPush): Promise<void>;

	/** 私信发送给配置的管理员账号（master）。adapter 端校验启用状态与 bot 在线性。 */
	sendPrivateMsg(content: string): Promise<void>;

	/** 与 sendPrivateMsg 等价，但 adapter 应当在内部把内容追加到 error 日志。 */
	sendErrorMsg(reason: string): Promise<void>;
}

/**
 * 平台中立的订阅条目最小视图。宿主折叠 `Subscription.overrides` 后填入。
 *
 * `filter` / `aiOverride` 为 per-UP 覆盖(可选);缺失时 engine 回退到
 * `DynamicEngineConfig.filter` / 全局 CommentaryGenerator 配置。
 */
export interface SubItemView extends WorkSubscriptionSettings {
	uid: string;
	uname: string;
	/**
	 * 这条订阅在核心里的 id(`Subscription.id`),由宿主 `buildDynamicSubViewSingle` 填。引擎认人靠 `uid`,
	 * 出卡时按它向宿主现读资料里的头像(`avatarOf`)。
	 */
	subscriptionId: string;
	post?: boolean;
	/** Per-UP 作品过滤覆盖(折好的 `ContentFilters`);undefined 时使用 engine 的全局 filter。 */
	filter?: PostFilterRules;
}

export type SubscriptionsView = Record<string, SubItemView>;
export type SubManagerView = Map<string, SubItemView>;

/**
 * 宿主提供给 engine 的增量操作描述:独立端在 SubscriptionStore 写入后转译为
 * SubscriptionOpView 列表,交给 engine.applyOps。
 */
export type SubscriptionOpView =
	| { kind: "add"; sub: SubItemView }
	| { kind: "delete"; uid: string }
	| {
			kind: "update";
			uid: string;
			changes: Array<{ scope: string; post?: boolean }>;
	  };
