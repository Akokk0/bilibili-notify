import { z } from "zod";
// `extrasRecord` 直接从零依赖的词表取:它是内部工具,没必要跟着 EXTRA_KEYS 那批
// 一起经 ./common 重导出去撑大根入口的 API 面。
import { extrasRecord } from "../constants";
import { isPlainObject } from "../util/plain-object";
import { CardSkinIdSchema, CardSkinKnobOverridesSchema } from "./card-skin";
import {
	CardStyleByKindSchema,
	CardStylePartialSchema,
	ContentFiltersPartialSchema,
	EXTRA_KEYS,
	type ExtraKey,
	FEATURE_KEYS,
	FeatureFlagsPartialSchema,
	type FeatureKey,
	ImageGroupSettingsPartialSchema,
	migrateLegacyFeatureFlagsPartial,
	PUSH_EXTRAS,
	ScheduleConfigPartialSchema,
	TemplateBundlePartialSchema,
} from "./common";
import { ExtensionIdSchema } from "./extension-manifest";
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
 * 第一代 routing 的形状:词云 / 总结曾各是一把特性键、各有一份目标列表。迁成
 * 「下播目标 = 下播 ∪ 词云 ∪ 总结」(保序:先下播、再词云、再总结;去重交给下面的
 * transform),老键不留。新形状(没这两把键)原样过。
 *
 * 键表私有:与 schema/common.ts 那份同理 —— 「下播的两个附加项」已经退役成 `extras` 里
 * 的两行,这两个名字今天只剩认老数据这一个用处。
 */
const LEGACY_ROUTING_KEYS = ["wordcloud", "liveSummary"] as const;

function isLegacyRouting(raw: unknown): raw is Record<string, unknown> {
	return typeof raw === "object" && raw !== null && LEGACY_ROUTING_KEYS.some((k) => k in raw);
}

function migrateLegacyRouting(raw: unknown): unknown {
	if (!isLegacyRouting(raw)) return raw;
	const { wordcloud, liveSummary, ...rest } = raw;
	const lists = [rest.liveEnd, wordcloud, liveSummary].filter(Array.isArray);
	return { ...rest, liveEnd: lists.flat() };
}

/** @全体 那两把附加项当年住在订阅上,按 scope 存 —— `atAll.<scope>` / `atAllDefaults.<scope>`。 */
const LEGACY_AT_ALL_SCOPES = [
	["dynamic", "atAllDynamic"],
	["live", "atAllLive"],
] as const satisfies ReadonlyArray<readonly [string, ExtraKey]>;

/**
 * 整条老订阅的迁移,两件事:
 *
 * 1. **第一代的 features 覆盖**。routing 自己认得出新老(见 {@link migrateLegacyRouting});
 *    `overrides.features` 单看分不出 —— `{ liveEnd: false }` 在第一代与新形状里长得一样,
 *    含义却不同:第一代只关了下播卡(词云 / 总结照收),新的是整个下播都关。所以 routing
 *    是第一代就把这份覆盖也按老规矩迁(`force`),别让那位 UP 的词云 / 总结跟着没了。
 *
 * 2. **@全体 并进附加项**(ADR-0016 决策 2)。`atAll.<scope>` 是 per-目标 三态表,1:1 搬到
 *    `extras.atAll<Scope>`;`atAllDefaults.<scope>` 是 per-UP 的值,搬进 per-UP 覆盖层。
 *    ⚠️ `atAllDefaults` 是必填带默认的,**老数据里人人都有** —— 等于出厂默认就不写,
 *    否则每条订阅都会凭空长出一份无意义的 per-UP 覆盖。
 *
 * 新形状(没有 `atAll` / `atAllDefaults`)这两件事都不做。
 */
