/**
 * 出厂文案的读口:推送文字模板的默认与内置人格,按语言取(ADR-0037 决策 10、11)。
 *
 * 零依赖子路径 `@bilibili-notify/internal/texts/builtin`,服务端与面板共用:译文住 `locales/` 的四份 JSON
 * (打包时内联),这里只有取字规矩 —— 本语言有这一键就取本语言,没有拿简体打底。
 * **取原文**:不插值(`{creatorNoun}` 之类留给用到的地方填)、不吃女仆层、不经 `t`。
 * 不许引入 zod 或 schema;值级 import 只有同样零依赖的 `i18n.ts` 与 JSON。
 */

import type { AiPersonaSettingsShape } from "../../ai";
import { DEFAULT_LOCALE, type Dict, type Locale, mergeDict } from "../../i18n";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";

/** 四种语言的出厂文案字典。 */
export type BuiltinDicts = Readonly<Record<Locale, Dict>>;

const BUNDLED_DICTS: BuiltinDicts = { "zh-CN": zhCN, "zh-TW": zhTW, en, ja };

/** 内置人格的 id,顺序即人格库里的顺序。 */
export const BUILTIN_PRESET_IDS = ["gentle-maid", "tsundere", "analyst", "genki"] as const;
export type BuiltinPresetId = (typeof BUILTIN_PRESET_IDS)[number];

/** Fixed model prompts are not human dictionary entries (ADR-0037). */
const GENTLE_MAID_DYNAMIC_PROMPT =
	"主人订阅的{creatorNoun}刚刚更新了{postNoun},请用温柔的语气向主人转述核心内容,并补一两句你的看法。";
const GENTLE_MAID_LIVE_SUMMARY_PROMPT =
	"用温柔的语气向主人讲讲直播主要发生了什么(150-200 字),从弹幕和氛围中提炼亮点。";
const TSUNDERE_DYNAMIC_PROMPT =
	"主人让你看的{creatorNoun}又更新{postNoun}了,用傲娇的语气吐槽一下,但内容核心要讲清楚,不要光吐槽不汇报。";
const TSUNDERE_LIVE_SUMMARY_PROMPT =
	"主人非要让你帮他看一整场直播,用傲娇的语气把这场直播总结一下,允许适当吐槽,但关键点要交代到。";
const ANALYST_DYNAMIC_PROMPT =
	"主人订阅的{creatorNoun}更新了{postNoun}。按「亮点 / 关键信息 / 简评」三段式向主人汇报,语言简洁克制,简评不超过两句,不做情绪渲染。";
const ANALYST_LIVE_SUMMARY_PROMPT =
	"向主人汇报这场直播:涉及话题、互动热点、整体氛围。控制在 200 字内,保持敬语但不用颜文字与感叹号。";
const GENKI_DYNAMIC_PROMPT =
	"用元气满满的语气把{creatorNoun}的新{postNoun}讲给用户听,内容核心要说出来,语气活泼但别过头。";
const GENKI_LIVE_SUMMARY_PROMPT =
	"用元气满满的语气帮用户回顾这场直播的重点(200 字内),保持热情但抓住关键点。";

const MODEL_PROMPTS = {
	"gentle-maid": {
		dynamicPrompt: GENTLE_MAID_DYNAMIC_PROMPT,
		liveSummaryPrompt: GENTLE_MAID_LIVE_SUMMARY_PROMPT,
	},
	tsundere: {
		dynamicPrompt: TSUNDERE_DYNAMIC_PROMPT,
		liveSummaryPrompt: TSUNDERE_LIVE_SUMMARY_PROMPT,
	},
	analyst: {
		dynamicPrompt: ANALYST_DYNAMIC_PROMPT,
		liveSummaryPrompt: ANALYST_LIVE_SUMMARY_PROMPT,
	},
	genki: { dynamicPrompt: GENKI_DYNAMIC_PROMPT, liveSummaryPrompt: GENKI_LIVE_SUMMARY_PROMPT },
} as const satisfies Record<BuiltinPresetId, { dynamicPrompt: string; liveSummaryPrompt: string }>;

