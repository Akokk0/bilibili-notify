import type { LocaleReader } from "../../extensions/loader.js";

/** 一直是同一种语言的读口:装载器的测试不关心语言时用。 */
export function fixedLocale(locale = "zh-CN"): LocaleReader {
	return { current: () => locale, onChange: () => ({ dispose() {} }) };
}

/** 可以中途切语言的读口:`set` 换了语言才叫订阅者(同真的那个,只在真变时转)。 */
export function switchableLocale(initial = "zh-CN"): LocaleReader & { set(locale: string): void } {
	let current = initial;
	const listeners = new Set<() => void>();
	return {
		current: () => current,
		onChange(fn) {
			listeners.add(fn);
			return { dispose: () => listeners.delete(fn) };
		},
		set(locale) {
			if (locale === current) return;
			current = locale;
			for (const fn of [...listeners]) fn();
		},
	};
}
