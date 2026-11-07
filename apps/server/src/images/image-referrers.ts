import { t as serverText } from "../i18n/index.js";
/**
 * 图库引用方的名字:全进程一张小表(ADR-0027 决策 10 / 17)。
 *
 * 名字是 {@link ImageReferrer.name},也是登记表的键,更是 `ImageStore.usage()` 的 `holders` 里写的东西 ——
 * 存储占用按它分类(「一张图算进某一类,条件是引用它的全都属于那一类」)。所以登记处不手写字符串,
 * 都从这里取;分类的一方也从这里取,两头对不上就是编译不过或测试红。
 */
export const IMAGE_REFERRERS = {
	/** 推送历史:保留期内日文件里的配图与头像快照。 */
	get history() {
		return serverText("service.images.image-referrers.text.1");
	},
	/** 重推原件:每份原件里的图。 */
	get repush() {
		return serverText("service.images.image-referrers.text.2");
	},
	/** 订阅资料:资料缓存里的头像。 */
	get profiles() {
		return serverText("service.images.image-referrers.text.3");
	},
	/** 女仆对话:会话里的图。 */
	get chat() {
		return serverText("service.images.image-referrers.text.4");
	},
	/** 拓展作品:在途数据、名单恒空。 */
	get posts() {
		return serverText("service.images.image-referrers.text.5");
	},
	/** 集成在途:集成经 `ctx.fetchImage` / `ctx.storeImage` 存的图,名单恒空、全靠宽限期活到被哪一行引用上。 */
	get inTransit() {
		return serverText("service.images.image-referrers.text.6");
	},
	/** 直播:在播表里的封面与头像。 */
	get live() {
		return serverText("service.images.image-referrers.text.7");
	},
	/** 来源声明的图:来源描述符里带图库引用的素材(今天是 B 站大航海三档的徽章);名单现读登记表。 */
	get sourceDeclared() {
		return serverText("service.images.image-referrers.text.8");
	},
	/** 账号头像:来源登录着的账号的头像,登录后与头像网址变了时抓进图库,名单是在册来源手里的那几张。 */
	get accounts() {
		return serverText("service.images.image-referrers.text.9");
	},
} as const;
