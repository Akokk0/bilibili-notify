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

it.each([
	[
		"ja",
		"ご主人様、Bilibili Notifyサーバーに接続できません。",
		"ご主人様、サーバーが起動していないか、プロキシーに遮断されている可能性があります。サービスが稼働しているか確認してくださいね。",
		"Bilibili Notifyサーバーに接続できません",
		"サーバーが起動していないか、プロキシーに遮断されている可能性があります。サービスが稼働しているか確認してください。",
	],
	[
		"zh-TW",
		"主人，無法連線至 Bilibili Notify 後端。",
		"主人，後端可能尚未啟動，或遭代理伺服器阻擋。請確認服務是否正在執行喔。",
		"無法連線至 Bilibili Notify 後端",
		"後端可能尚未啟動，或遭代理伺服器阻擋。請確認服務是否正在執行。",
	],
] as const)(
	"%s 既有取字入口区分连接错误的女仆与平实说明",
	(locale, maidTitle, maidHint, plainTitle, plainHint) => {
		i18n.set({ locale, voice: "maid" });
		expect(i18n.t("panelUi.components.shell-states.3")).toBe(maidTitle);
		expect(i18n.t("panelUi.components.shell-states.5")).toBe(maidHint);
		i18n.set({ voice: "plain" });
		expect(i18n.t("panelUi.components.shell-states.3")).toBe(plainTitle);
		expect(i18n.t("panelUi.components.shell-states.5")).toBe(plainHint);
	},
);

describe("面板字典垫着包字典", () => {
	it.each([
		["ja", "ご主人様、選んでくださいね。", "選択してください"],
		["zh-TW", "請選擇喔，主人", "請選擇"],
	] as const)("%s：真实面板字典读到包女仆层，平实模式仍读底稿", (locale, maid, plain) => {
		i18n.set({ locale, voice: "maid" });
		expect(i18n.state().voice).toBe("maid");
		expect(i18n.t("ui.select.placeholder")).toBe(maid);
		i18n.set({ voice: "plain" });
		expect(i18n.t("ui.select.placeholder")).toBe(plain);
	});

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
