import { z } from "zod";
// `extrasRecord` 直接从零依赖的词表取:它是内部工具,没必要跟着 EXTRA_KEYS 那批
// 一起经 ./common 重导出去撑大根入口的 API 面。
import { extrasRecord, IMAGE_REF_PATTERN } from "../constants";
import { CardSkinIdSchema, CardSkinKnobOverridesSchema } from "./card-skin";
import {
	CardsOverridesSchema,
	ContentFiltersPartialSchema,
	EXTRA_KEYS,
	FEATURE_KEYS,
	FeatureFlagsPartialSchema,
	type FeatureKey,
	ImageGroupSettingsPartialSchema,
	LiveStartSettingsPartialSchema,
	LiveStreamingSettingsPartialSchema,
	MembershipSettingsPartialSchema,
	PUSH_EXTRAS,
	ScheduleConfigPartialSchema,
	SuperchatSettingsPartialSchema,
	TemplateBundlePartialSchema,
} from "./common";
import { ID_SEGMENT, isPrototypeName, prototypeNameMessage } from "./extension-manifest";
import { MessageLayoutSchema } from "./message-layout";
import { DEFAULT_ROAST_SCHEDULE, RoastScheduleSchema } from "./roast-schedule";

/**
 * 路由：每个特性 → PushTarget.id[]。空数组 = 该特性不推。
 * 用 record + 显式 keys 而不是 partial，便于 UI 始终展示所有特性的开关。
 */
const SubscriptionRoutingObjectSchema = z.object(
	Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.array(z.uuid())])) as {
		[K in FeatureKey]: z.ZodArray<z.ZodUUID>;
	},
);
export type SubscriptionRouting = z.infer<typeof SubscriptionRoutingObjectSchema>;

/**
 * 解析时按 feature 去重 target UUID。重复 UUID 会让同一 feature 对同一目标
 * 重复推送 + 重复 delivery 记录。用**幂等 transform**而非 refine:既归一化
 * 当前/历史数据,又不会让既有含重复项的持久化配置在 parse 时直接 reject。
 */
export const SubscriptionRoutingSchema = SubscriptionRoutingObjectSchema.transform((r) => {
	const out = {} as SubscriptionRouting;
	for (const k of FEATURE_KEYS) out[k] = [...new Set(r[k])];
	return out;
});

/**
 * 订阅的资料缓存，用于 UI 与卡片显示。non-authoritative。
 *
 * **不内嵌于 Subscription**（高频资料写入会污染配置写路径）。独立端持久化到
 * SubscriptionStateStore（`<dataDir>/runtime/subscription-state.json`），`/api/subscriptions` join 回来。
 *
 * `followers` 可缺：拓展订阅的资料不一定知道粉丝数，缺了不能补成 0。`bio` 是空串时按缺键处理。
 * `avatar` 只装图库引用，远端头像网址住 B 站自己的集成状态，不在核心资料缓存里。
 * `fanClubName` 是粉丝团名（B 站填粉丝牌名），平台没有就缺键，模板变量 `{fanclub}` 取它。
 */
export const CreatorProfileSchema = z.object({
	name: z.string(),
	avatar: z.string().regex(IMAGE_REF_PATTERN).optional(),
	bio: z.string().optional(),
	followers: z.number().int().min(0).optional(),
	fanClubName: z.string().optional(),
	refreshedAt: z.string(),
});
export type CreatorProfile = z.infer<typeof CreatorProfileSchema>;

/**
 * AI 覆盖 —— per-UP 只做一件事:**从 `GlobalConfig.ai.presets` 里挑一份**。
 *
 * `preset` 是**指针**:指向 presets 里的一份。指不着就完整继承全局 —— 老值 `'inherit'`
 * (当年那档「继承全局」)、`'custom'`(当年那档「完全自定义」)、以及指向一份已被删掉
 * 的人格,三者在 `resolveSubscriptionPersona` 里殊途同归。
 *
 * 当年「完全自定义」写在这里的 `persona` / `dynamicPrompt` / `liveSummaryPrompt` 已经
 * 不在 schema 里(它们后来只为 koishi 插件那一侧留着):人格一律在「智能女仆」页里写,
 * per-UP 只负责挑一份。per-UP 的 `temperature` 也已退役(请求里一律不发、走服务商默认)。
 * 盘上残留的旧字段在解析时被丢弃(裸 z.object,未知键 strip,不会整份拒收),设置页
 * 保存时也会显式清掉(见 apps/web PerUpEditor 的 `pickAiOverride`)。
 *
 * ## 为什么 preset 是裸 string
 *
 * 单 schema:preset 取何值都允许。写成 z.union 会让 TS 在「具名 id vs 那两个历史常量」
 * 之间 narrowing 失败。
 */