function migrateLegacySubscription(raw: unknown): unknown {
	if (!isPlainObject(raw)) return raw;
	const sub = raw;
	const legacyRouting = isLegacyRouting(sub.routing);
	const atAll = isPlainObject(sub.atAll) ? sub.atAll : undefined;
	const atAllDefaults = isPlainObject(sub.atAllDefaults) ? sub.atAllDefaults : undefined;
	if (!legacyRouting && !atAll && !atAllDefaults) return raw;

	const overrides = isPlainObject(sub.overrides) ? sub.overrides : undefined;
	// features 覆盖先就地归一(第一代要 force,第二代只改名),@全体 的默认值再往上加 ——
	// 否则那个 preprocess 后跑,会拿老形状重算一遍 `extras` 把刚写进去的 @全体 抹掉。
	let features =
		overrides?.features === undefined
			? undefined
			: migrateLegacyFeatureFlagsPartial(overrides.features, legacyRouting);

	const perUpDefaults: Record<string, unknown> = {};
	for (const [scope, key] of LEGACY_AT_ALL_SCOPES) {
		const value = atAllDefaults?.[scope];
		if (typeof value !== "boolean" || value === PUSH_EXTRAS[key].default) continue;
		perUpDefaults[key] = value;
	}
	if (Object.keys(perUpDefaults).length > 0) {
		const base = isPlainObject(features) ? features : {};
		const baseExtras = isPlainObject(base.extras) ? base.extras : {};
		features = { ...base, extras: { ...baseExtras, ...perUpDefaults } };
	}

	const { atAll: _a, atAllDefaults: _d, ...rest } = sub;
	const out: Record<string, unknown> = { ...rest };
	if (features !== undefined) out.overrides = { ...(overrides ?? {}), features };

	if (atAll) {
		const extras = isPlainObject(sub.extras) ? { ...sub.extras } : {};
		for (const [scope, key] of LEGACY_AT_ALL_SCOPES) {
			if (scope in atAll) extras[key] = atAll[scope];
		}
		out.extras = extras;
	}
	return out;
}

/**
 * 解析时按 feature 去重 target UUID。重复 UUID 会让同一 feature 对同一目标
 * 重复推送 + 重复 delivery 记录。用**幂等 transform**而非 refine:既归一化
 * 当前/历史数据,又不会让既有含重复项的持久化配置在 parse 时直接 reject。
 */
export const SubscriptionRoutingSchema = z
	.preprocess(migrateLegacyRouting, SubscriptionRoutingObjectSchema)
	.transform((r) => {
		const out = {} as SubscriptionRouting;
		for (const k of FEATURE_KEYS) out[k] = [...new Set(r[k])];
		return out;
	});

/**
 * 缓存的 UP 主档案，用于 UI 显示。non-authoritative。
 *
 * **不再内嵌于 Subscription**（高频 fans/lastRefreshedAt 写入会污染配置写路径）。
 * 独立端持久化到 apps/server 的 SubRuntimeStore（`<dataDir>/state/sub-runtime.json`）；
 * schema/type 仍导出,供 SubRuntimeStore + `/api/subs` join 复用。
 *
 * `fans` 可缺:拓展订阅的候选 / 资料不一定知道粉丝数(ADR-0019 决策 52 的 `fans?`),缺了写成 0
 * 就是在面板上印一句「0 粉丝」的假话。B 站那支照旧总有。`sub-runtime.json` 读盘是裸
 * `JSON.parse`、不过这份 schema,所以旧载荷读到缺这一格的条目也照常开机。
 *
 * `avatar` 两支不同:B 站订阅是 B 站 CDN 的图链;拓展订阅是同源的相对地址
 * `/api/subs/<id>/avatar?v=<摘要>`(决策 49,头像存成文件),没有就是空串。
 */
export const CachedProfileSchema = z.object({
	name: z.string(),
	avatar: z.string(),
	sign: z.string(),
	fans: z.number().int().min(0).optional(),
	lastRefreshedAt: z.string(),
});
export type CachedProfile = z.infer<typeof CachedProfileSchema>;

/**
 * 特别关注用户：进房 / 弹幕 触发自定义模板推送。
 */
export const SpecialUserSchema = z.object({
	// P2:与 Subscription.uid 同约束 —— 此前裸 z.string() 放任非数字脏值,
	// 进入 includes(uid.toString()) 比对永不命中,特别关注静默失效无报错。
	uid: z.string().regex(/^\d+$/, "uid must be a numeric Bilibili UID string"),
	kinds: z.array(z.enum(["enter", "danmaku"])).min(1),
	template: z.string().optional(),
});
export type SpecialUser = z.infer<typeof SpecialUserSchema>;

