/**
 * 动态引擎的宿主接口与最小订阅视图。
 *
 * 动态引擎只负责**生产**:拉 feed、判新、翻成作品、抓图,然后经 `reportPost` 交给核心的作品入口(`posts/post-queue.ts`)。
 * 它不直接 import `@bilibili-notify/push`,也不管怎么消费(过滤、出卡、点评、推送、图集都是核心的事);
 * 这里的接口只剩引擎自己要用的:给主人发私信(风控 / 故障告警)与它要看的那一点订阅信息。
 *
 * 这里的接口仅声明 dynamic-engine 实际调用到的方法;任何字段/方法的扩展应该先在
 * 业务代码中显现需求,再回填到此接口,避免接口与实现脱节。
 */

export interface PushLike {
	/** 私信发送给配置的管理员账号（master）。adapter 端校验启用状态与 bot 在线性。 */
	sendPrivateMsg(content: string): Promise<void>;
}

/**
 * 引擎眼里的一条订阅:认人靠 `uid`,`post` 决定它进不进推送名单(`dynamicSubManager`)。
 * 进了名单的才为它翻译、抓图、交作品;不在名单里的(关了作品推送的)只推进时间线锚点。
 * 真源是宿主的 `sub.enabled && eff.features.post`(`buildDynamicSubViewSingle`)。
 */
export interface SubItemView {
	uid: string;
	post?: boolean;
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
