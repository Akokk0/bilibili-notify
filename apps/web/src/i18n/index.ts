// 面板的字典 store(ADR-0037 决策 5、6):不包 zustand —— `createI18n` 本身就是带订阅的 store,
// 再包一层是两份状态,直接喂给 `useSyncExternalStore`。所以放 `i18n/` 而不放 `store/`。
// 语言与口吻眼下只有常量初值;从设置读、没登录时按浏览器猜归 3b-10。
import {
	createI18n,
	type DictKey,
	type Locale,
	type LocaleDicts,
} from "@bilibili-notify/internal/i18n";
import { useSyncExternalStore } from "react";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import zhCN from "./locales/zh-CN.json";
import zhCNMaid from "./locales/zh-CN.maid.json";
import zhTW from "./locales/zh-TW.json";

/** 键的集合从简体中文那份取。面板的字随第 4 期重画才收,在那之前是 `never`。 */
export type WebTextKey = DictKey<typeof zhCN>;

// 繁体、英文、日文第 5 期才翻,在那之前缺的句子拿简体中文打底;中文的女仆层第 4 期才写,繁体的第 5 期。
export const DICTS = {
	"zh-CN": { plain: zhCN, maid: zhCNMaid },
	"zh-TW": { plain: zhTW },
	en: { plain: en },
	ja: { plain: ja },
} satisfies Record<Locale, LocaleDicts>;

/** 初值简中 + 女仆(ADR-0037 决策 3 下 10-14 的 🔗:口吻默认第 4 期定之前取女仆)。 */
export const i18n = createI18n<WebTextKey, Locale>({
	dicts: DICTS,
	fallback: "zh-CN",
	locale: "zh-CN",
	voice: "maid",
});

/** 组件里取字:`const t = useT()`。切语言或口吻后拿到的 `t` 换了引用,已画出来的组件自己重画。 */
export function useT() {
	return useSyncExternalStore(i18n.subscribe, i18n.state).t;
}
