/** 模块原文由模块持有；语言与口吻在调用时跟随宿主，通用句子委托宿主。 */
import {
	createI18n,
	type DictKey,
	type Locale,
	type LocaleDicts,
	stemOf,
	type TextValues,
} from "@bilibili-notify/internal/i18n";
import { i18n as hostI18n, t as hostText } from "../i18n/index.js";
import en from "./locales/en.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };
import zhCN from "./locales/zh-CN.json" with { type: "json" };
import zhCNMaid from "./locales/zh-CN.maid.json" with { type: "json" };
import zhTW from "./locales/zh-TW.json" with { type: "json" };
export const DICTS = {
	"zh-CN": { plain: zhCN, maid: zhCNMaid },
	"zh-TW": { plain: zhTW },
	en: { plain: en },
	ja: { plain: ja },
} satisfies Record<Locale, LocaleDicts>;
type LocalKey = DictKey<typeof zhCN>;
type HostKey = Parameters<typeof hostText>[0];
const keys = new Set(Object.keys(zhCN).map(stemOf));
const texts = createI18n<LocalKey, Locale>({
	dicts: DICTS,
	fallback: "zh-CN",
	locale: "zh-CN",
	voice: "maid",
});
export function t(key: LocalKey | HostKey, values?: TextValues): string {
	if (!keys.has(key)) return hostText(key as HostKey, values);
	const { locale, voice } = hostI18n.state();
	texts.set({ locale, voice });
	return texts.t(key as LocalKey, values);
}
