// @vitest-environment jsdom
/**
 * 统计页也列拓展订阅(ADR-0020 决策 1 / 3 / 11)。
 *
 * - 行以**订阅 id** 为键,选中、聚焦都按它 —— 外部 id 恰好等于某个 B 站 uid 时,点的是谁就是谁。
 * - 颜色跟着人走:与订阅卡同一个颜色(`subscriptionColor`,ADR-0019 决策 73)。
 * - 名字走订阅卡那条链(资料里的名字 → 外部 id;别名已退役,ADR-0021 决策 16);单人页头 B 站写「UID xxx」、拓展写「平台名 外部 id」。
 * - 汇总(总粉丝量、在盯几位)两支一起算。
 * - 「峰值观看 / 场均峰值」改成「单场最高观看 / 场均观看」,旁边一句「按每场累计看过的人数算」。
 * - 锐评两支都管(ADR-0020 决策 12 / 14 / 18):聚焦到拓展行照样出单人锐评与它的定时,请求按(编码过的)订阅 id
 *   走;榜单的结果按订阅 id 回指,名字 / 颜色照统计行那一份。
 */

import type { ExtensionEntryView, SourceEntry, UpStatsRow } from "@bilibili-notify/contract";
import { makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import { subscriptionColor } from "../../utils/creator-display";
import { makeSource } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { SETTINGS_KEY } from "../../hooks/useSettings";
import { i18n } from "../../i18n";
import { api } from "../../services/api";
import Stats from "../Stats";

const DAYS = 30;
const fill = <T,>(v: T) => Array.from({ length: DAYS }, () => v);

function row(over: Partial<UpStatsRow>): UpStatsRow {
	return {
		subscriptionId: "s-x",
		identity: { sourceKey: "bilibili", externalId: "0" },
		followers: 1000,
		net1d: 1,
		net7d: 7,
		netWindow: 30,
		series: fill(1),
		cumulative: fill(1000),
		activity: fill(1),
		recording: { posts: [], live: [], followers: [] },
		videoPosts: 1,
		posts: 3,
		liveSessions: 1,
		liveHours: 2,
		liveTimedSessions: 1,
		maxViewers: 100,
		avgViewers: 100,
		lastActivityAt: null,
		live: false,
		...over,
	};
}

/** B 站甲:uid 12345。 */
const BILI_ROW = row({
	subscriptionId: "s-bili",
	identity: { sourceKey: "bilibili", externalId: "12345" },
	followers: 1000,
});
/** 抖音乙:外部 id 恰好也是 12345 —— 另一个平台上的另一个人。正在播。 */
const EXT_ROW = row({
	subscriptionId: "s-dy",
	identity: { sourceKey: "douyin", externalId: "12345" },
	followers: 5000,
	live: true,
	maxViewers: 2000,
	avgViewers: 1500,
});

const BILI_SUB: Subscription = {
	...makeEmptySubscription({ sourceKey: "bilibili", externalId: "12345" }),
	id: "s-bili",
	cachedProfile: {
		name: "B 站甲",
		refreshedAt: "2026-09-24T00:00:00Z",
	},
};
const EXT_SUB: Subscription = {
	...makeEmptySubscription({ sourceKey: "douyin", externalId: "12345" }),
	id: "s-dy",
	// 拓展的头像存在图库里、资料里放引用(资料上报存进图库),页面上走图库的同源读口画出来。
	cachedProfile: {
		name: "抖音乙",
		avatar: `${"d".repeat(64)}.png`,
		refreshedAt: "2026-09-24T00:00:00Z",
	},
};

const DOUYIN: ExtensionEntryView = {
	id: "douyin",
	name: "抖音订阅",
	dir: "/data/extensions/douyin",
	enabled: true,
	state: "running",
	apiVersion: 1,
	provides: ["subscription"],
};

/** 来源表里抖音那一行:平台名与徽章照它(取自清单)。 */
const DOUYIN_SOURCE: SourceEntry = {
	status: "running",
	key: "douyin",
	descriptor: {
		label: "抖音",
		shortLabel: "抖",
		color: "#161823",
		supportedFeatures: ["post", "liveStart", "liveStreaming", "liveEnd"],
	},
};

function mockApi(
	rows: UpStatsRow[],
	subs: Subscription[],
	extensions: ExtensionEntryView[] = [DOUYIN],
	enabled = true,
) {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path === "/api/settings")
			return Promise.resolve({ core: { ...makeDefaultGlobalSettings(), stats: { enabled } } });
		if (path.startsWith("/api/stats/overview")) return Promise.resolve({ days: DAYS, rows });
		if (path === "/api/subscriptions") return Promise.resolve(subs);
		if (path === "/api/ext") return Promise.resolve({ extensions });
		// 来源表照装着的拓展列。
		if (path === "/api/sources") {
			return Promise.resolve({
				sources: [
					makeSource(),
					...extensions.flatMap((one) => (one.id === DOUYIN.id ? [DOUYIN_SOURCE] : [])),
				],
			});
		}
		// 锐评那几张卡要的全局配置 / 推送目标 / 连接:这里不关心,一直等着。
		return new Promise(() => {});
	});
}

