// 浏览器里记的语言与口吻:没登录、拿不到服务端设置时面板用它(ADR-0037 决策 7)。
// 读写都包 try —— localStorage 在私密窗口 / 内嵌壳里可能不在或会抛,退到猜 / 默认(同 services/theme.ts 的口径)。
import {
	DEFAULT_VOICE,
	LOCALES,
	type Locale,
	VOICES,
	type Voice,
} from "@bilibili-notify/internal/i18n";

export const LOCALE_STORAGE_KEY = "bn.locale";
export const VOICE_STORAGE_KEY = "bn.voice";

/** 带 `Hant` 或地区是台湾 / 香港 / 澳门的算繁体;写了 `Hans` 的一律简体(`zh-Hans-TW` 是简体)。 */
function isTraditional(rest: readonly string[]): boolean {
	if (rest.includes("hans")) return false;
	if (rest.includes("hant")) return true;
	return rest.some((part) => part === "tw" || part === "hk" || part === "mo");
}

function recognise(tag: string): Locale | undefined {
	const [language = "", ...rest] = tag.toLowerCase().split(/[-_]/);
	if (language === "ja") return "ja";
	if (language === "en") return "en";
	if (language === "zh") return isTraditional(rest) ? "zh-TW" : "zh-CN";
	return undefined;
}

/**
 * 按浏览器的语言表依次猜,第一个认得的;都不认得 → 英文(ADR-0037 决策 17)。
 * 收入参而不自己读 `navigator`,纯函数好测;桌面壳里 WebView 的语言表就是系统语言。
 */
export function guessLocale(tags: readonly string[]): Locale {
	for (const tag of tags) {
		const found = recognise(tag);
		if (found !== undefined) return found;
	}
	return "en";
}

function browserLanguages(): readonly string[] {
	try {
		if (typeof navigator === "undefined") return [];
		if (navigator.languages?.length) return navigator.languages;
		return navigator.language ? [navigator.language] : [];
	} catch {
		return [];
	}
}

function readItem(key: string): string | null {
	try {
		if (typeof localStorage === "undefined") return null;
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeItem(key: string, value: string): void {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(key, value);
	} catch {
		// 存不了就算了,本次打开照样在内存里生效。
	}
}

/** 记过且合法 → 它;否则按浏览器语言猜。 */
export function readLocalePreference(): Locale {
	const stored = readItem(LOCALE_STORAGE_KEY);
	const known = LOCALES.find((locale) => locale === stored);
	return known ?? guessLocale(browserLanguages());
}

export function writeLocalePreference(locale: Locale): void {
	writeItem(LOCALE_STORAGE_KEY, locale);
}

/** 记过且合法 → 它;否则取规则默认(登录前口吻没有别的出处)。 */
export function readVoicePreference(): Voice {
	const stored = readItem(VOICE_STORAGE_KEY);
	return VOICES.find((voice) => voice === stored) ?? DEFAULT_VOICE;
}

export function writeVoicePreference(voice: Voice): void {
	writeItem(VOICE_STORAGE_KEY, voice);
}
