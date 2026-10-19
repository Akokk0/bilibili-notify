import type { Dict, Locale } from "@bilibili-notify/internal/i18n";
import type { ExtensionLocales } from "../../extensions/locales.js";
import type { LocaleReader } from "../../i18n/locale-reader.js";
import { fixedLocale } from "./fixed-locale.js";

/** 没带译文的拓展:`createExtensionContext` 要的 `locales` 一格。 */
export function noExtensionLocales(): ExtensionLocales {
	return { files: {}, issues: [] };
}

/** 不关心 `ctx.i18n` 的测试:没带译文、语言一直是简中。展开进 `createExtensionContext` 的选项。 */
export function noExtensionI18n(): { locales: ExtensionLocales; localeReader: LocaleReader } {
	return { locales: noExtensionLocales(), localeReader: fixedLocale() };
}

/** 只带运行时那层的译文:语言 → 键 → 句子(清单那层留空,不带问题)。 */
export function extensionLocalesOf(dicts: Partial<Record<Locale, Dict>>): ExtensionLocales {
	const files: ExtensionLocales["files"] = {};
	for (const [locale, dict] of Object.entries(dicts) as [Locale, Dict][]) {
		files[locale] = { dict, manifest: {}, issues: [] };
	}
	return { files, issues: [] };
}