function renderStats() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={qc}>
			<Stats />
		</QueryClientProvider>,
	);
	return { ...view, qc };
}

/** jsdom 把 style 里的十六进制颜色存成 rgb(),比之前先照同一条路翻一遍。 */
function cssColor(hex: string): string {
	const probe = document.createElement("span");
	probe.style.color = hex;
	return probe.style.color;
}

/** 对比表里这位的那一行。 */
function tableRow(name: string): HTMLElement {
	const table = screen.getByRole("table");
	const cell = within(table).getByText(name);
	const tr = cell.closest("tr");
	if (!tr) throw new Error(`对比表里没有 ${name} 那一行`);
	return tr;
}

class FakeRO {
	observe() {}
	unobserve() {}
	disconnect() {}
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	vi.stubGlobal("ResizeObserver", FakeRO);
	mockApi([BILI_ROW, EXT_ROW], [BILI_SUB, EXT_SUB]);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe("统计页 · 拓展订阅的行", () => {
	it("对比表 / 热力图两支都列:名字照订阅、拓展行带平台徽章与在播,颜色与订阅卡同一个;汇总两支一起算", async () => {
		renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());

		const ext = tableRow("抖音乙");
		expect(within(ext).getByText("抖")).toBeTruthy();
		expect(ext.querySelector(`img[src="/api/images/${"d".repeat(64)}.png"]`)).not.toBeNull();
		expect(within(ext).getByText(/直播中/)).toBeTruthy();
		const bili = tableRow("B 站甲");
		// 核心资料缓存没有远端头像网址,没有图库引用就画首字。
		expect(bili.querySelector("img")).toBeNull();
		expect(within(bili).queryByText("抖")).toBeNull();
		expect(within(bili).queryByText(/直播中/)).toBeNull();

		// 热力图那一行的色点 = 订阅卡的颜色(按「拓展 id:外部 id」取,不按那串恰好相同的数字)。
		const heatDot = (name: string) => {
			const label = screen
				.getAllByText(name)
				.find((el) => el.previousElementSibling?.tagName === "SPAN");
			return (label?.previousElementSibling as HTMLElement | undefined)?.style.background;
		};
		expect(heatDot("抖音乙")).toBe(cssColor(subscriptionColor(EXT_SUB, undefined)));
		expect(heatDot("B 站甲")).toBe(
			cssColor(subscriptionColor(BILI_SUB, { colorByExternalId: true })),
		);
		expect(subscriptionColor(EXT_SUB, undefined)).not.toBe(
			subscriptionColor(BILI_SUB, { colorByExternalId: true }),
		);

		// 两位都在盯,总粉丝量两支一起加(1000 + 5000)。
		expect(screen.getByText(/正在跟踪/).textContent).toContain("2");
		expect(screen.getByText("6000")).toBeTruthy();
	});

	it("点拓展那一行 → 聚焦的是它(外部 id 与某个 uid 相同也不串):页头写平台名 + 外部 id;单人锐评两张卡照样出", async () => {
		renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		await userEvent.click(tableRow("抖音乙"));

		const title = await screen.findByText(/粉丝增减、投稿与直播情况/);
		expect(title.textContent).toContain("抖音");
		expect(title.textContent).toContain("12345");
		expect(title.textContent).not.toContain("UID");
		expect(screen.queryByRole("table")).toBeNull();
		// 聚焦的颜色也是它自己的。
		expect(within(title).getByText("12345").style.color).toBe(
			cssColor(subscriptionColor(EXT_SUB, undefined)),
		);
		// 单人锐评与它的定时两支都有(ADR-0020 决策 14)。
		expect(screen.getByText("定时锐评")).toBeTruthy();
		expect(screen.getByText("AI 锐评 · 抖音乙")).toBeTruthy();
		expect(screen.getByRole("button", { name: "启用 抖音乙 的定时锐评" })).toBeTruthy();
	});

	it("点 B 站那一行 → 页头照旧写 UID,单人锐评两张卡照旧在", async () => {
		renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		await userEvent.click(tableRow("B 站甲"));

		const title = await screen.findByText(/粉丝增减、投稿与直播情况/);
		expect(title.textContent).toContain("UID");
		expect(title.textContent).toContain("12345");
		expect(title.textContent).not.toContain("抖音");
		expect(screen.getByText("定时锐评")).toBeTruthy();
		expect(screen.getByText("AI 锐评 · B 站甲")).toBeTruthy();
	});

	it("UP 选择器里两支都在,挑拓展那位聚焦到它", async () => {
		renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		await userEvent.click(screen.getByRole("button", { name: /全部订阅/ }));
		const items = screen.getAllByRole("button").filter((b) => b.textContent?.includes("抖音乙"));
		expect(items.length).toBeGreaterThan(0);
		expect(screen.getAllByRole("button").some((b) => b.textContent?.includes("B 站甲"))).toBe(true);
		await userEvent.click(items.at(-1) as HTMLElement);
		const title = await screen.findByText(/粉丝增减、投稿与直播情况/);
		expect(title.textContent).toContain("抖音");
	});

	it("名字链:资料里没名字的拓展行 → 外部 id(别名已退役,ADR-0021 决策 16);订阅列表还没回来也不写「UID undefined」", async () => {
		const noName = { ...EXT_SUB, cachedProfile: undefined };
		mockApi([BILI_ROW, EXT_ROW], [BILI_SUB, noName]);
		const { unmount } = renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		expect(tableRow("抖音 · 12345")).toBeTruthy();
		expect(screen.queryByText("抖音乙")).toBeNull();
		expect(screen.queryByText(/UID/)).toBeNull();
		unmount();

		mockApi([EXT_ROW], []);
		renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		expect(tableRow("抖音 · 12345")).toBeTruthy();
		expect(screen.queryByText(/UID/)).toBeNull();
	});
});