/**
 * 出厂文字模板:只有按语言取的文字 —— 八条文字,加会员体系默认那一句(不分体系)。
 * 词云停用词、会员文案的开关 / 图片 / 分档都不是文字,不在这里(由用到的地方就地给空值 / 关着)。
 */
export type BuiltinTemplates = {
	liveStart: string;
	liveStreaming: string;
	liveEnd: string;
	liveSummary: string;
	post: string;
	postVideo: string;
	viewerChat: string;
	viewerEnter: string;
	membership: string;
};

/** 设置里存着的一份会员体系文案:主人没改的格不在。 */
export type StoredMembershipTemplate = {
	enabled?: boolean;
	default?: { template?: string; imageUrl?: string };
	tiers?: Record<string, { template?: string; imageUrl?: string }>;
};

/** 设置里存着的文字模板(`defaults.templates` 或订阅覆盖):只有主人改过的格在。 */
export type StoredTemplates = {
	liveStart?: string;
	liveStreaming?: string;
	liveEnd?: string;
	liveSummary?: string;
	post?: string;
	postVideo?: string;
	wordcloudStopWords?: string;
	viewerChat?: string;
	viewerEnter?: string;
	membership?: Record<string, StoredMembershipTemplate>;
};

/** 填好的一份会员体系文案:体系默认那句一定有。 */
export type EffectiveMembershipTemplate = {
	enabled: boolean;
	default: { template: string; imageUrl: string };
	tiers: Record<string, { template?: string; imageUrl?: string }>;
};

/** 填好的文字模板:每格都有字;会员只列存着的体系(没列的体系用 `withMembershipDefaults(undefined, …)` 现填)。 */
export type EffectiveTemplates = Omit<BuiltinTemplates, "membership"> & {
	wordcloudStopWords: string;
	membership: Record<string, EffectiveMembershipTemplate>;
};

/** 一份存着的会员体系文案里缺的格,按出厂补上(体系默认那一句不分体系,取 `fallbackText`)。 */
export function withMembershipDefaults(
	stored: StoredMembershipTemplate | undefined,
	fallbackText: string,
): EffectiveMembershipTemplate {
	return {
		enabled: stored?.enabled ?? false,
		default: {
			template: stored?.default?.template ?? fallbackText,
			imageUrl: stored?.default?.imageUrl ?? "",
		},
		tiers: stored?.tiers ?? {},
	};
}

/**
 * 存着的取存的,缺的取 `defaults`(ADR-0037 决策 10:设置里没有 = 跟随当前语言的默认)。
 * 会员按体系:只列存着的体系,每个体系缺 `default.template` 取出厂那一句(不分体系)。
 * 词云停用词不是按语言的文字,没存就是空。零依赖、不改入参,服务端与面板共用。
 */
export function withTemplateDefaults(
	stored: StoredTemplates | undefined,
	defaults: BuiltinTemplates,
): EffectiveTemplates {
	const membership: Record<string, EffectiveMembershipTemplate> = {};
	for (const [id, entry] of Object.entries(stored?.membership ?? {})) {
		membership[id] = withMembershipDefaults(entry, defaults.membership);
	}
	return {
		liveStart: stored?.liveStart ?? defaults.liveStart,
		liveStreaming: stored?.liveStreaming ?? defaults.liveStreaming,
		liveEnd: stored?.liveEnd ?? defaults.liveEnd,
		liveSummary: stored?.liveSummary ?? defaults.liveSummary,
		post: stored?.post ?? defaults.post,
		postVideo: stored?.postVideo ?? defaults.postVideo,
		wordcloudStopWords: stored?.wordcloudStopWords ?? "",
		viewerChat: stored?.viewerChat ?? defaults.viewerChat,
		viewerEnter: stored?.viewerEnter ?? defaults.viewerEnter,
		membership,
	};
}