export const AIOverrideSchema = z.object({
	preset: z.string(),
});
export type AIOverride = z.infer<typeof AIOverrideSchema>;

/**
 * 附加项的 **per-目标** 覆写表(ADR-0016 决策 2 的第三层),订阅顶层的 `extraTargets`。每把附加项一张 Map,三态:
 * - Map 里没有 key → inherit(走 per-UP / 全局那两层,即 `features.extras[key]`)
 * - `extraTargets.X[targetId] = true` → 强制 ON
 * - `extraTargets.X[targetId] = false` → 强制 OFF
 *
 * 约束:Map 的 key 必须出现在 `routing[PUSH_EXTRAS[key].feature]` 里 —— 能收附加项的,
 * 必须先收得到本体(决策 3)。由 SubscriptionSchema 的 superRefine 强制,违反的旧数据
 * parse 时报错。
 *
 * 作用范围:
 * - `atAllPost`:过了过滤器的作品都 @(任意作品类型)
 * - `atAllLiveStart`:仅作用于 LivePushType.StartBroadcasting(真开播;重启补报与周期「正在直播」都不 @),不冲 liveEnd / SC / 上舰 / 词云 / AI 总结
 * - `wordcloud` / `liveSummary`:下播那次推送的两条后续消息
 */
export const SubscriptionExtraTargetsSchema = z.object(
	extrasRecord(() => z.record(z.uuid(), z.boolean()).default({})),
);
export type SubscriptionExtraTargets = z.infer<typeof SubscriptionExtraTargetsSchema>;

/** 一张全空的 per-目标 三态表:四把键各一个空 Map = 每个目标都跟随上一层。 */
function emptyExtraTargets(): SubscriptionExtraTargets {
	return extrasRecord(() => ({}));
}

/**
 * 单 UP 的覆盖配置；任意字段为 undefined 表示继承 GlobalConfig.defaults。
 */
export const SubscriptionOverridesSchema = z.object({
	features: FeatureFlagsPartialSchema.optional(),
	filters: ContentFiltersPartialSchema.optional(),
	schedule: ScheduleConfigPartialSchema.optional(),
	liveStart: LiveStartSettingsPartialSchema.optional(),
	liveStreaming: LiveStreamingSettingsPartialSchema.optional(),
	// 醒目留言与会员的门槛覆盖(㉓d):`superchat.minAmount` 覆盖有就用覆盖(0 也算);`membership.minRank` 按体系逐键合并。
	superchat: SuperchatSettingsPartialSchema.optional(),
	membership: MembershipSettingsPartialSchema.optional(),
	templates: TemplateBundlePartialSchema.optional(),
	ai: AIOverrideSchema.optional(),
	// 卡片设置的覆盖(㉔e):只有直播封面能按订阅覆盖。
	cards: CardsOverridesSchema.optional(),
	// 这个 UP 单独用哪套卡片皮肤(ADR-0014 决策 17:per-UP = 选皮肤 + 变量覆盖,不再
	// 有版式补丁)。缺 = 跟全局。
	cardSkin: CardSkinIdSchema.optional(),
	/**
	 * 这个 UP 单独拧过的**皮肤旋钮**,按皮肤 id 分(ADR-0014 决策 17 的 🔗,2026-09-24)——
	 * 与 `globals.defaults.cardSkinKnobs` 同形、同一条「存覆盖不存值」。
	 *
	 * 出图时**逐枚**叠在全局那份上(per-UP 拧过的 → 全局拧过的 → 皮肤兜底),只认这位 UP
	 * 实际用的那套皮肤那一格:换皮肤再换回来,拧过的还在。不分卡种,这位 UP 的每种卡吃同一份。
	 *
	 * **不带 `.default`**:缺 = 一枚都没单独拧;面板「全部还原」下发整份 null 删掉它,带了
	 * default 的话删完又长回一个空对象,读起来像「这位 UP 设置过什么」。
	 */
	cardSkinKnobs: z.record(CardSkinIdSchema, CardSkinKnobOverridesSchema).optional(),
	// 消息版式同 cardLayout:数组型描述符,per-UP 一旦自定义即整份覆盖。
	messageLayout: MessageLayoutSchema.optional(),
	imageGroup: ImageGroupSettingsPartialSchema.optional(),
});
export type SubscriptionOverrides = z.infer<typeof SubscriptionOverridesSchema>;