describe("统计 CSV 当前来源叫法与原始身份", () => {
	it.each([false, true])("单来源/混合=%s：列名照来源集合，外部ID保留前导零", async (mixed) => {
		const first = { ...EXT_ROW, identity: { sourceKey: "douyin", externalId: "0007" } };
		const rows = mixed
			? [first, { ...BILI_ROW, identity: { sourceKey: "bilibili", externalId: "0012" } }]
			: [first];
		vi.mocked(api.get).mockImplementation(async (path) => {
			if (path === "/api/settings") return { core: makeDefaultGlobalSettings() };
			if (path.startsWith("/api/stats/overview")) return { days: DAYS, rows };
			if (path === "/api/subscriptions") return [];
			if (path === "/api/sources")
				return {
					sources: [
						makeSource(),
						{
							...DOUYIN_SOURCE,
							descriptor: {
								...DOUYIN_SOURCE.descriptor,
								creatorNoun: "播主",
								externalIdNoun: "账号编号",
							},
						},
					],
				};
			return new Promise(() => {});
		});
		const create = vi.fn(() => "blob:csv");
		vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const blob = vi.fn();
		vi.stubGlobal(
			"Blob",
			class {
				constructor(parts: string[]) {
					blob(parts.join(""));
				}
			},
		);
		try {
			renderStats();
			await userEvent.click(await screen.findByRole("button", { name: "导出 CSV" }));
			const csv = blob.mock.calls[0]?.[0] as string;
			expect(csv.split("\n")[0]).toContain(mixed ? "创作者,平台,ID," : "播主,平台,账号编号,");
			expect(csv).toContain(",抖音,0007,");
			if (mixed) expect(csv).toContain(",B 站,0012,");
			expect(api.patch).not.toHaveBeenCalled();
		} finally {
			click.mockRestore();
		}
	});
});

