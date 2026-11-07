/** Test host's ctx.i18n; the real host fallback/manifest path is covered by bridge-e2e. */
import { readFileSync } from "node:fs";
import type { ExtensionI18n } from "@bilibili-notify/extension";

export function bridgeTexts(
	initial = "zh-CN",
): ExtensionI18n & { setLocale(locale: string): void } {
	const dictionaries = Object.fromEntries(
		["zh-CN", "en", "ja", "zh-TW"].map((locale) => [
			locale,
			JSON.parse(
				readFileSync(new URL(`../../locales/${locale}.json`, import.meta.url), "utf8"),
			) as Record<string, unknown>,
		]),
	);
	let locale = initial;
	return {
		locale: () => locale,
		setLocale(next) {
			locale = next;
		},
		onChange: () => ({ dispose() {} }),
		t(key, values) {
			const dict = dictionaries[locale] ?? dictionaries["zh-CN"] ?? {};
			const count = values?.count;
			const plural =
				typeof count === "number" ? new Intl.PluralRules(locale).select(count) : undefined;
			const value =
				(plural ? (dict[`${key}#${plural}`] ?? dict[`${key}#other`]) : undefined) ??
				dict[key] ??
				dictionaries["zh-CN"]?.[key];
			if (typeof value !== "string") throw new Error(`Missing bridge text: ${locale}/${key}`);
			return value.replace(/\{(\w+)\}/g, (_, name: string) =>
				String(values?.[name] ?? `{${name}}`),
			);
		},
	};
}

export const CHINESE = bridgeTexts();
