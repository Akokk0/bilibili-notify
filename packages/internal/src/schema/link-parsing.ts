import { z } from "zod";

/**
 * 链接解析(独立端专有):群里有人贴 B 站视频链接,机器人自动回一张视频卡片。
 *
 * - `enabled` —— 总开关,**默认关**。开着就意味着同群任何人都能让机器人出图
 *   (指令文档里「不做群内指令」的顾虑同源),这得是主人自己按下去的。
 * - `cooldownSeconds` —— 同一个群里同一个视频多久内只出一次图。0 = 不节流。
 *   上限一小时:再长就不是节流而是「第二次永远不出」,主人会以为坏了。
 */
export const LinkParsingConfigSchema = z.object({
	enabled: z.boolean().default(false),
	cooldownSeconds: z.number().int().min(0).max(3600).default(60),
});
export type LinkParsingConfig = z.infer<typeof LinkParsingConfigSchema>;

export const DEFAULT_LINK_PARSING: LinkParsingConfig = {
	enabled: false,
	cooldownSeconds: 60,
};