describe("统计页 · 观看那两格改名(ADR-0020 决策 11)", () => {
	it("对比表表头「单场最高观看」,悬停说明是那句话", async () => {
		renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		const head = screen.getByRole("button", { name: /单场最高观看/ });
		expect(head.getAttribute("title")).toBe("按每场累计看过的人数算");
		expect(screen.queryByText(/峰值/)).toBeNull();
	});

	it("单人视图的直播概览:「单场最高观看 / 场均观看」,旁边一句「按每场累计看过的人数算」", async () => {
		renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		await userEvent.click(tableRow("抖音乙"));
		await screen.findByText(/粉丝增减、投稿与直播情况/);
		expect(screen.getByText("单场最高观看")).toBeTruthy();
		expect(screen.getByText("场均观看")).toBeTruthy();
		expect(screen.getByText(/按每场累计看过的人数算/)).toBeTruthy();
		expect(screen.getByText("2000")).toBeTruthy();
		expect(screen.getByText("1500")).toBeTruthy();
		expect(screen.queryByText(/峰值/)).toBeNull();
	});
});

describe("统计页 · 锐评两支都管(ADR-0020 决策 12 / 14 / 18)", () => {
	/** 订阅 id 里带着要转义的字符 —— 验面板把它编码进路径,不是原样拼。 */
	const ODD_ID = "s/dy 甲";
	const ODD_ROW = { ...EXT_ROW, subscriptionId: ODD_ID };
	const ODD_SUB: Subscription = {
		...EXT_SUB,
		id: ODD_ID,
		roastSchedule: { ...EXT_SUB.roastSchedule, targets: ["t1"] },
	};

	it("拓展行的单人锐评:按编码过的订阅 id 请求", async () => {
		mockApi([BILI_ROW, ODD_ROW], [BILI_SUB, ODD_SUB]);
		// 只要请求发出去了就行,回什么不重要:让它失败(生成没成是非 2xx 的错误)。
		(api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("占位"));
		renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		await userEvent.click(tableRow("抖音乙"));
		await userEvent.click(await screen.findByRole("button", { name: "生成 AI 锐评" }));
		await waitFor(() => expect(api.post).toHaveBeenCalled());
		const path = String((api.post as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
		expect(path.startsWith(`/api/stats/roast/${encodeURIComponent(ODD_ID)}?`)).toBe(true);
	});

	it("拓展行的定时锐评「试一次」:按编码过的订阅 id 跑那一条,不是榜单", async () => {
		mockApi([BILI_ROW, ODD_ROW], [BILI_SUB, ODD_SUB]);
		// 回一个合规的结局(200 + { ok: true, outcome }):回什么不重要,但得是这个接口真会回的形状。
		(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			outcome: { kind: "no-targets" },
		});
		renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		await userEvent.click(tableRow("抖音乙"));
		await userEvent.click(await screen.findByRole("button", { name: "试一次" }));
		await userEvent.click(await screen.findByRole("button", { name: "真的发出去" }));
		await waitFor(() => expect(api.post).toHaveBeenCalled());
		expect((api.post as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
			`/api/stats/roast/run/${encodeURIComponent(ODD_ID)}`,
		);
	});

	it("榜单结果按订阅 id 回指:两支的人都认得出,名字照统计行那一份", async () => {
		(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			result: {
				pigeon: { subscriptionId: "s-dy", reason: "鸽了一个月" },
				diligent: { subscriptionId: "s-bili", reason: "天天更新" },
				roast: [{ subscriptionId: "s-dy", comment: "咕咕咕" }],
				scores: [
					{ subscriptionId: "s-bili", score: 90 },
					{ subscriptionId: "s-dy", score: 10 },
				],
				pushText: "",
			},
		});
		renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		await userEvent.click(screen.getByRole("button", { name: "生成 AI 锐评" }));
		const reason = await screen.findByText("鸽了一个月");
		const pigeonCard = reason.parentElement as HTMLElement;
		expect(within(pigeonCard).getByText("抖音乙")).toBeTruthy();
		const diligentCard = screen.getByText("天天更新").parentElement as HTMLElement;
		expect(within(diligentCard).getByText("B 站甲")).toBeTruthy();
		expect(screen.getByText("咕咕咕").previousElementSibling?.textContent).toBe("抖音乙");
		expect(screen.queryByText(/UID s-/)).toBeNull();
	});
});

describe("统计总开关", () => {
	it("停用保存失败保留启用选中态和统计内容，可再次停用", async () => {
		renderStats();
		await screen.findByRole("table");
		vi.mocked(api.patch).mockRejectedValueOnce(new Error("写入失败"));
		const controls = screen.getByRole("group", { name: "统计记录" });
		await userEvent.click(within(controls).getByRole("button", { name: "停用" }));
		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			"保存统计开关失败：写入失败",
		);
		expect(
			within(controls).getByRole("button", { name: "启用" }).getAttribute("aria-pressed"),
		).toBe("true");
		expect(screen.getByRole("table")).toBeTruthy();
		mockApi([BILI_ROW], [BILI_SUB], [], false);
		vi.mocked(api.patch).mockResolvedValueOnce({
			core: { ...makeDefaultGlobalSettings(), stats: { enabled: false } },
		});
		await userEvent.click(within(controls).getByRole("button", { name: "停用" }));
		await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
		expect(screen.queryByRole("alert")).toBeNull();
		expect(api.patch).toHaveBeenLastCalledWith("/api/settings", {
			core: { stats: { enabled: false } },
		});
	});

	it("页头始终保留启用/停用段选，停用仅保存统计开关并收起内容", async () => {
		renderStats();
		await screen.findByRole("table");
		const controls = screen.getByRole("group", { name: "统计记录" });
		expect(
			within(controls).getByRole("button", { name: "启用" }).getAttribute("aria-pressed"),
		).toBe("true");
		mockApi([BILI_ROW, EXT_ROW], [BILI_SUB, EXT_SUB], [DOUYIN], false);
		vi.mocked(api.patch).mockResolvedValueOnce({
			core: { ...makeDefaultGlobalSettings(), stats: { enabled: false } },
		});
		await userEvent.click(within(controls).getByRole("button", { name: "停用" }));
		expect(api.patch).toHaveBeenCalledWith("/api/settings", {
			core: { stats: { enabled: false } },
		});
		await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
		expect(screen.getByRole("group", { name: "统计记录" })).toBe(controls);
		expect(
			within(controls).getByRole("button", { name: "停用" }).getAttribute("aria-pressed"),
		).toBe("true");
		expect(api.delete).not.toHaveBeenCalled();
	});

	it("设置刷新为关闭时卸下已显示的图表与锐评，不因缓存仍有统计而继续显示", async () => {
		const { qc } = renderStats();
		await screen.findByRole("table");
		mockApi([BILI_ROW, EXT_ROW], [BILI_SUB, EXT_SUB], [DOUYIN], false);
		await act(async () => {
			await qc.invalidateQueries({ queryKey: SETTINGS_KEY });
		});
		await screen.findByText("停止记录作品、直播和粉丝样本；已有数据保留，订阅资料仍照常刷新。");
		expect(screen.queryByRole("table")).toBeNull();
		expect(screen.queryByRole("button", { name: "导出 CSV" })).toBeNull();
		expect(screen.queryByRole("button", { name: "生成 AI 锐评" })).toBeNull();
		expect(api.delete).not.toHaveBeenCalled();
	});

	it("设置刷新失败不沿用缓存中的开启态，重试读到关闭后才展示开启入口", async () => {
		const { qc } = renderStats();
		await screen.findByRole("table");
		const read = vi.mocked(api.get).getMockImplementation();
		vi.mocked(api.get).mockImplementation(async (path) => {
			if (path === "/api/settings") throw new Error("读取失败");
			return read?.(path);
		});
		await act(async () => {
			await qc.invalidateQueries({ queryKey: SETTINGS_KEY });
		});
		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			"统计开关读取失败，当前状态未知。",
		);
		expect(screen.queryByRole("table")).toBeNull();
		expect(screen.queryByRole("button", { name: "启用" })).toBeNull();
		mockApi([BILI_ROW], [BILI_SUB], [], false);
		await userEvent.click(screen.getByRole("button", { name: "重试读取统计开关" }));
		await screen.findByRole("button", { name: "启用" });
		expect(screen.queryByRole("alert")).toBeNull();
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("开启失败保留关闭态和重试入口，不读取统计或清理数据", async () => {
		mockApi([BILI_ROW], [BILI_SUB], [], false);
		vi.mocked(api.patch).mockRejectedValueOnce(new Error("写入失败"));
		renderStats();
		await userEvent.click(await screen.findByRole("button", { name: "启用" }));
		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			"保存统计开关失败：写入失败",
		);
		expect(screen.getByRole("button", { name: "启用" }).hasAttribute("disabled")).toBe(false);
		expect(screen.queryByRole("table")).toBeNull();
		expect(vi.mocked(api.get).mock.calls.map(([path]) => path)).toEqual(["/api/settings"]);
		expect(api.delete).not.toHaveBeenCalled();
		mockApi([BILI_ROW], [BILI_SUB], []);
		vi.mocked(api.patch).mockResolvedValueOnce({ core: makeDefaultGlobalSettings() });
		await userEvent.click(screen.getByRole("button", { name: "启用" }));
		await screen.findByRole("table");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("开启只保存stats.enabled，响应成功前保留关闭态，成功后恢复已有统计", async () => {
		mockApi([BILI_ROW, EXT_ROW], [BILI_SUB, EXT_SUB], [DOUYIN], false);
		let finish!: (value: unknown) => void;
		vi.mocked(api.patch).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		renderStats();
		const button = await screen.findByRole("button", { name: "启用" });
		await userEvent.click(button);
		expect(api.patch).toHaveBeenCalledWith("/api/settings", { core: { stats: { enabled: true } } });
		expect(button.matches(":disabled")).toBe(true);
		expect(screen.getByRole("button", { name: "停用" }).matches(":disabled")).toBe(true);
		expect(screen.queryByRole("table")).toBeNull();
		mockApi([BILI_ROW, EXT_ROW], [BILI_SUB, EXT_SUB]);
		await act(async () => finish({ core: makeDefaultGlobalSettings() }));
		await screen.findByRole("table");
		expect(tableRow("抖音乙")).toBeTruthy();
		expect(
			screen.queryByText("停止记录作品、直播和粉丝样本；已有数据保留，订阅资料仍照常刷新。"),
		).toBeNull();
	});

	it("关闭时只留说明和开启入口，不读取统计、订阅或挂载锐评", async () => {
		mockApi([BILI_ROW, EXT_ROW], [BILI_SUB, EXT_SUB], [DOUYIN], false);
		renderStats();
		expect(
			await screen.findByText("停止记录作品、直播和粉丝样本；已有数据保留，订阅资料仍照常刷新。"),
		).toBeTruthy();
		expect(
			screen.getByText("停止记录作品、直播和粉丝样本；已有数据保留，订阅资料仍照常刷新。"),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "启用" })).toBeTruthy();
		expect(screen.queryByRole("table")).toBeNull();
		expect(screen.queryByRole("button", { name: "导出 CSV" })).toBeNull();
		expect(screen.queryByRole("button", { name: "生成 AI 锐评" })).toBeNull();
		expect(vi.mocked(api.get).mock.calls.map(([path]) => path)).toEqual(["/api/settings"]);
		expect(api.patch).not.toHaveBeenCalled();
	});
});

