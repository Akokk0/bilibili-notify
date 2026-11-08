import { formatAmount, formatCount } from "@bilibili-notify/internal/format";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../index";

/**
 * 包字典垫在面板字典底下(ADR-0037 决策 6 下 10-28 的 🔗):包里的句子经面板的 store 也取得到,
 * 面板组件因此可以直接 `useT()` 取,切语言照样重画。单独一个文件,不受 `use-t.test.tsx` 里 `vi.mock` 的影响。
 */
afterEach(() => {
	i18n.set({ locale: "zh-CN", voice: "maid" });
});

describe("面板字典垫着包字典", () => {
	it("包里的句子经面板的 t 取得到,换语言时拿简体打底", () => {
		i18n.set({ locale: "zh-CN", voice: "maid" });
		expect(i18n.t("internal.commands.prefixBlank")).toBe("前缀不能是纯空白");
		i18n.set({ locale: "en" });
		expect(i18n.t("internal.commands.prefixBlank")).toBe(
			"The prefix cannot contain only whitespace.",
		);
	});
});

it("the host store drives package number formats on every call", () => {
	i18n.set({ locale: "en" });
	expect(formatCount(12345)).toBe("12.3K");
	expect(formatAmount(30, "CNY")).toBe("CN¥30");
	i18n.set({ locale: "zh-TW" });
	expect(formatCount(12345)).toBe("1.2萬");
	i18n.set({ locale: "zh-CN" });
	expect(formatCount(12345)).toBe("1.2万");
});
