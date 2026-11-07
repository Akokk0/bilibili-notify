import { packageText } from "./texts/index";
/**
 * 订阅特性与附加项词表 —— 哪些事件能单独开关、每个附加项跟着谁走、出厂值是什么。
 *
 * 零依赖:只许 `import type`,值级 import 只能指向零依赖名单里的同伴。
 * 面板与 contract 经 `@bilibili-notify/internal/features` 取值。
 */

/**
 * 全部可订阅的特性键 —— 每一把都是一类**能单独开关、能配路由**的推送。新增或删除会扩散到
 * FeatureFlags、SubscriptionRouting、Subscription.overrides。
 *
 * 附加项(@全体 / 词云 / AI 总结)不在这里:它们各自挂在某把主特性下面(见
 * {@link PUSH_EXTRAS}),跟着那把特性的开关与目标走,自己没有路由。
 */
export const FEATURE_KEYS = [
	"post",
	"liveStart",
	"liveStreaming",
	"liveEnd",
	"membership",
	"superchat",
	"viewerChat",
	"viewerEnter",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** 第 3 版拓展订阅源能声明的特性;顺序与 {@link FEATURE_KEYS} 一致。 */
export const EXTENSION_SOURCE_FEATURES = [
	"post",
	"liveStart",
	"liveStreaming",
	"liveEnd",
] as const satisfies readonly FeatureKey[];

/**
 * 按 {@link FEATURE_KEYS} 摊一张「每把特性一格」的表 —— 和 {@link extrasRecord} 同一个安排:`Object.fromEntries`
 * 的返回类型是宽的,收进泛型之后 `T` 由 `make` 的返回值推断,调用方不用各自补一发 `as`。
 * 全局特性开关的 schema 就是靠它从 `FEATURE_KEYS` 摊出来的,加 / 改一把特性键不用再同改一份手写的键名。
 */
export const featuresRecord = <T>(make: (k: FeatureKey) => T): Record<FeatureKey, T> =>
	Object.fromEntries(FEATURE_KEYS.map((k) => [k, make(k)])) as Record<FeatureKey, T>;

/**
 * 附加项的键。加一个附加项 = 这里加一行 + {@link PUSH_EXTRAS} 里加一行(ADR-0016 决策 1)。
 */
export const EXTRA_KEYS = ["atAllPost", "atAllLiveStart", "wordcloud", "liveSummary"] as const;

export type ExtraKey = (typeof EXTRA_KEYS)[number];

/**
 * 按 {@link EXTRA_KEYS} 摊一张「每把附加项一格」的表 —— 出厂值、两张 schema、一张全空的
 * per-目标表,四处共用这一份。
 *
 * 它存在只为收断言:`Object.fromEntries` 的返回类型永远是宽的(`{[k: string]: T}`),
 * 所以从前四个调用点各自补一发 `as`,四种写法还各不相同;其中两处更把 zod 的内部类型
 * (`ZodDefault<ZodRecord<ZodUUID, ZodBoolean>>`)抄进了断言里 —— 那串跟着 zod 升级一漂,
 * 断言就会静默把错误的类型按住。收进泛型之后 `T` 由 `make` 的返回值推断,没有可抄错的东西。
 *
 * 住在零依赖的 features.ts 里:它是纯函数、一条依赖都不引入(见文件头那条硬规矩),
 * 而消费它的 schema 侧都带 zod。
 */
export const extrasRecord = <T>(make: (k: ExtraKey) => T): Record<ExtraKey, T> =>
	Object.fromEntries(EXTRA_KEYS.map((k) => [k, make(k)])) as Record<ExtraKey, T>;

/**
 * 附加项:挂在某个主特性下面、与本体分开发的一条消息(历史行里 `role: "extra"`)。ADR-0016。
 *
 * 主特性关了它们一起关,主特性推到哪儿它们就跟到哪儿(目标是主特性目标的子集)。
 * 键是**一维**的 —— 每把键自己声明挂在哪把主特性下、面板上叫什么、出厂开不开。@全体
 * 在作品与开播下的出厂值本就不同(作品 OFF、开播 ON),走二维(`extras[附加项][主特性]`)
 * 的话还得再开一层「同一把键在不同特性下默认不同」。
 *
 * `capability` 是这把附加项对**平台能力**的要求(ADR-0016 决策 4 的「有没有平台限制」):
 * 填了就表示目标平台不报这项能力时这把附加项发不出去 —— 面板据此禁用它的开关,推送层
 * 据此跳过。⚠️ 这是能力面,与配置面的三态无关:用户关不掉、也开不了它。不填 = 无限制,
 * 词云 / 总结就是普通消息,哪个平台都发得出去。**别拿 `label` 去判这件事** —— 那是
 * 显示文案,改一次措辞守卫就静默失效。
 *
 * 表里只放代码真读的这几样。**排在本体前还是后、等不等它算完,归各自的发送路**
 * (@全体 在推送层排本体前且不 await;词云 / 总结是直播回顾装配层算完后另发的两次广播)——
 * 见 ADR-0016 决策 4。抄进这张表只会变成没人读的死数据。
 */
export const PUSH_EXTRAS: Record<
	ExtraKey,
	{ feature: FeatureKey; label: string; default: boolean; capability?: "atAll" }
> = {
	atAllPost: {
		feature: "post",
		get label() {
			return packageText("internal.features.1");
		},
		default: false,
		capability: "atAll",
	},
	atAllLiveStart: {
		feature: "liveStart",
		get label() {
			return packageText("internal.features.2");
		},
		default: true,
		capability: "atAll",
	},
	wordcloud: {
		feature: "liveEnd",
		get label() {
			return packageText("internal.features.3");
		},
		default: true,
	},
	liveSummary: {
		feature: "liveEnd",
		get label() {
			return packageText("internal.features.4");
		},
		default: true,
	},
};

/** 四把附加项开关。全局一份、per-UP 一份 partial(schema 见 schema/common.ts)。 */
export type PushExtras = Record<ExtraKey, boolean>;

/** 每个特性的开关 + 四个附加项。schema 本体在 schema/common.ts(`FeatureFlagsSchema`)。 */
export type FeatureFlagValues = Record<FeatureKey, boolean> & { extras: PushExtras };

/** 默认全局值；resolve() 在 per-UP overrides 缺失字段时回退到这里。 */
export const DEFAULT_FEATURE_FLAGS: FeatureFlagValues = {
	post: true,
	liveStart: true,
	// 周期「正在直播」出厂关:拆键之前它由周期间隔 0(出厂值)关着。
	liveStreaming: false,
	liveEnd: true,
	membership: false,
	superchat: false,
	viewerChat: false,
	viewerEnter: false,
	// 出厂值只写在注册表里 —— 两处各抄一份迟早漂。
	extras: extrasRecord((k) => PUSH_EXTRAS[k].default),
};