it("切换语言刷新统计表头与画像轴名，保留选中的订阅", async () => {
	const user = userEvent.setup();
	renderStats();
	await screen.findByRole("table");
	act(() => i18n.set({ locale: "en" }));
	expect(screen.getByRole("columnheader", { name: /Video posts/ })).toBeTruthy();
	await user.click(within(tableRow("抖音乙")).getByText("抖音乙"));
	expect(screen.getAllByText("Video posts").length).toBeGreaterThan(0);
	act(() => i18n.set({ locale: "zh-CN" }));
	expect(screen.queryByText("Video posts")).toBeNull();
	expect(screen.getByText("投稿量")).toBeTruthy();
	expect(screen.getByText("AI 锐评 · 抖音乙")).toBeTruthy();
});

it("statistics page language changes retain the chosen window, creator and original measurements without writes", async () => {
	const user = userEvent.setup();
	renderStats();
	await screen.findByRole("table");
	act(() => i18n.set({ locale: "en" }));
	expect(screen.getByText("Statistics · Followers and activity")).toBeTruthy();
	expect(screen.getByText(/Tracking /).textContent).toBe(
		"Tracking 2 subscriptions for follower changes, posts and live-stream frequency.",
	);
	const period = screen.getAllByRole("button", { name: "Past 7 days" })[0];
	if (!period) throw new Error("The seven-day range is missing");
	await user.click(period);
	await user.click(within(tableRow("抖音乙")).getByText("抖音乙"));
	for (const [locale, trend, content, live, current, window] of [
		[
			"ja",
			"抖音乙 · フォロワー数の推移",
			"コンテンツ構成",
			"配信の概要",
			"現在のフォロワー数",
			"過去7日間の純増",
		],
		["zh-TW", "抖音乙 · 粉絲總量走勢", "內容組成", "直播概覽", "目前粉絲", "近7日淨增"],
		[
			"en",
			"抖音乙 · Follower count trend",
			"Content mix",
			"Live overview",
			"Current followers",
			"7-day net change",
		],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByText(trend)).toBeTruthy();
		expect(screen.getByText(content)).toBeTruthy();
		expect(screen.getByText(live)).toBeTruthy();
		expect(screen.getAllByText(current).length).toBeGreaterThan(0);
		expect(screen.getByText(window)).toBeTruthy();
		expect(
			screen.getByText(
				locale === "ja"
					? "AIレビュー · 抖音乙"
					: locale === "zh-TW"
						? "AI 銳評 · 抖音乙"
						: "AI review · 抖音乙",
			),
		).toBeTruthy();
		expect(screen.getAllByText("抖音乙").length).toBeGreaterThan(0);
		expect(screen.getByText("12345")).toBeTruthy();
		expect(screen.queryByRole("table")).toBeNull();
	}
	expect(api.patch).not.toHaveBeenCalled();
	expect(api.post).not.toHaveBeenCalled();
	expect(api.delete).not.toHaveBeenCalled();
});

