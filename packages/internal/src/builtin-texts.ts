/**
 * 出厂文案的读口:推送文字模板的默认与内置人格,按语言取(ADR-0037 决策 10、11)。
 *
 * 零依赖子路径 `@bilibili-notify/internal/builtin-texts`,服务端与面板共用:译文住 `locales/` 的四份 JSON
 * (打包时内联),这里只有取字规矩 —— 本语言有这一键就取本语言,没有拿简体打底。
 * **取原文**:不插值(`{creatorNoun}` 之类留给用到的地方填)、不吃女仆层、不经 `t`。
 * 不许引入 zod 或 schema;值级 import 只有同样零依赖的 `i18n.ts` 与 JSON。
 */

import type { AIPersonaShape } from "./constants";
import { DEFAULT_LOCALE, type Dict, type Locale, mergeDict } from "./i18n";
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

/** 会员体系里的一份文案(体系默认那一格)。 */
export type BuiltinMembershipTemplate = {
	enabled: boolean;
	default: { template: string; imageUrl: string };
	tiers: Record<string, never>;
};

/** 出厂文字模板:与存进设置里的 `defaults.templates` 同形状。 */
export type BuiltinTemplates = {
	liveStart: string;
	liveStreaming: string;
	liveEnd: string;
	liveSummary: string;
	post: string;
	postVideo: string;
	wordcloudStopWords: string;
	viewerChat: string;
	viewerEnter: string;
	membership: { guard: BuiltinMembershipTemplate };
};

/** 一份内置人格,十格齐全(两段提示词不缺席)。 */
export type BuiltinPreset = {
	id: BuiltinPresetId;
	label: string;
	persona: AIPersonaShape;
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
		wordcloudStopWords: "",
		viewerChat: text("viewerChat"),
		viewerEnter: text("viewerEnter"),
		// 会员文案,按体系 id 存;B 站的体系是 `guard`,别的体系由来源声明、事件到了才有
		membership: {
			guard: {
				// false = 官方上舰图 / 上舰卡;true = 用 default / tiers 里的自定义文案与图片
				enabled: false,
				default: { template: text("membership"), imageUrl: "" },
				// 只存改过的档;出厂都跟随上面的默认
				tiers: {},
			},
		},
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
			dynamicPrompt: text("dynamicPrompt"),
			liveSummaryPrompt: text("liveSummaryPrompt"),
		};
	});
}
