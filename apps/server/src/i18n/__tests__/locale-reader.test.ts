/**
 * `localeReaderOf`:把字典 store 接成装载器要的「当前语言」读口。
 * 钉的几条:`current()` 读 store 当下的语言;语言真变了 `onChange` 叫一次;只换口吻不叫(拓展不吃口吻,
 * 决策 15);摘掉之后不再叫。store 用真的 `createI18n` 搭。
 */

import { createI18n, type Locale } from "@bilibili-notify/internal/i18n";
import { describe, expect, it } from "vite-plus/test";
import { localeReaderOf } from "../locale-reader.js";

function setup() {
	const i18n = createI18n<string, Locale>({
		dicts: {
			"zh-CN": { plain: {}, maid: {} },
			"zh-TW": { plain: {} },
			en: { plain: {} },
			ja: { plain: {} },
		},
		fallback: "zh-CN",
		locale: "zh-CN",
		voice: "maid",
	});
	const reader = localeReaderOf({
		current: () => i18n.state().locale,
		subscribe: (fn) => i18n.subscribe(fn),
	});
	return { i18n, reader };
}

describe("localeReaderOf", () => {
	it("current() 读的是 store 当下的语言", () => {
		const { i18n, reader } = setup();
		expect(reader.current()).toBe("zh-CN");
		i18n.set({ locale: "en" });
		expect(reader.current()).toBe("en");
	});

	it("语言真变了 → onChange 叫一次", () => {
		const { i18n, reader } = setup();
		let calls = 0;
		reader.onChange(() => {
			calls += 1;
		});
		i18n.set({ locale: "ja" });
		expect(calls).toBe(1);
	});

	it("只换了口吻、语言没变 → 不叫", () => {
		const { i18n, reader } = setup();
		let calls = 0;
		reader.onChange(() => {
			calls += 1;
		});
		i18n.set({ voice: "plain" });
		expect(calls).toBe(0);
		// 再换一次语言仍然叫:上一次的"没变"没把基线弄丢
		i18n.set({ locale: "en" });
		expect(calls).toBe(1);
	});

	it("dispose 之后不再叫", () => {
		const { i18n, reader } = setup();
		let calls = 0;
		const subscription = reader.onChange(() => {
			calls += 1;
		});
		subscription.dispose();
		i18n.set({ locale: "en" });
		expect(calls).toBe(0);
	});
});