it.each([1, 2])(
	"English statistics pluralize the subscription, activity-day and stream units for count %s",
	async (count) => {
		i18n.set({ locale: "en", voice: "plain" });
		const activity = Array.from({ length: DAYS }, (_, i) => (i < count ? 1 : null));
		mockApi(
			count === 1
				? [{ ...BILI_ROW, activity }]
				: [
						{ ...BILI_ROW, activity },
						{ ...EXT_ROW, activity },
					],
			count === 1 ? [BILI_SUB] : [BILI_SUB, EXT_SUB],
		);
		renderStats();
		await screen.findByRole("table");
		expect(screen.getByText(/Tracking /).textContent).toBe(
			count === 1
				? "Tracking 1 subscription for follower changes, posts and live-stream frequency."
				: "Tracking 2 subscriptions for follower changes, posts and live-stream frequency.",
		);
		expect(screen.getByText(count === 1 ? "video" : "videos")).toBeTruthy();
		expect(screen.getByText(count === 1 ? "stream · 2h" : "streams · 4h")).toBeTruthy();
		expect(
			screen.getByText(count === 1 ? "per day · 1 day recorded" : "per day · 2 days recorded"),
		).toBeTruthy();
		await userEvent.setup().click(within(tableRow("B 站甲")).getByText("B 站甲"));
		expect(screen.getByText("stream")).toBeTruthy();
		expect(screen.getAllByText("video")).toHaveLength(2);
		expect(api.patch).not.toHaveBeenCalled();
		expect(api.post).not.toHaveBeenCalled();
	},
);

