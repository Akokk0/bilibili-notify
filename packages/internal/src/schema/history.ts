import { z } from "zod";
import { IMAGE_REF_PATTERN, PUSH_STATUSES } from "../constants";
import { FeatureKeySchema } from "./common";
import { IdentitySchema } from "./subscriptions";

/**
 * 一行历史的四态:
 * - delivered:全部消息都到了
 * - partial:本体到了,附加项(@全体 / 图集 / 词云 / 总结)或本体的后续分条没到
 * - failed:本体没到
 * - no-targets:这类推送没有任何可用目标(没配,或配的全停用),消息照记、没发出去
 */
export const PushStatusSchema = z.enum(PUSH_STATUSES);
export type PushStatus = z.infer<typeof PushStatusSchema>;

/**
 * 图库引用(ADR-0022 决策 9):`<sha256>.<png|jpg|gif|webp>`。形状只此一份(`IMAGE_REF_PATTERN`),历史行、重推原件
 * 的图格都用它 —— 篡改或重放的 jsonl 带不进路径分隔符与 `..`,读口(`/api/images/<ref>`)另有一道。
 */
export const ImageRefSchema = z
	.string()
	.regex(IMAGE_REF_PATTERN, "必须是图库引用(<sha256>.<png|jpg|gif|webp>)");

export const HistoryPayloadSchema = z.object({
	kind: z.enum(["text", "image", "composite"]),
	text: z.string().optional(),
	/**
	 * 这条消息的配图,图库里的一张图(composite 只记第一张)。图库存不下(不是 png / jpg / gif / webp、超 8MB)或
	 * 已过保留期被迁移拿掉的,这一格缺着;面板据此(加上 `kind`)在原来画图的位置写「图已清理」或什么都不画。
	 */
	image: ImageRefSchema.optional(),
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
	repushOf: z.number().int().nonnegative().optional(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

const HistoryEntryObjectSchema = z.object({
	/** 行 id。补丁行拿它认亲。 */
	id: z.uuid(),
	/** 推送 id:同一次推送落到几个目标就有几行,它们共用这一个。 */
	pushId: z.uuid(),
	/** 建行时刻(本体落地那一刻);后续追加不改它。 */
	createdAt: z.string(),
	/**
	 * 这一行是哪一类推送 —— 值就是特性键(⑬f 之前叫 `kind`,值是 0.x 自成一套的推送种类名;
	 * 老盘由 `apps/server/src/migration/history.ts` 改写)。补报记 `liveStart`、周期「正在直播」记 `liveStreaming`。
	 */
	feature: FeatureKeySchema,
	/**
	 * 这一行替谁发的:来源键 + 来源那头的 id,和订阅同一种身份(ADR-0021 决策 14)。B 站行是
	 * `{ sourceKey: "bilibili", externalId: uid }`,拓展行是 `{ sourceKey: 拓展 id, externalId }`。回找订阅看这两格
	 * **一起**比,外部 id 恰好等于某个 B 站 uid 也不会被认成那位 B 站 UP(ADR-0019 决策 73 的本意)。
	 *
	 * 0.x 与 ⑱b 之前的行是三个散格(`uid` / `extensionId` / `externalId`),由迁移器并成这一格
	 * (`apps/server/src/migration/history.ts`)。
	 */
	identity: IdentitySchema,
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
	 * 头像快照只装图库引用(`ImageRef`),与 `nameSnapshot` 成对(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗):
	 * 拓展行写行时抄订阅资料里的 `avatar`(先续期,续不上就不写这一格);**B 站行这一格缺着** —— 服务端不抓
	 * B 站头像,抓图服务在 3a;面板退到订阅现在的头像、再退到首字。0.x 留下的远端网址迁移时丢掉。
	 * 它是图库的引用:保留期内的行才算引用方(过了水位线的行不再留住图),面板对过了保留期的行不用它。
	 */
	nameSnapshot: z.string().optional(),
	avatarSnapshot: ImageRefSchema.optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntryObjectSchema>;

/**
 * 一行历史「是哪条订阅、替谁发的」那两格 —— 回找订阅(先认订阅、再认人)只看它们:`subscriptionId` 还在就是它,
 * 不在了按 `identity` 的来源键 + 外部 id 一起比(ADR-0019 决策 73)。
 */
export type HistoryRowIdentity = Pick<HistoryEntry, "subscriptionId" | "identity">;

/**
 * 一行历史。0.x 的老行(一行 = 一个目标 × 一条消息,带 `source` / `result` / `payload`)由迁移器改写
 * (`apps/server/src/migration/history.ts`),这里只认现在的形状。
 */
export const HistoryEntrySchema = HistoryEntryObjectSchema;

/**
 * 补丁行:同一次推送的后续消息(词云 / 总结 / 图集 / @全体)落地后追加在行后面,
 * 读时按 `rowId`(行 id)并回去。jsonl 仍是 append-only。
 */
export const HistoryPatchSchema = z.object({
	rowId: z.uuid(),
	status: PushStatusSchema,
	messages: z.array(HistoryMessageSchema),
});
export type HistoryPatch = z.infer<typeof HistoryPatchSchema>;