/**
 * AI 覆盖 —— per-UP 只做一件事:**从 `GlobalConfig.defaults.ai.presets` 里挑一份**。
 *
 * `preset` 是**指针**:指向 presets 里的一份。指不着就完整继承全局 —— 老值 `'inherit'`
 * (当年那档「继承全局」)、`'custom'`(当年那档「完全自定义」)、以及指向一份已被删掉
 * 的人格,三者在 `resolveAI` 里殊途同归。
 *
 * 当年「完全自定义」写在这里的 `persona` / `dynamicPrompt` / `liveSummaryPrompt` 已经
 * 不在 schema 里(它们后来只为 koishi 插件那一侧留着):人格一律在「智能女仆」页里写,
 * per-UP 只负责挑一份。盘上残留的旧字段在解析时被丢弃,设置页保存时也会显式清掉
 * (见 apps/web PerUpEditor 的 `pickAiOverride`)。
 *
 * ## 为什么 preset 是裸 string
 *
 * 单 schema:preset 取何值都允许。写成 z.union 会让 TS 在「具名 id vs 那两个历史常量」
 * 之间 narrowing 失败。
 */
export const AIOverrideSchema = z.object({
	preset: z.string(),
	temperature: z.number().min(0).max(2).optional(),
});
export type AIOverride = z.infer<typeof AIOverrideSchema>;

/**
 * 附加项的 **per-目标** 覆写表(ADR-0016 决策 2 的第三层)。每把附加项一张 Map,三态:
 * - Map 里没有 key → inherit(走 per-UP / 全局那两层,即 `features.extras[key]`)
 * - `extras.X[targetId] = true` → 强制 ON
 * - `extras.X[targetId] = false` → 强制 OFF
 *
 * 约束:Map 的 key 必须出现在 `routing[PUSH_EXTRAS[key].feature]` 里 —— 能收附加项的,
 * 必须先收得到本体(决策 3)。由 SubscriptionSchema 的 superRefine 强制,违反的旧数据
 * parse 时报错。
 *
 * 作用范围:
 * - `atAllDynamic`:过了过滤器的动态都 @(任意动态类型)
 * - `atAllLive`:仅作用于 LivePushType.Live(开播),不冲 liveEnd / SC / 上舰 / 词云 / AI 总结
 * - `wordcloud` / `liveSummary`:下播那次推送的两条后续消息
 */
export const SubscriptionExtrasSchema = z.object(
	extrasRecord(() => z.record(z.uuid(), z.boolean()).default({})),
);
export type SubscriptionExtras = z.infer<typeof SubscriptionExtrasSchema>;

/** 一张全空的 per-目标 三态表:四把键各一个空 Map = 每个目标都跟随上一层。 */
function emptyExtras(): SubscriptionExtras {
	return extrasRecord(() => ({}));
}

/**
 * 单 UP 的覆盖配置；任意字段为 undefined 表示继承 GlobalConfig.defaults。
 */