/** 一份内置人格,十格齐全(两段提示词不缺席)。 */
export type BuiltinPreset = {
	id: BuiltinPresetId;
	label: string;
	persona: AiPersonaSettingsShape;
	dynamicPrompt: string;
	liveSummaryPrompt: string;
};

/** 本语言盖在简体上;没有本语言就是简体本身。 */
function dictFor(locale: Locale, dicts: BuiltinDicts): Dict {
	return mergeDict(dicts[DEFAULT_LOCALE], dicts[locale]);
}

// 字典里缺这一键(只有测试注入了残缺字典才会走到)就回键本身,露出来好查
const textOf = (dict: Dict, key: string): string =>
	(Object.hasOwn(dict, key) ? dict[key] : key) as string;

/**
 * 这种语言的出厂文字模板。每次交一份新对象(调用方可能改它)。
 *
 * 占位符统一 `{key}` 语法,由 `interpolate` 替换。变量集严格对齐渲染器实际提供的字段:
 * - 直播:`{name}` `{time}` `{follower}` `{follower_change}` `{watched}`
 * - 会员(上舰):`{viewer}`(观众名)`{name}`(主播名)`{tier}`(档名)
 * - 特别关注:`{name}`(主播名)`{viewer}`(观众名)`{msg}`(弹幕正文,进场没有)
 * - 弹幕总结:`{dmc}` `{fanclub}`(粉丝团名) `{dca}` `{un1..5}` `{dc1..5}`
 * - 作品:`{name}` `{postNoun}`(来源对作品的叫法,没声明叫「作品」)
 *
 * 链接不再是模板变量:动态 / 视频 / 开播的链接是消息版式的独立「链接」部件,模板里没有链接变量。
 * @param dicts 只给测试注入别的语言;缺省是打包进来的四份。
 */
export function templateDefaultsFor(
	locale: Locale,
	dicts: BuiltinDicts = BUNDLED_DICTS,
): BuiltinTemplates {
	const dict = dictFor(locale, dicts);
	const text = (name: string) => textOf(dict, `template.${name}`);
	return {
		liveStart: text("liveStart"),
		liveStreaming: text("liveStreaming"),
		liveEnd: text("liveEnd"),
		liveSummary: text("liveSummary"),
		post: text("post"),
		postVideo: text("postVideo"),
		viewerChat: text("viewerChat"),
		viewerEnter: text("viewerEnter"),
		// 会员体系默认那一句:不分体系(B 站的体系是 `guard`,别的体系由来源声明、事件到了才有)
		membership: text("membership"),
	};
}

/**
 * 这种语言的内置人格,按 `BUILTIN_PRESET_IDS` 的顺序。每次交一份新数组与新对象。
 *
 * 清单的用处:默认 AI 配置(首份)、服务端迁移器(0.x 老配置补齐这四份)、设置页(「从内置恢复」、锁死判断)。
 * 这四份在界面上只读:可以删、可以「从内置修改」另存副本,不能就地改 —— 它们是稳定的参照库。
 * @param dicts 只给测试注入别的语言;缺省是打包进来的四份。
 */
export function builtinPresetsFor(
	locale: Locale,
	dicts: BuiltinDicts = BUNDLED_DICTS,
): BuiltinPreset[] {
	const dict = dictFor(locale, dicts);
	return BUILTIN_PRESET_IDS.map((id) => {
		const text = (field: string) => textOf(dict, `persona.${id}.${field}`);
		return {
			id,
			label: text("label"),
			persona: {
				name: text("name"),
				addressUser: text("addressUser"),
				addressSelf: text("addressSelf"),
				traits: text("traits"),
				catchphrase: text("catchphrase"),
				baseRole: text("baseRole"),
				extraSystemPrompt: text("extraSystemPrompt"),
			},
			dynamicPrompt: MODEL_PROMPTS[id].dynamicPrompt,
			liveSummaryPrompt: MODEL_PROMPTS[id].liveSummaryPrompt,
		};
	});
}
