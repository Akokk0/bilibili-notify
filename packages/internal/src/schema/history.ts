import { z } from "zod";
import type { FeatureKey } from "../constants";

/**
 * 推送类型 —— 配置里能单独开关的每一类算一种,共 8 种。开播与周期「正在直播」共用一把
 * 特性键(live)与一份目标,历史上却是两种推送,所以这里比特性键多一个 `live-ongoing`。
 */
export const PushKindSchema = z.enum([
	"dynamic",
	"live",
	"live-ongoing",
	"live-end",
	"guard",
	"sc",
	"special-danmaku",
	"special-enter",
]);
export type PushKind = z.infer<typeof PushKindSchema>;

/**
 * 特性键 → 推送类型的缺省翻译。只有 `live` 那把键分不出「开播」与周期「正在直播」,
 * 调用方知道是哪种时显式传,不传就按开播记。
 */
export function featureToPushKind(feature: FeatureKey): PushKind {
	switch (feature) {
		case "dynamic":
			return "dynamic";
		case "live":
			return "live";
		case "liveEnd":
			return "live-end";
		case "liveGuardBuy":
			return "guard";
		case "superchat":
			return "sc";
		case "specialDanmaku":
			return "special-danmaku";
		case "specialUserEnter":
			return "special-enter";
	}
}

/**
 * 一行历史的四态:
 * - delivered:全部消息都到了
 * - partial:本体到了,附加项(@全体 / 图集 / 词云 / 总结)或本体的后续分条没到
 * - failed:本体没到
 * - no-targets:这类推送没有任何可用目标(没配,或配的全停用),消息照记、没发出去
 */
export const PushStatusSchema = z.enum(["delivered", "partial", "failed", "no-targets"]);
export type PushStatus = z.infer<typeof PushStatusSchema>;

export const HistoryPayloadSchema = z.object({
	kind: z.enum(["text", "image", "composite"]),
	text: z.string().optional(),
	/**
	 * 图片相对引用，存放于 `<dataDir>/history/img/<imageRef>`；独立端展示时直接读。
	 * 写入侧恒为 `<rowId>-<idx>.<ext>` / `<rowId>-<idx>-<seg>.<ext>`,这里收紧为「纯 basename」
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

/** 一条消息是推送的本体(卡片 / 分条正文)还是附加项(@全体、图集、词云、总结)。 */
export const HistoryMessageRoleSchema = z.enum(["main", "extra"]);
export type HistoryMessageRole = z.infer<typeof HistoryMessageRoleSchema>;

/** 一条消息对这个目标的投递结果。无目标行没有它。 */
export const HistoryMessageResultSchema = z.object({
	ok: z.boolean(),
	err: z.string().optional(),
	latencyMs: z.number().nonnegative(),
});
export type HistoryMessageResult = z.infer<typeof HistoryMessageResultSchema>;

export const HistoryMessageSchema = z.object({
	payload: HistoryPayloadSchema,
	role: HistoryMessageRoleSchema,
	result: HistoryMessageResultSchema.optional(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

const HistoryEntryObjectSchema = z.object({
	/** 行 id。补丁行拿它认亲。 */
	id: z.uuid(),
	/** 推送 id:同一次推送落到几个目标就有几行,它们共用这一个。 */
	pushId: z.uuid(),
	/** 建行时刻(本体落地那一刻);后续追加不改它。 */
	ts: z.string(),
	kind: PushKindSchema,
	uid: z.string(),
	subscriptionId: z.uuid(),
	/** null = 无目标行。 */
	targetId: z.uuid().nullable(),
	status: PushStatusSchema,
	messages: z.array(HistoryMessageSchema),
	/**
	 * 写入时从该订阅的 cachedProfile 快照下来的 UP 主名称 / 头像。cachedProfile
	 * 已从 Subscription 外置,由 apps/server SubRuntimeStore 持有。
	 *
	 * History 是 immutable 历史事实,但 UI 渲染依赖 cachedProfile 查询当前
	 * 名称 — 一旦用户后续删除该订阅,Dashboard 上的旧 history 条目只剩 "UID xxx" +
	 * 默认头像,失去了"当时是谁"的信息。把名称 / 头像跟 entry 一起 snapshot
	 * 进 jsonl 后,删除订阅不再影响历史展示。
	 */
	unameSnapshot: z.string().optional(),
	uavatarSnapshot: z.string().optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntryObjectSchema>;

/**
 * 老格式(一行 = 一个目标 × 一条消息,带 `source` / `result` / `payload`)读时映射成新形状,
 * 盘上不重写,30 天保留期到了自然淘汰。`live` 只当开播(老格式分不出周期复推),
 * `live-summary`(词云 / 总结)归到下播。pushId 借行 id —— 老行本来就一行一次推送。
 */
const LEGACY_SOURCE_TO_KIND: Record<string, PushKind> = {
	dynamic: "dynamic",
	live: "live",
	sc: "sc",
	guard: "guard",
	"special-danmaku": "special-danmaku",
	"special-enter": "special-enter",
	"live-summary": "live-end",
};

function migrateLegacyHistoryEntry(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const r = raw as Record<string, unknown>;
	if (!("source" in r) || "kind" in r) return raw;
	const result = r.result as { ok?: unknown; per?: unknown[] } | undefined;
	const per = result?.per?.[0] as { ok?: unknown; latencyMs?: unknown; err?: unknown } | undefined;
	const targetIds = Array.isArray(r.targetIds) ? r.targetIds : [];
	return {
		id: r.id,
		pushId: r.id,
		ts: r.ts,
		kind: LEGACY_SOURCE_TO_KIND[String(r.source)] ?? r.source,
		uid: r.uid,
		subscriptionId: r.subscriptionId,
		targetId: targetIds[0] ?? null,
		status: result?.ok === true ? "delivered" : "failed",
		messages: [
			{
				payload: r.payload,
				role: "main",
				result: per ? { ok: per.ok, latencyMs: per.latencyMs, err: per.err } : undefined,
			},
		],
		unameSnapshot: r.unameSnapshot,
		uavatarSnapshot: r.uavatarSnapshot,
	};
}

export const HistoryEntrySchema = z.preprocess(migrateLegacyHistoryEntry, HistoryEntryObjectSchema);

/**
 * 补丁行:同一次推送的后续消息(词云 / 总结 / 图集 / @全体)落地后追加在行后面,
 * 读时按 `patch`(行 id)并回去。jsonl 仍是 append-only。
 */
export const HistoryPatchSchema = z.object({
	patch: z.uuid(),
	status: PushStatusSchema,
	messages: z.array(HistoryMessageSchema),
});
export type HistoryPatch = z.infer<typeof HistoryPatchSchema>;
