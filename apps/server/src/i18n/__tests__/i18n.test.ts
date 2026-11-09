import { formatAmount, formatCount } from "@bilibili-notify/internal/format";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { i18n, t } from "../index.js";

afterEach(() => {
	// 单例:每条用例之后设回初值
	i18n.set({ locale: "zh-CN", voice: "maid" });
});

describe("服务端字典 store", () => {
	it.each([
		{
			locale: "en" as const,
			migrating: "BN is migrating data. Please wait.",
			progress: "BN is migrating data (2/24): 资料 {done}",
			starting: "BN is starting. Please wait.",
			expired: "Review a3 expired after 48 hours without a reply.",
		},
		{
			locale: "ja" as const,
			migrating: "BNはデータを移行中です。しばらくお待ちください。",
			progress: "BNはデータを移行中です（2/24）：资料 {done}",
			starting: "BNを起動中です。しばらくお待ちください。",
			expired: "ID a3 のレビューは48時間返信がなかったため、無効になりました。",
		},
		{
			locale: "zh-TW" as const,
			migrating: "BN 正在移轉資料，請稍候。",
			progress: "BN 正在移轉資料（2/24）：资料 {done}",
			starting: "BN 正在啟動，請稍候。",
			expired: "編號 a3 的銳評超過 48 小時未回覆，已作廢。",
		},
	])("$locale：开机进度和到期句子走真实字典，参数单遍替换", (words) => {
		i18n.set({ locale: words.locale, voice: "plain" });
		expect(t("startup.migrating")).toBe(words.migrating);
		expect(t("startup.migratingStep", { done: 2, total: 24, label: "资料 {done}" })).toBe(
			words.progress,
		);
		expect(t("startup.starting")).toBe(words.starting);
		expect(t("roast.draftExpired", { id: "a3", hours: 48 })).toBe(words.expired);
	});

	it("t 对真键出今天写死的那句中文,并填占位符", () => {
		expect(t("command.framework.crashed")).toBe("出错了，详情在日志里");
		expect(t("command.framework.failed", { word: "login", message: "没拿到二维码" })).toBe(
			"『login』没办成：没拿到二维码",
		);
		expect(t("command.report.daysOutOfRange", { min: 1, max: 30 })).toBe(
			"天数要在 1 到 30 之间哦～",
		);
	});

	it("切到英文后使用已译的宿主回复", () => {
		i18n.set({ locale: "en" });
		expect(t("command.report.busy")).toBe("A report is already running. Please wait.");
		expect(i18n.state().locale).toBe("en");
	});

	it("包字典垫在底下:包里的句子经服务端的 t 也取得到", () => {
		expect(t("internal.commands.prefixBlank")).toBe("前缀不能是纯空白");
		i18n.set({ locale: "en" });
		expect(t("internal.commands.prefixBlank")).toBe("The prefix cannot contain only whitespace.");
	});

	it("中文的女仆层第 4 期才写:现在要女仆口吻也还是底里那句", () => {
		i18n.set({ voice: "plain" });
		expect(t("command.report.busy")).toBe("还在跑呢，稍等一下下～");
		expect(i18n.state().voice).toBe("plain");
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