/**
 * 决策 3:每把附加项的目标必须是它那把主特性目标的子集 —— 遍历注册表,加一把附加项
 * 不用来这儿补一条 refine。
 */
function refineExtraTargetsWithinRouting(
	s: { routing: SubscriptionRouting; extraTargets: SubscriptionExtraTargets },
	ctx: z.RefinementCtx,
): void {
	for (const key of EXTRA_KEYS) {
		const feature = PUSH_EXTRAS[key].feature;
		if (Object.keys(s.extraTargets[key]).every((t) => s.routing[feature].includes(t))) continue;
		ctx.addIssue({
			code: "custom",
			message: `extraTargets.${key} keys must be a subset of routing.${feature}`,
			path: ["extraTargets", key],
		});
	}
}

/**
 * 订阅来源的键(`bilibili` 或拓展 id,不加前缀)在盘上的写法:和拓展 id 同一种 id 形状。不排除保留 id ——
 * `bilibili` 本身就是一个来源;拓展 id 不许用保留 id 由 `ExtensionIdSchema` 管。
 */
export const SourceKeySchema = z
	.string()
	.max(64)
	.regex(
		new RegExp(`^${ID_SEGMENT}(?:\\.${ID_SEGMENT})?$`),
		"来源键只能是小写字母、数字与连字符(可用一个点分出命名空间)",
	)
	// 同拓展 id:来源键也会被拿去当键用。
	.refine((key) => !isPrototypeName(key), prototypeNameMessage("来源键 "));

/**
 * 外部 id 的长度上限(字数)。BN 不解读它,封顶只为挡住一坨巨大的字符串进配置;抖音的 `sec_uid` 七十多个字。
 * 解析门交回的候选 `id` 就是将来的外部 id,用的是同一把尺子。
 */
export const EXTERNAL_ID_MAX = 256;

/**
 * 特别关注名单里一个条目能带的特性键(`viewerChat` / `viewerEnter`)。用 `satisfies` 钉在 {@link FEATURE_KEYS} 上:
 * 特性键改名,这里编译不过。
 */
const SPECIAL_VIEWER_FEATURES = [
	"viewerChat",
	"viewerEnter",
] as const satisfies readonly FeatureKey[];

/**
 * 特别关注名单的一个条目(ADR-0021 决策 17:公共形状;条目属于哪个平台由所挂的订阅决定):
 * 名单上的人在这条订阅的直播间里说话 / 进场,带着对应特性的就触发特别关注的推送。
 *
 * - `id`:观众在来源那头的 id,中立 —— 只限非空、限长,合不合来源声明的格式(比如 B 站的 uid 是数字)
 *   由写名单的那条路按来源描述符核(同 {@link IdentitySchema} 的 `externalId`),盘上已有的不回头核;
 * - `note`:主人自己记的备注,没人读;
 * - `features`:这个人触发哪几种,至少一种。
 */
export const SpecialViewerSchema = z.object({
	id: z.string().min(1).max(EXTERNAL_ID_MAX),
	note: z.string().optional(),
	features: z.array(z.enum(SPECIAL_VIEWER_FEATURES)).min(1),
});
export type SpecialViewer = z.infer<typeof SpecialViewerSchema>;

/** 订阅订的是谁(ADR-0021 决策 14):来源 + 来源那头的 id。判重看这两格是否都相等。 */
export const IdentitySchema = z
	.object({
		sourceKey: SourceKeySchema,
		/** 来源那头的 id,BN 不解读、原样交回;合不合来源的规矩(比如 B 站的 uid 是数字)由新建订阅那条路核。 */
		externalId: z.string().min(1).max(EXTERNAL_ID_MAX),
	})
	.strict();

