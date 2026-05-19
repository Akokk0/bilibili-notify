import { z } from "zod";

export const HistorySourceSchema = z.enum([
	"dynamic",
	"live",
	"sc",
	"guard",
	"special-danmaku",
	"special-enter",
	"live-summary",
]);
export type HistorySource = z.infer<typeof HistorySourceSchema>;

export const HistoryPayloadSchema = z.object({
	kind: z.enum(["text", "image", "composite"]),
	text: z.string().optional(),
	/**
	 * 图片相对引用，存放于 `<dataDir>/history/img/<imageRef>`；独立端展示时直接读。
	 * 写入侧恒为 `<uuid>.<ext>` / `<uuid>-<idx>.<ext>`,这里收紧为「纯 basename」
	 * (无路径分隔符 / 无 `..`)—— 篡改或重放的 jsonl 不能让 `join(imgRoot, ref)`
	 * 穿越出 history/img 读任意文件(读路由侧另有独立第二道防线)。
	 */
	imageRef: z
		.string()
		.regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/, "imageRef 必须是纯文件名")
		.refine((s) => !s.includes(".."), "imageRef 不得含 ..")
		.optional(),
});
export type HistoryPayload = z.infer<typeof HistoryPayloadSchema>;

/** 单 PushTarget 的发送结果。 */
export const HistoryDeliverySchema = z.object({
	targetId: z.uuid(),
	ok: z.boolean(),
	err: z.string().optional(),
	latencyMs: z.number().nonnegative(),
});
export type HistoryDelivery = z.infer<typeof HistoryDeliverySchema>;

export const HistoryEntrySchema = z.object({
	id: z.uuid(),
	ts: z.string(),
	source: HistorySourceSchema,
	uid: z.string(),
	subscriptionId: z.uuid(),
	targetIds: z.array(z.uuid()),
	result: z.object({
		ok: z.boolean(),
		per: z.array(HistoryDeliverySchema),
	}),
	payload: HistoryPayloadSchema,
	/**
	 * 写入时从该订阅的 cachedProfile 快照下来的 UP 主名称 / 头像。cachedProfile
	 * 已从 Subscription 外置,独立端由 apps/server SubRuntimeStore 持有(koishi
	 * 端无此缓存,uname 退化为 UID)。
	 *
	 * History 是 immutable 历史事实,但 UI 渲染依赖 cachedProfile 查询当前
	 * 名称 — 一旦用户后续删除该订阅,Dashboard 上的旧 history 条目只剩 "UID xxx" +
	 * 默认头像,失去了"当时是谁"的信息。把名称 / 头像跟 entry 一起 snapshot
	 * 进 jsonl 后,删除订阅不再影响历史展示。
	 *
	 * 老 entry(本字段加入前写入的)没有这两个字段,UI 仍走原 fallback(查
	 * subByUid → fallback 到 UID 占位)。retention 30d 内会被自然淘汰。
	 */
	unameSnapshot: z.string().optional(),
	uavatarSnapshot: z.string().optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
