// 面板的字典 store(ADR-0037 决策 5、6):不包 zustand —— `createI18n` 本身就是带订阅的 store,
// 再包一层是两份状态,直接喂给 `useSyncExternalStore`。所以放 `i18n/` 而不放 `store/`。
import {
	createI18n,
	type DictKey,
	type Locale,
	type LocaleDicts,
} from "@bilibili-notify/internal/i18n";
import {
	bindPackageText,
	type PackageTextKey,
	withPackageDicts,
} from "@bilibili-notify/internal/texts";
import { useSyncExternalStore } from "react";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import zhCN from "./locales/zh-CN.json";
import zhCNMaid from "./locales/zh-CN.maid.json";
import zhTW from "./locales/zh-TW.json";
import { readLocalePreference, readVoicePreference } from "./preference";

/** 键的集合从简体中文那份取。面板的字随第 4 期重画才收,在那之前是 `never`。 */
export type WebTextKey = DictKey<typeof zhCN>;

// 繁体、英文、日文第 5 期才翻,在那之前缺的句子拿简体中文打底;中文的女仆层第 4 期才写,繁体的第 5 期。
export const DICTS = {
	"zh-CN": { plain: zhCN, maid: zhCNMaid },
	"zh-TW": { plain: zhTW },
	en: { plain: en },
	ja: { plain: ja },
} satisfies Record<Locale, LocaleDicts>;

/**
 * 初值是浏览器里记的(没记过:语言按浏览器猜、口吻取规则默认,ADR-0037 决策 7);
 * 登录后 `useTextSettings` 再换成服务端设置里的。
 */
export const i18n = createI18n<WebTextKey | PackageTextKey, Locale>({
	// 包字典垫在底下:组件用 useT() 也取得到包里的句子
	dicts: withPackageDicts(DICTS),
	fallback: "zh-CN",
	locale: readLocalePreference(),
	voice: readVoicePreference(),
});

// 包里的话(`packageText`)跟着面板的语言与口吻走(ADR-0037 决策 6 下 10-28 的 🔗)
bindPackageText(i18n.t);

/** 组件里取字:`const t = useT()`。切语言或口吻后拿到的 `t` 换了引用,已画出来的组件自己重画。 */
export function useT() {
	return useSyncExternalStore(i18n.subscribe, i18n.state, i18n.state).t;
}