export const SubscriptionOverridesSchema = z.object({
	features: FeatureFlagsPartialSchema.optional(),
	filters: ContentFiltersPartialSchema.optional(),
	schedule: ScheduleConfigPartialSchema.optional(),
	templates: TemplateBundlePartialSchema.optional(),
	ai: AIOverrideSchema.optional(),
	cardStyle: CardStylePartialSchema.optional(),
	// 按卡片类型的样式覆盖(可选);叠在该 UP 的 cardStyle 基准之上。见 resolveCardStyleForKind。
	cardStyleByKind: CardStyleByKindSchema.optional(),
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
 * fans 时序的「订阅起点」基线。FansPoller 第一次给该订阅取到 fans 值时写入,
 * 此后永不变。24h / 7d 的 delta 由后端读取 fans jsonl 时序计算,不在 schema 中。
 */
export const FansBaselineSchema = z.object({
	value: z.number().int().min(0),
	ts: z.string(),
});
export type FansBaseline = z.infer<typeof FansBaselineSchema>;

/**
 * 运行时状态。**不再内嵌于 Subscription**——只有 fansBaseline 有真实写入方
 * (FansPoller)，其余字段全仓零写入方。fansBaseline 现由 apps/server 的
 * SubRuntimeStore 持久化；schema/type 保留导出仅为类型复用与向后兼容。
 */
export const SubscriptionStateSchema = z.object({
	lastDynamicId: z.string().optional(),
	lastPushedAt: z.object({
		dynamic: z.string().optional(),
		live: z.string().optional(),
	}),
	liveStatus: z.enum(["idle", "live", "unknown"]),
	fansBaseline: FansBaselineSchema.optional(),
});
export type SubscriptionState = z.infer<typeof SubscriptionStateSchema>;

/**
 * 决策 3:每把附加项的目标必须是它那把主特性目标的子集 —— 遍历注册表,加一把附加项
 * 不用来这儿补一条 refine。两支订阅共用这一条。
 */
function refineExtrasWithinRouting(
	s: { routing: SubscriptionRouting; extras: SubscriptionExtras },
	ctx: z.RefinementCtx,
): void {
	for (const key of EXTRA_KEYS) {
		const feature = PUSH_EXTRAS[key].feature;
		if (Object.keys(s.extras[key]).every((t) => s.routing[feature].includes(t))) continue;
		ctx.addIssue({
			code: "custom",
			message: `extras.${key} keys must be a subset of routing.${feature}`,
			path: ["extras", key],
		});
	}
}

/**
 * **B 站订阅**(ADR-0019 决策 9:「B 站那支一个字不动」)。
 * id 与 uid 分离：id 是 dashboard 内部稳定标识；uid 是 B 站用户 ID。
 *
 * **纯配置**：展示缓存 `cachedProfile` 与运行时 `state` 已外置到 apps/server 的
 * SubRuntimeStore（见 CachedProfileSchema / SubscriptionStateSchema 注释）。Zod
 * 默认 strip 未知键——旧 subscriptions.json 内嵌的这两个字段 load 时自动剥离。
 *
 * `kind` 只活在内存与线上(决策 47):盘上 `subscriptions.json` 的行**没有**这一格 —— 旧载荷
 * 写的就是这个形状,写回时由 ConfigStore 剥掉。所以读的时候缺了就是 B 站。其余键的顺序别动:
 * 剥掉 `kind` 之后,写出来的行与旧载荷写的一字不差。
 */
const BiliSubscriptionObjectSchema = z
	.object({
		kind: z.literal("bilibili").default("bilibili"),
		id: z.uuid(),
		uid: z.string().regex(/^\d+$/, "uid must be a numeric Bilibili UID string"),
		/** 用户手填的 UP 昵称 / 别名。不同于 cachedProfile.name(平台实时资料缓存)。 */
		name: z.string().optional(),
		enabled: z.boolean(),
		groups: z.array(z.string()).default([]),
		notes: z.string().optional(),
		routing: SubscriptionRoutingSchema,
		extras: SubscriptionExtrasSchema.default(emptyExtras),
		overrides: SubscriptionOverridesSchema,
		/**
		 * 这位 UP 的单人锐评定时推送。
		 *
		 * 与 `specialUsers` 同类:per-UP 独有、**不参与 `resolve()` 折叠**,所以放
		 * 顶层而不是 `overrides`。塞进 overrides 的话它会去继承全局那条,而全局那
		 * 条是**榜单**周报 —— 继承过来的 cron / targets 跟界面上显示的对不上。
		 *
		 * UP 退订时这条配置跟着一起消失,不留孤儿调度。
		 */
		roastSchedule: RoastScheduleSchema.default(DEFAULT_ROAST_SCHEDULE),
		specialUsers: z.array(SpecialUserSchema).default([]),
	})
	.superRefine(refineExtrasWithinRouting);
export const BiliSubscriptionSchema = z.preprocess(
	migrateLegacySubscription,
	BiliSubscriptionObjectSchema,
);
export type BiliSubscription = z.infer<typeof BiliSubscriptionObjectSchema>;

/**
 * 外部 id 的长度上限(字数)。BN 不解读它(决策 9),封顶只为挡住一坨巨大的字符串进配置;
 * 抖音的 `sec_uid` 七十多个字。解析门交回的候选 `id` 就是将来的外部 id,用的是同一把尺子。
 */
export const EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX = 256;

/**
 * **拓展订阅**(ADR-0019 决策 9 / 47):住 `extension-subscriptions.json`,不进 `subscriptions.json`。
 *
 * - **身份** = `(extensionId, externalId)`(决策 50):`extensionId` 由 BN 填(请求来自哪个拓展),
 *   `externalId` 是拓展给的不透明字符串,BN 原样交回、从不解读。
 * - **不带 `uid`** —— 连 `uid?: never` 都不写:键不在,编译器才会把每一处直接读 `sub.uid`
 *   的地方列出来逐个分流,「遍历订阅去 B 站拉资料」这类循环不会拿别的平台的 id 去问 B 站。
 * - **没有特别关注**(决策 12:B 站专属)。**单人定时锐评有**(ADR-0020 决策 14 推翻了决策 12 里锐评那一半):
 *   与 B 站那一格同形、同默认;老的 `extension-subscriptions.json` 没有这一格,读进来补出厂默认(关着)。
 */
export const ExtensionSubscriptionSchema = z
	.object({
		kind: z.literal("extension"),
		id: z.uuid(),
		extensionId: ExtensionIdSchema,
		externalId: z.string().min(1).max(EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX),
		/** 用户手填的别名。不同于 cachedProfile.name(拓展报来的资料缓存)。 */
		name: z.string().optional(),
		enabled: z.boolean(),
		groups: z.array(z.string()).default([]),
		notes: z.string().optional(),
		routing: SubscriptionRoutingSchema,
		extras: SubscriptionExtrasSchema.default(emptyExtras),
		overrides: SubscriptionOverridesSchema,
		/** 这位的单人锐评定时推送 —— 同 B 站那一格(放顶层、不参与 `resolve()` 折叠的理由也同)。 */
		roastSchedule: RoastScheduleSchema.default(DEFAULT_ROAST_SCHEDULE),
	})
	.superRefine(refineExtrasWithinRouting);
export type ExtensionSubscription = z.infer<typeof ExtensionSubscriptionSchema>;

/**
 * 一条订阅:B 站的或拓展的。内存里只有这一份联合列表(决策 47),读任何一支独有的字段
 * (`uid` / `specialUsers` / `extensionId` …)之前先按 `kind` 收窄。`roastSchedule` 两支都有(ADR-0020 决策 14)。
 */
export type Subscription = BiliSubscription | ExtensionSubscription;

/**
 * 联合那一份的解析:**按 `kind` 分派**,而不是 `z.union` 挨个试 —— 挨个试的话一行坏掉的
 * B 站订阅会报出两份错(另一支的「kind 不对」混在里面)。`kind === "extension"` 走拓展那支,
 * 其余(包括没有 `kind` 的老行)走 B 站那支;认不得的 `kind` 由 B 站那支的字面量报错。
 *
 * 不用 `z.discriminatedUnion`:B 站那支的 `kind` 可以缺,且它前面还挂着老数据迁移的 preprocess。
 */
export const SubscriptionSchema = z.unknown().transform((raw, ctx): Subscription => {
	const r =
		isPlainObject(raw) && raw.kind === "extension"
			? ExtensionSubscriptionSchema.safeParse(raw)
			: BiliSubscriptionSchema.safeParse(raw);
	if (r.success) return r.data;
	// 原样转交那一支的错:路径、代码、文案都不变(外层数组 / 对象照常往前补路径)。
	// 断言只是因为「解析完的 issue」与「待登记的 issue」在 zod 里是两个类型,字段是同一套。
	for (const issue of r.error.issues) ctx.addIssue(issue as z.core.$ZodRawIssue);
	return z.NEVER;
});

/** 工厂：创建一个完全继承全局默认的空 B 站订阅（routing 全空、overrides 全 undefined）。 */
export function makeEmptySubscription(opts: { id: string; uid: string }): BiliSubscription {
	const emptyRouting = Object.fromEntries(
		FEATURE_KEYS.map((k) => [k, [] as string[]]),
	) as SubscriptionRouting;
	return {
		kind: "bilibili",
		id: opts.id,
		uid: opts.uid,
		name: undefined,
		enabled: true,
		groups: [],
		notes: undefined,
		routing: emptyRouting,
		extras: emptyExtras(),
		overrides: {},
		// 新订阅不自带定时锐评 —— 加一个 UP 不该顺手给群里排一条周期推送。
		roastSchedule: { ...DEFAULT_ROAST_SCHEDULE },
		specialUsers: [],
	};
}
