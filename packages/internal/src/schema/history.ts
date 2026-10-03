import { z } from "zod";
import { PUSH_STATUSES } from "../constants";
import { FeatureKeySchema } from "./common";

/**
 * 一行历史的四态:
 * - delivered:全部消息都到了
 * - partial:本体到了,附加项(@全体 / 图集 / 词云 / 总结)或本体的后续分条没到
 * - failed:本体没到
 * - no-targets:这类推送没有任何可用目标(没配,或配的全停用),消息照记、没发出去
 */
export const PushStatusSchema = z.enum(PUSH_STATUSES);
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
export const PushMessageRoleSchema = z.enum(["main", "extra"]);
export type PushMessageRole = z.infer<typeof PushMessageRoleSchema>;

/** 一条消息对这个目标的投递结果。无目标行没有它。 */
export const HistoryMessageResultSchema = z.object({
	ok: z.boolean(),
	err: z.string().optional(),
	latencyMs: z.number().nonnegative(),
});
export type HistoryMessageResult = z.infer<typeof HistoryMessageResultSchema>;

export const HistoryMessageSchema = z.object({
	payload: HistoryPayloadSchema,
	role: PushMessageRoleSchema,
	result: HistoryMessageResultSchema.optional(),
	/**
	 * 这条是**哪一条的重投**(ADR-0017 决策 15):值是被补的那条消息在本行 `messages`
	 * 里的下标。人工重推追加进原行而不新开行,所以一行里会有同一条消息的好几次尝试;
	 * 序号就是稳定身份 —— 消息只按序追加,从不重排、从不删除。
	 *
	 * 缺省 = 这条不是重投,它自己就是一号。**不给默认值 0**:0 是本体那一号的合法身份,
	 * 填上去会让每条老消息都自称「我是第 0 条的重投」,整行的身份全塌成一个。
	 *
	 * 它同时是展开逐条时那个「第 N 次尝试」标记的来源,不用再开第二个字段。
	 */
	retryOf: z.number().int().nonnegative().optional(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

const HistoryEntryObjectSchema = z.object({
	/** 行 id。补丁行拿它认亲。 */
	id: z.uuid(),
	/** 推送 id:同一次推送落到几个目标就有几行,它们共用这一个。 */
	pushId: z.uuid(),
	/** 建行时刻(本体落地那一刻);后续追加不改它。 */
	ts: z.string(),
	/**
	 * 这一行是哪一类推送 —— 值就是特性键(⑬f 之前叫 `kind`,值是 0.x 自成一套的推送种类名;
	 * 老盘由 `apps/server/src/migration/history.ts` 改写)。补报记 `liveStart`、周期「正在直播」记 `liveStreaming`。
	 */
	feature: FeatureKeySchema,
	/**
	 * 这一行替谁发的(ADR-0019 决策 73):B 站行带 `uid`;拓展行带 `extensionId` + `externalId`、
	 * **不带 `uid`**。旧行只有 uid,读进来就是 B 站行。
	 *
	 * 不把外部 id 塞进 `uid`:它恰好是一串等于某个 B 站 uid 的数字时,订阅删掉之后重推与面板会按
	 * uid 把它认成那位 B 站 UP —— 静默认错人。
	 */
	uid: z.string().optional(),
	/** 拓展行:哪个拓展(一个拓展就是一个平台)。有它 + `externalId` 就是拓展行。 */
	extensionId: z.string().optional(),
	/** 拓展行:拓展给的那个人的外部 id,BN 不解读。 */
	externalId: z.string().optional(),
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
	 *
	 * 拓展行只有名字快照、**没有头像快照**(ADR-0019 决策 74):拓展的头像是面板里的相对地址,
	 * 订阅一删文件就没了,存下来就是删后裂图。
	 */
	unameSnapshot: z.string().optional(),
	uavatarSnapshot: z.string().optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntryObjectSchema>;

/**
 * 一行历史「是哪条订阅、替谁发的」那几格 —— 回找订阅(先认订阅、再认人)只看它们。
 * 有 `extensionId` + `externalId` 就是拓展行,否则是 B 站行(ADR-0019 决策 73)。
 */
export type HistoryRowIdentity = Pick<
	HistoryEntry,
	"subscriptionId" | "uid" | "extensionId" | "externalId"
>;

/**
 * 一行历史。0.x 的老行(一行 = 一个目标 × 一条消息,带 `source` / `result` / `payload`)由迁移器改写
 * (`apps/server/src/migration/history.ts`),这里只认现在的形状。
 */
export const HistoryEntrySchema = HistoryEntryObjectSchema;

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
