import { afterEach, describe, expect, it } from "vite-plus/test";
import { i18n, t } from "../index.js";

afterEach(() => {
	// 单例:每条用例之后设回初值
	i18n.set({ locale: "zh-CN", voice: "maid" });
});

describe("服务端字典 store", () => {
	it("t 对真键出今天写死的那句中文,并填占位符", () => {
		expect(t("command.framework.crashed")).toBe("出错了，详情在日志里");
		expect(t("command.framework.failed", { word: "login", message: "没拿到二维码" })).toBe(
			"『login』没办成：没拿到二维码",
		);
		expect(t("command.report.daysOutOfRange", { min: 1, max: 30 })).toBe(
			"天数要在 1 到 30 之间哦～",
		);
	});

	it("切到英文后,英文没有的句子拿简体中文打底", () => {
		i18n.set({ locale: "en" });
		expect(t("command.report.busy")).toBe("还在跑呢，稍等一下下～");
		expect(i18n.state().locale).toBe("en");
	});

	it("包字典垫在底下:包里的句子经服务端的 t 也取得到", () => {
		expect(t("internal.commands.prefixBlank")).toBe("前缀不能是纯空白");
		i18n.set({ locale: "en" });
		expect(t("internal.commands.prefixBlank")).toBe("前缀不能是纯空白");
	});

	it("中文的女仆层第 4 期才写:现在要女仆口吻也还是底里那句", () => {
		i18n.set({ voice: "plain" });
		expect(t("command.report.busy")).toBe("还在跑呢，稍等一下下～");
		expect(i18n.state().voice).toBe("plain");
	});
});
