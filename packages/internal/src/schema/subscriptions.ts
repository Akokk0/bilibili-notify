import { z } from "zod";
// `extrasRecord` 直接从零依赖的词表取:它是内部工具,没必要跟着 EXTRA_KEYS 那批
// 一起经 ./common 重导出去撑大根入口的 API 面。
import { extrasRecord } from "../constants";
import { CardSkinIdSchema, CardSkinKnobOverridesSchema } from "./card-skin";
import {
	CardStyleByKindSchema,
	CardStylePartialSchema,
	ContentFiltersPartialSchema,
	EXTRA_KEYS,
	FEATURE_KEYS,
	FeatureFlagsPartialSchema,
	type FeatureKey,
	ImageGroupSettingsPartialSchema,
	PUSH_EXTRAS,
	ScheduleConfigPartialSchema,
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
 * `avatar` 按来源不同:B 站订阅是 B 站 CDN 的图链;拓展订阅是同源的相对地址
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
 * 决策 3:每把附加项的目标必须是它那把主特性目标的子集 —— 遍历注册表,加一把附加项
 * 不用来这儿补一条 refine。
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
 * **纯配置**:资料缓存与运行状态在 apps/server 的 SubRuntimeStore。未知键被剥掉(不是 strict)。
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
		extras: SubscriptionExtrasSchema.default(emptyExtras),
		overrides: SubscriptionOverridesSchema,
		/**
		 * 这位的单人锐评定时推送。
		 *
		 * 与 `specialUsers` 同类:per-UP 独有、**不参与 `resolve()` 折叠**,所以放顶层而不是 `overrides`。塞进
		 * overrides 的话它会去继承全局那条,而全局那条是**榜单**周报 —— 继承过来的 cron / targets 跟界面上显示的
		 * 对不上(ADR-0020 决策 14:两种来源都有)。
		 *
		 * UP 退订时这条配置跟着一起消失,不留孤儿调度。
		 */
		roastSchedule: RoastScheduleSchema.default(() => structuredClone(DEFAULT_ROAST_SCHEDULE)),
		/** 特别关注(ADR-0021 决策 17:公共形状);来源不支持的,这一格一直是空的。 */
		specialUsers: z.array(SpecialUserSchema).default([]),
	})
	.superRefine(refineExtrasWithinRouting);
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
		extras: emptyExtras(),
		overrides: {},
		// 新订阅不自带定时锐评 —— 加一个 UP 不该顺手给群里排一条周期推送。
		roastSchedule: structuredClone(DEFAULT_ROAST_SCHEDULE),
		specialUsers: [],
	};
}
