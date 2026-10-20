import { z } from "zod";
import { LINK_REPLY_FORMS, type LinkReplyForm } from "../constants";

/**
 * 链接预览(独立端专有):群里有人贴视频链接,机器人自动回一张预览。五格:
 *
 * - `enabled` —— 总开关,**默认关**。开着就意味着同群任何人都能让机器人出图
 *   (指令文档里「不做群内指令」的顾虑同源),这得是主人自己按下去的。它在逐目标的答案**之前**看:
 *   总开关关着,无论默认行与例外怎么写,一张都不回。
 * - `isOnByDefault` —— **默认行**:所有群回不回。「所有群」不是一种模式,它就是这一行。
 * - `replyForm` —— 默认回什么(图片 / 原生分享 / 文字)。
 * - `byTarget` —— **逐目标例外**,键是推送目标 id(`PushTarget.id`),值只存显式写了的字段
 *   (`isOn` 回不回、`replyForm` 回什么),没写的字段跟默认行(与 per-UP 覆写同一套写法:每格三态)。
 *   不是推送目标的群没有 id,只能跟默认行。悬空的 id(目标后来删了)不在这里校验,运行时直接忽略。
 * - `cooldownSec` —— 同一个群里同一个视频多久内只出一次。0 = 不节流。
 *   上限一小时:再长就不是节流而是「第二次永远不出」,主人会以为坏了。
 *
 * 全仓的 `enabled` 只表示总开关;「默认回不回」叫 `isOnByDefault`、例外条目里叫 `isOn`,避开 AI 写正文
 * 那边 `enabled` 曾兼作默认行的撞义(AI 写正文也已改成 `isOnByDefault`)。
 *
 * 0.x 存的是 `linkParsing { enabled, cooldownSeconds, defaults: { parse, form }, groups }`
 * (0.9.1 更早是 `scope` + `targets`),由迁移器一次改写成这里的形状(`apps/server/src/migration/link-parsing.ts`)。
 */
export const LinkReplyFormSchema = z.enum(LINK_REPLY_FORMS);

export const LinkPreviewTargetSettingsSchema = z.object({
	isOn: z.boolean().optional(),
	replyForm: LinkReplyFormSchema.optional(),
});
export type LinkPreviewTargetSettings = z.infer<typeof LinkPreviewTargetSettingsSchema>;

const LinkPreviewSettingsObjectSchema = z.object({
	enabled: z.boolean().default(false),
	isOnByDefault: z.boolean().default(true),
	replyForm: LinkReplyFormSchema.default("image"),
	// 例外只存显式值:一个字段都没写的条目等于没写,剥掉。幂等 transform 而不是 refine:
	// 归一化数据,不让既有配置在 parse 时直接被拒(与订阅路由那份去重同一条理由)。
	byTarget: z
		.record(z.uuid(), LinkPreviewTargetSettingsSchema)
		.default({})
		.transform((byTarget) =>
			Object.fromEntries(
				Object.entries(byTarget).filter(
					([, o]) => o.isOn !== undefined || o.replyForm !== undefined,
				),
			),
		),
	cooldownSec: z.number().int().min(0).max(3600).default(60),
});
export type LinkPreviewSettings = z.infer<typeof LinkPreviewSettingsObjectSchema>;

export const LinkPreviewSettingsSchema = LinkPreviewSettingsObjectSchema;

export const DEFAULT_LINK_PREVIEW: LinkPreviewSettings = {
	enabled: false,
	isOnByDefault: true,
	replyForm: "image",
	byTarget: {},
	cooldownSec: 60,
};

/** 一个群折叠后的答案:回不回、回什么。 */
export interface LinkPreviewPolicy {
	isOn: boolean;
	replyForm: LinkReplyForm;
}

/**
 * 折叠出某个群的答案:例外里写了的字段覆盖默认行,没写的跟默认行。`targetId` 为空
 * (这个群不是推送目标)就是默认行本身。
 */
export function linkPreviewFor(
	settings: Pick<LinkPreviewSettings, "isOnByDefault" | "replyForm" | "byTarget">,
	targetId: string | undefined,
): LinkPreviewPolicy {
	const o = targetId === undefined ? undefined : settings.byTarget[targetId];
	return {
		isOn: o?.isOn ?? settings.isOnByDefault,
		replyForm: o?.replyForm ?? settings.replyForm,
	};
}
