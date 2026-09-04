import { z } from "zod";

/**
 * 链接解析(独立端专有):群里有人贴 B 站视频链接,机器人自动回一张视频卡片。
 *
 * - `enabled` —— 总开关,**默认关**。开着就意味着同群任何人都能让机器人出图
 *   (指令文档里「不做群内指令」的顾虑同源),这得是主人自己按下去的。
 * - `cooldownSeconds` —— 同一个群里同一个视频多久内只出一次图。0 = 不节流。
 *   上限一小时:再长就不是节流而是「第二次永远不出」,主人会以为坏了。
 * - `scope` —— 在哪些群生效。`all` = 机器人在的所有群(不要求群配成推送目标);
 *   `selected` = 只在 `targets` 列出的那些群。**默认 `all`**:白名单是后加的,升上来的
 *   实例范围必须落在原来的行为上。
 * - `targets` —— 白名单,引用推送目标(`PushTarget.id`),只在 `selected` 时起作用。
 *   条目是 `{ targetId }` 对象而不是裸 id:给将来「按群差异化」(比如这个群回小程序卡、
 *   那个群回图片卡)留位,今天只有这一个字段。悬空的 id(目标后来删了)不在这里校验,
 *   运行时直接忽略 —— 删目标不联动改这里,面板也只画现存的目标。
 */
export const LinkParsingScopeSchema = z.enum(["all", "selected"]);
export type LinkParsingScope = z.infer<typeof LinkParsingScopeSchema>;

export const LinkParsingTargetSchema = z.object({
	targetId: z.uuid(),
});
export type LinkParsingTarget = z.infer<typeof LinkParsingTargetSchema>;

export const LinkParsingConfigSchema = z.object({
	enabled: z.boolean().default(false),
	cooldownSeconds: z.number().int().min(0).max(3600).default(60),
	scope: LinkParsingScopeSchema.default("all"),
	// 同一个目标写两遍只留一份。幂等 transform 而不是 refine:归一化数据,不让既有配置在
	// parse 时直接被拒(与订阅路由那份去重同一条理由)。
	targets: z
		.array(LinkParsingTargetSchema)
		.default([])
		.transform((list) => {
			const seen = new Set<string>();
			return list.filter((t) => {
				if (seen.has(t.targetId)) return false;
				seen.add(t.targetId);
				return true;
			});
		}),
});
export type LinkParsingConfig = z.infer<typeof LinkParsingConfigSchema>;

export const DEFAULT_LINK_PARSING: LinkParsingConfig = {
	enabled: false,
	cooldownSeconds: 60,
	scope: "all",
	targets: [],
};
