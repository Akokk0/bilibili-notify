// @vitest-environment jsdom

/**
 * 浏览器里记的语言与口吻(没登录时用),以及头一回按浏览器语言猜。
 * 读写都包 try:localStorage 不在、读抛、写抛(私密窗口、内嵌壳)时退到猜 / 默认,不抛。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	guessLocale,
	LOCALE_STORAGE_KEY,
	readLocalePreference,
	readVoicePreference,
	VOICE_STORAGE_KEY,
	writeLocalePreference,
	writeVoicePreference,
} from "../preference";

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("guessLocale", () => {
	it("认得的整段 / 主语言段", () => {
		expect(guessLocale(["ja-JP"])).toBe("ja");
		expect(guessLocale(["ja"])).toBe("ja");
		expect(guessLocale(["en-US"])).toBe("en");
		expect(guessLocale(["EN-gb"])).toBe("en");
	});

	it("简体:zh-CN、zh-SG、zh-Hans*、单写 zh", () => {
		for (const tag of ["zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN", "zh"]) {
			expect(guessLocale([tag])).toBe("zh-CN");
		}
	});

	it("繁体:zh-TW、zh-HK、zh-MO、zh-Hant*", () => {
		for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW", "zh-hant-hk"]) {
			expect(guessLocale([tag])).toBe("zh-TW");
		}
	});

	it("文字段比地区段优先:zh-Hans-TW 是简体", () => {
		expect(guessLocale(["zh-Hans-TW"])).toBe("zh-CN");
	});

	it("按顺序取第一个认得的;都不认得或为空 → 英文", () => {
		expect(guessLocale(["fr-FR", "ja"])).toBe("ja");
		expect(guessLocale(["fr-FR"])).toBe("en");
		expect(guessLocale([])).toBe("en");
	});
});

describe("readLocalePreference", () => {
	it("记过且合法 → 它", () => {
		localStorage.setItem(LOCALE_STORAGE_KEY, "ja");
		expect(readLocalePreference()).toBe("ja");
		localStorage.setItem(LOCALE_STORAGE_KEY, "zh-TW");
		expect(readLocalePreference()).toBe("zh-TW");
	});

	it("记的是坏值 → 按浏览器语言猜", () => {
		vi.spyOn(navigator, "languages", "get").mockReturnValue(["ja-JP"]);
		localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
		expect(readLocalePreference()).toBe("ja");
	});

	it("没记过 → 按浏览器语言猜", () => {
		vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-HK", "en"]);
		expect(readLocalePreference()).toBe("zh-TW");
	});

	it("localStorage.getItem 抛 → 猜,不抛", () => {
		vi.spyOn(navigator, "languages", "get").mockReturnValue(["ja"]);
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(readLocalePreference()).toBe("ja");
	});
});

describe("readVoicePreference", () => {
	it("记过且合法 → 它;没记过或坏值 → 规则默认(女仆)", () => {
		localStorage.setItem(VOICE_STORAGE_KEY, "plain");
		expect(readVoicePreference()).toBe("plain");
		localStorage.setItem(VOICE_STORAGE_KEY, "loud");
		expect(readVoicePreference()).toBe("maid");
		localStorage.clear();
		expect(readVoicePreference()).toBe("maid");
	});

	it("localStorage.getItem 抛 → 默认,不抛", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(readVoicePreference()).toBe("maid");
	});
});

describe("write*Preference", () => {
	it("写进 bn.locale / bn.voice", () => {
		writeLocalePreference("en");
		writeVoicePreference("plain");
		expect(localStorage.getItem("bn.locale")).toBe("en");
		expect(localStorage.getItem("bn.voice")).toBe("plain");
	});

	it("setItem 抛时不抛", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
		expect(() => writeLocalePreference("en")).not.toThrow();
		expect(() => writeVoicePreference("plain")).not.toThrow();
	});
});
