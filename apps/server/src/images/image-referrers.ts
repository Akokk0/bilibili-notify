/**
 * 图库引用方的名字:全进程一张小表(ADR-0027 决策 10 / 17)。
 *
 * 名字是 {@link ImageReferrer.name},也是登记表的键,更是 `ImageStore.usage()` 的 `holders` 里写的东西 ——
 * 存储占用按它分类(「一张图算进某一类,条件是引用它的全都属于那一类」)。所以登记处不手写字符串,
 * 都从这里取;分类的一方也从这里取,两头对不上就是编译不过或测试红。
 */
export const IMAGE_REFERRERS = {
	/** 推送历史:保留期内日文件里的配图与头像快照。 */
	history: "推送历史",
	/** 重推原件:每份原件里的图。 */
	repush: "重推原件",
	/** 订阅资料:资料缓存里的头像。 */
	profiles: "订阅资料",
	/** 女仆对话:会话里的图。 */
	chat: "女仆对话",
	/** 拓展作品:在途数据、名单恒空。 */
	posts: "作品配图",
	/** 集成在途:集成经 `ctx.fetchImage` / `ctx.storeImage` 存的图,名单恒空、全靠宽限期活到被哪一行引用上。 */
	inTransit: "集成在途",
	/** 直播:在播表里的封面与头像。 */
	live: "直播图",
	/** 来源声明的图:来源描述符里带图库引用的素材(今天是 B 站大航海三档的徽章);名单现读登记表。 */
	sourceDeclared: "来源声明的图",
	/** 账号头像:来源登录着的账号的头像,登录后与头像网址变了时抓进图库,名单是在册来源手里的那几张。 */
	accounts: "账号头像",
} as const;

export type ImageReferrerName = (typeof IMAGE_REFERRERS)[keyof typeof IMAGE_REFERRERS];
