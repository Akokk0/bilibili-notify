/**
 * 动态引擎的宿主接口。
 *
 * 动态引擎只负责**生产**:拉 feed、判新、翻成作品、抓图,然后经 `reportPost` 交给核心的作品入口(`posts/post-queue.ts`)。
 * 它不直接 import `@bilibili-notify/push`,也不管怎么消费(过滤、出卡、点评、推送、图集都是核心的事);
 * 这里的接口只剩引擎自己要用的:给主人发私信(风控 / 故障告警)。订阅名单走来源上下文(`ctx.subscriptions`)。
 *
 * 这里的接口仅声明 dynamic-engine 实际调用到的方法;任何字段/方法的扩展应该先在
 * 业务代码中显现需求,再回填到此接口,避免接口与实现脱节。
 */

export interface PushLike {
	/** 私信发送给配置的管理员账号（master）。adapter 端校验启用状态与 bot 在线性。 */
	sendPrivateMsg(content: string): Promise<void>;
}