it("statistics recording controls translate while retaining a failed save and the confirmed enabled state", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	renderStats();
	await screen.findByRole("table");
	const controls = screen.getByRole("group", { name: "Statistics recording" });
	vi.mocked(api.patch).mockRejectedValueOnce(new Error("原始诊断"));
	await userEvent.setup().click(within(controls).getByRole("button", { name: "Disable" }));
	await screen.findByRole("alert");
	for (const [locale, group, enable, disable, error] of [
		[
			"ja",
			"統計の記録",
			"有効にする",
			"無効にする",
			"統計記録の設定を保存できませんでした: 原始诊断",
		],
		["zh-TW", "統計記錄", "啟用", "停用", "無法儲存統計開關：原始诊断"],
		[
			"en",
			"Statistics recording",
			"Enable",
			"Disable",
			"Could not save statistics recording: 原始诊断",
		],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByRole("group", { name: group })).toBe(controls);
		expect(
			within(controls).getByRole("button", { name: enable }).getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			within(controls).getByRole("button", { name: disable }).getAttribute("aria-pressed"),
		).toBe("false");
		expect(screen.getByRole("alert").textContent).toBe(error);
		expect(screen.getByRole("table")).toBeTruthy();
	}
	expect(api.patch).toHaveBeenCalledOnce();
	expect(api.patch).toHaveBeenCalledWith("/api/settings", { core: { stats: { enabled: false } } });
});
