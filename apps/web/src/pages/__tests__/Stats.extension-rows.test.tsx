// @vitest-environment jsdom
/**
 * 统计页也列拓展订阅(ADR-0020 决策 1 / 3 / 11)。
 *
 * - 行以**订阅 id** 为键,选中、聚焦都按它 —— 外部 id 恰好等于某个 B 站 uid 时,点的是谁就是谁。
 * - 颜色跟着人走:与订阅卡同一个颜色(`subscriptionColor`,ADR-0019 决策 73)。
 * - 名字走订阅卡那条链(资料里的名字 → 别名 → 外部 id);单人页头 B 站写「UID xxx」、拓展写「平台名 外部 id」。
 * - 汇总(总粉丝量、在盯几位)两支一起算。
 * - 「峰值观看 / 场均峰值」改成「单场最高观看 / 场均观看」,旁边一句「按每场累计看过的人数算」。
 * - 单人锐评与它的定时还只认 B 站(S6 才接拓展):聚焦到拓展行时那两张卡不出现,不摆一套点了也不灵的控件。
 */

import type { ExtensionDTO, UpStatsRow } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	type ExtensionSubscription,
	makeEmptyExtensionSubscription,
	makeEmptySubscription,
	type Subscription,
} from "../../types/domain";
import { subscriptionColor } from "../../utils/up-display";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";
import Stats from "../Stats";

const DAYS = 30;
const fill = <T,>(v: T) => Array.from({ length: DAYS }, () => v);

function row(over: Partial<UpStatsRow>): UpStatsRow {
	return {
		subscriptionId: "s-x",
		fans: 1000,
		net1d: 1,
		net7d: 7,
		netWindow: 30,
		series: fill(1),
		cumulative: fill(1000),
		activity: fill(1),
		archives: 1,
		dynamics: 2,
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
const BILI_ROW = row({ subscriptionId: "s-bili", uid: "12345", fans: 1000 });
/** 抖音乙:外部 id 恰好也是 12345 —— 另一个平台上的另一个人。正在播。 */
const EXT_ROW = row({
	subscriptionId: "s-dy",
	extensionId: "douyin",
	externalId: "12345",
	fans: 5000,
	live: true,
	maxViewers: 2000,
	avgViewers: 1500,
});

const BILI_SUB: Subscription = {
	...makeEmptySubscription("12345"),
	id: "s-bili",
	cachedProfile: { name: "B 站甲", avatar: "", sign: "", lastRefreshedAt: "2026-09-24T00:00:00Z" },
};
const EXT_SUB: ExtensionSubscription = {
	...makeEmptyExtensionSubscription("douyin", "12345"),
	id: "s-dy",
	// 拓展的头像是面板里的同源相对地址(资料上报存成文件),页面上照样画得出来。
	cachedProfile: {
		name: "抖音乙",
		avatar: "/api/subs/s-dy/avatar?v=abc",
		sign: "",
		lastRefreshedAt: "2026-09-24T00:00:00Z",
	},
};

const DOUYIN: ExtensionDTO = {
	id: "douyin",
	name: "抖音订阅",
	dir: "/data/extensions/douyin",
	enabled: true,
	state: "running",
	apiVersion: 2,
	provides: ["subscription"],
	subscription: {
		display: { label: "抖音", shortLabel: "抖", color: "#161823" },
		events: ["post", "liveStart", "liveEnd"],
	},
};

function mockApi(rows: UpStatsRow[], subs: Subscription[], extensions: ExtensionDTO[] = [DOUYIN]) {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path.startsWith("/api/stats/overview")) return Promise.resolve({ days: DAYS, rows });
		if (path === "/api/subs") return Promise.resolve(subs);
		if (path === "/api/ext") return Promise.resolve({ extensions });
		// 锐评那几张卡要的全局配置 / 推送目标 / 连接:这里不关心,一直等着。
		return new Promise(() => {});
	});
}

function renderStats() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Stats />
		</QueryClientProvider>,
	);
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
		expect(ext.querySelector('img[src="/api/subs/s-dy/avatar?v=abc"]')).not.toBeNull();
		expect(within(ext).getByText(/直播中/)).toBeTruthy();
		const bili = tableRow("B 站甲");
		expect(within(bili).queryByText("抖")).toBeNull();
		expect(within(bili).queryByText(/直播中/)).toBeNull();

		// 热力图那一行的色点 = 订阅卡的颜色(按「拓展 id:外部 id」取,不按那串恰好相同的数字)。
		const heatDot = (name: string) => {
			const label = screen
				.getAllByText(name)
				.find((el) => el.previousElementSibling?.tagName === "SPAN");
			return (label?.previousElementSibling as HTMLElement | undefined)?.style.background;
		};
		expect(heatDot("抖音乙")).toBe(cssColor(subscriptionColor(EXT_SUB)));
		expect(heatDot("B 站甲")).toBe(cssColor(subscriptionColor(BILI_SUB)));
		expect(subscriptionColor(EXT_SUB)).not.toBe(subscriptionColor(BILI_SUB));

		// 两位都在盯,总粉丝量两支一起加(1000 + 5000)。
		expect(screen.getByText(/女仆帮主人盯着/).textContent).toContain("2");
		expect(screen.getByText("6000")).toBeTruthy();
	});

	it("点拓展那一行 → 聚焦的是它(外部 id 与某个 uid 相同也不串):页头写平台名 + 外部 id;单人锐评两张卡不出现", async () => {
		renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		await userEvent.click(tableRow("抖音乙"));

		const title = await screen.findByText(/粉丝增减、投稿与直播情况/);
		expect(title.textContent).toContain("抖音");
		expect(title.textContent).toContain("12345");
		expect(title.textContent).not.toContain("UID");
		expect(screen.queryByRole("table")).toBeNull();
		// 聚焦的颜色也是它自己的。
		expect(within(title).getByText("12345").style.color).toBe(cssColor(subscriptionColor(EXT_SUB)));
		// S6 之前单人锐评只认 B 站:不出一套点了也不灵的控件。
		expect(screen.queryByText("定时锐评")).toBeNull();
		expect(screen.queryByText(/AI 锐评 · /)).toBeNull();
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
		await userEvent.click(screen.getByRole("button", { name: /全部 UP 主/ }));
		const items = screen.getAllByRole("button").filter((b) => b.textContent?.includes("抖音乙"));
		expect(items.length).toBeGreaterThan(0);
		expect(screen.getAllByRole("button").some((b) => b.textContent?.includes("B 站甲"))).toBe(true);
		await userEvent.click(items.at(-1) as HTMLElement);
		const title = await screen.findByText(/粉丝增减、投稿与直播情况/);
		expect(title.textContent).toContain("抖音");
	});

	it("名字链:资料里没名字的拓展行 → 别名 → 外部 id;订阅列表还没回来也不写「UID undefined」", async () => {
		const noName = { ...EXT_SUB, cachedProfile: undefined, name: "主人起的名" };
		mockApi([BILI_ROW, EXT_ROW], [BILI_SUB, noName]);
		const { unmount } = renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		expect(tableRow("主人起的名")).toBeTruthy();
		unmount();

		mockApi([EXT_ROW], []);
		renderStats();
		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		expect(tableRow("12345")).toBeTruthy();
		expect(screen.queryByText(/UID/)).toBeNull();
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