/**
 * 订阅标签(ADR-0034):主人自己建的一份表,订阅只记 id。顺序就是表里的顺序;名字去掉首尾空白后
 * 不许为空、不许重名(重名的话,打错一个字多出一个分组那种老毛病就换个样子回来了)。
 */
export const SubscriptionTagSchema = z
	.object({
		id: z.uuid(),
		name: z.string().trim().min(1, "标签名不能是空的"),
	})
	.strict();
export type SubscriptionTag = z.infer<typeof SubscriptionTagSchema>;

/** 整张标签表:id 与名字都不许重复。 */
export const SubscriptionTagListSchema = z.array(SubscriptionTagSchema).superRefine((tags, ctx) => {
	const ids = new Set<string>();
	const names = new Set<string>();
	tags.forEach((tag, i) => {
		if (ids.has(tag.id)) {
			ctx.addIssue({ code: "custom", path: [i, "id"], message: `标签 id ${tag.id} 重复了` });
		}
		if (names.has(tag.name)) {
			ctx.addIssue({
				code: "custom",
				path: [i, "name"],
				message: `已经有一个叫「${tag.name}」的标签了`,
			});
		}
		ids.add(tag.id);
		names.add(tag.name);
	});
});

/**
 * 一条订阅(ADR-0021 决策 14、15):B 站与拓展同一种形状,盘上同一个文件 `config/subscriptions.json`,行行带
 * `identity`。订的是谁只看 `identity`;来源支不支持某项能力(特别关注、关注同步……)看来源,不看这一行。
 *
 * **纯配置**:资料缓存与运行状态在 apps/server 的 SubscriptionStateStore。未知键被剥掉(不是 strict)。
 */
export const SubscriptionSchema = z
	.object({
		id: z.uuid(),
		identity: IdentitySchema,
		enabled: z.boolean(),
		/** 挂的标签,`SubscriptionTag` 的 id(ADR-0034);只许挂标签表里有的,写盘那一层核。 */
		tagIds: z.array(z.uuid()).default([]),
		notes: z.string().optional(),
		routing: SubscriptionRoutingSchema,
		extraTargets: SubscriptionExtraTargetsSchema.default(emptyExtraTargets),
		overrides: SubscriptionOverridesSchema,
		/**
		 * 这位的单人锐评定时推送。
		 *
		 * 与 `specialViewers` 同类:per-UP 独有、**不参与 `resolve()` 折叠**,所以放顶层而不是 `overrides`。塞进
		 * overrides 的话它会去继承全局那条,而全局那条是**榜单**周报 —— 继承过来的 cron / targets 跟界面上显示的
		 * 对不上(ADR-0020 决策 14:两种来源都有)。
		 *
		 * UP 退订时这条配置跟着一起消失,不留孤儿调度。
		 */
		roastSchedule: RoastScheduleSchema.default(() => structuredClone(DEFAULT_ROAST_SCHEDULE)),
		/** 特别关注(ADR-0021 决策 17:公共形状);来源不支持的,这一格一直是空的。 */
		specialViewers: z.array(SpecialViewerSchema).default([]),
	})
	.superRefine(refineExtraTargetsWithinRouting);
export type Subscription = z.infer<typeof SubscriptionSchema>;

/** 工厂:创建一个完全继承全局默认的空订阅(routing 全空、overrides 全 undefined)。 */
export function makeEmptySubscription(opts: {
	id: string;
	identity: Subscription["identity"];
}): Subscription {
	const emptyRouting = Object.fromEntries(
		FEATURE_KEYS.map((k) => [k, [] as string[]]),
	) as SubscriptionRouting;
	return {
		id: opts.id,
		identity: { ...opts.identity },
		enabled: true,
		tagIds: [],
		notes: undefined,
		routing: emptyRouting,
		extraTargets: emptyExtraTargets(),
		overrides: {},
		// 新订阅不自带定时锐评 —— 加一个 UP 不该顺手给群里排一条周期推送。
		roastSchedule: structuredClone(DEFAULT_ROAST_SCHEDULE),
		specialViewers: [],
	};
}
