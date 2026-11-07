// @vitest-environment jsdom

/**
 * 高级规则页 × 拓展订阅(ADR-0019 决策 64 / 72,ADR-0021 决策 43)。
 *
 * - 拓展订阅也能加 tab、能单独定制。
 * - 只露通用的几节:作品过滤(关键词 / 正则 / 白名单,**四个类型开关也露**:过滤吃 `Post`、类型开关对所有来源生效)、作品消息 /
 *   直播消息的文案、消息版式、推送时段(免扰;报直播时再加推送频率那几格,SC / 上舰阈值不露)、
 *   AI 人格。作品图集(决策 72)、直播总结、会员提示、特别关注不露。
 * - 源没声明的特性对应的节也不露(只报作品就不露直播消息)。
 * - 存得进、清得掉:发出去的 patch 只带 overrides(拓展订阅没有特别关注那一格)。
 */

import type { ExtensionEntryView, SourceEntry } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";
import Rules from "../Rules";
import { makeAi, makeDefaults, makeSource } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

/** 描述符声明的特性。 */
type Declared = SourceEntry["descriptor"]["supportedFeatures"];

const DOUYIN: ExtensionEntryView = {
	id: "douyin",
	name: "抖音订阅",
	dir: "/data/extensions/douyin",
	enabled: true,
	state: "running",
	apiVersion: 1,
	provides: ["subscription"],
};

/** 来源表里抖音那一行(取自清单)。 */
function source(supportedFeatures: Declared): SourceEntry {
	return {
		status: "running",
		key: "douyin",
		descriptor: {
			label: "抖音",
			shortLabel: "抖音",
			color: "#161823",
			postNoun: "作品",
			supportedFeatures,
		},
	};
}

function extSub(over: Partial<Subscription> = {}): Subscription {
	return {
		...makeEmptySubscription({ sourceKey: "douyin", externalId: "sec-2" }),
		cachedProfile: { name: "抖音乙", followers: 3, refreshedAt: "t" },
		...over,
	};
}

const BILI: Subscription = makeEmptySubscription({ sourceKey: "bilibili", externalId: "111" });

function globals(): GlobalConfig {
	const defaults = makeDefaults();
	defaults.schedule.quietHours = [{ start: 23, end: 7 }];
	return { logging: {}, master: {}, defaults, ai: makeAi() } as unknown as GlobalConfig;
}

let subs: Subscription[];
let features: Declared;

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	subs = [BILI, extSub()];
	features = ["post"];
	vi.mocked(api.get).mockImplementation((url: string) => {
		// `/api/subscriptions/tags` 也以 `/api/subscriptions` 开头:订阅列表那条必须精确匹配,别让标签表串味进来。
		if (url === "/api/subscriptions/tags") return Promise.resolve([]);
		if (url === "/api/subscriptions") return Promise.resolve(subs);
		if (url === "/api/ext") return Promise.resolve({ extensions: [DOUYIN] });
		if (url === "/api/sources")
			return Promise.resolve({ sources: [makeSource(), source(features)] });
		return Promise.resolve({ core: globals() });
	});
	vi.mocked(api.patch).mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

function renderRules() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Rules />
		</QueryClientProvider>,
	);
}

/** 竖栏里列出的那几节(窄视口那条横条是同一批,只数一份)。 */
function railLabels(container: HTMLElement): string[] {
	const rail = container.querySelector('[data-section-nav="rail"]');
	return Array.from(rail?.querySelectorAll('[data-bn~="nav-item"] .truncate') ?? []).map(
		(el) => el.textContent ?? "",
	);
}

function pickSection(container: HTMLElement, label: string): void {
	const rail = container.querySelector('[data-section-nav="rail"]');
	const item = Array.from(rail?.querySelectorAll('[data-bn~="nav-item"]') ?? []).find(
		(el) => el.querySelector(".truncate")?.textContent === label,
	);
	if (!item) throw new Error(`竖栏里没有「${label}」`);
	fireEvent.click(item);
}

/** 从「添加 UP」下拉里把拓展订阅加成一个 tab。等平台名出来,说明拓展列表已经回来了。 */
async function addExtensionTab(): Promise<void> {
	fireEvent.click(await screen.findByTitle("从订阅列表添加个性化配置"));
	await screen.findByText("抖音 · sec-2");
	fireEvent.click(screen.getByText("抖音乙"));
	await screen.findByText("抖音乙 · 覆盖项");
}

function diffCodes(): string[] {
	return useDraftStore.getState().current?.diff.map((d) => d.code) ?? [];
}

async function saveIsland(): Promise<void> {
	const onSave = useDraftStore.getState().current?.onSave as (() => Promise<void>) | undefined;
	await onSave?.();
}

describe("高级规则 × 拓展订阅:能加 tab", () => {
	it("「添加 UP」里列出拓展订阅,标着「平台名 · 外部 id」;加进来之后右边写明仅作用于它", async () => {
		renderRules();
		await addExtensionTab();
		expect(screen.getByText("抖音 · sec-2", { selector: "b" })).toBeTruthy();
	});
});

describe("高级规则 × 拓展订阅:露哪几节", () => {
	it("只报作品:过滤 / 作品消息 / 版式 / 推送时段 / AI 人格;图集、直播那几节、B 站独有的都不露", async () => {
		const { container } = renderRules();
		await addExtensionTab();
		await waitFor(() =>
			expect(railLabels(container)).toEqual([
				"作品过滤",
				"作品图集",
				"作品消息",
				"消息版式",
				"推送时段",
				"AI 人格",
			]),
		);
	});

	it("报作品也报直播:多出直播消息;直播阈值、直播总结、会员提示、特别关注照样不露", async () => {
		features = ["post", "liveStart", "liveStreaming", "liveEnd"];
		const { container } = renderRules();
		await addExtensionTab();
		await waitFor(() =>
			expect(railLabels(container)).toEqual([
				"作品过滤",
				"作品图集",
				"作品消息",
				"消息版式",
				"推送时段",
				"直播消息",
				"AI 人格",
			]),
		);
	});

	it("只报直播:作品过滤与作品消息不露", async () => {
		features = ["liveStart", "liveStreaming", "liveEnd"];
		const { container } = renderRules();
		await addExtensionTab();
		await waitFor(() =>
			expect(railLabels(container)).toEqual(["消息版式", "推送时段", "直播消息", "AI 人格"]),
		);
	});

	it("B 站订阅照旧全露", async () => {
		subs = [{ ...BILI, overrides: { imageGroup: { enabled: true, mergeForward: false } } }];
		const { container } = renderRules();
		fireEvent.click(await screen.findByText("UID 111"));
		await waitFor(() => expect(railLabels(container)).toContain("直播阈值"));
		expect(railLabels(container)).toEqual([
			"作品过滤",
			"作品图集",
			"作品消息",
			"消息版式",
			"直播阈值",
			"直播总结",
			"直播消息",
			"会员提示",
			"特别关注弹幕",
			"特别关注进房",
			"AI 人格",
		]);
	});
});

describe("高级规则 × 拓展订阅:编辑器里的格", () => {
	it("作品过滤:四个类型开关也在;开覆盖带齐关键词 / 正则 / 白名单与四个开关", async () => {
		const { container } = renderRules();
		await addExtensionTab();
		pickSection(container, "作品过滤");
		fireEvent.click(await screen.findByLabelText("覆盖:作品过滤覆盖"));

		await waitFor(() => expect(diffCodes()).toContain("blockKeywords"));
		expect(screen.getByText("屏蔽关键词")).toBeTruthy();
		for (const label of ["屏蔽转发作品", "屏蔽文章作品", "屏蔽图文作品", "屏蔽视频作品"]) {
			expect(screen.getByText(label)).toBeTruthy();
		}
		for (const code of [
			"blockKeywords",
			"blockRegex",
			"allowKeywords",
			"blockReposts",
			"blockArticles",
			"blockImages",
			"blockVideos",
		]) {
			expect(diffCodes()).toContain(code);
		}
	});

	it("推送时段(只报作品):只有免扰,没有 SC / 上舰阈值,也没有直播的推送频率", async () => {
		const { container } = renderRules();
		await addExtensionTab();
		pickSection(container, "推送时段");
		fireEvent.click(await screen.findByLabelText("覆盖:推送时段覆盖"));

		expect(await screen.findByText("免扰时段")).toBeTruthy();
		for (const label of ["SC 最低金额", "上舰最低等级", "状态推送间隔", "断流接续"]) {
			expect(screen.queryByText(label)).toBeNull();
		}
	});

	it("推送时段(报直播):免扰 + 推送频率那几格,仍然没有 SC / 上舰阈值", async () => {
		features = ["post", "liveStart", "liveStreaming", "liveEnd"];
		const { container } = renderRules();
		await addExtensionTab();
		await waitFor(() => expect(railLabels(container)).toContain("直播消息"));
		pickSection(container, "推送时段");
		fireEvent.click(await screen.findByLabelText("覆盖:推送时段覆盖"));

		expect(await screen.findByText("免扰时段")).toBeTruthy();
		expect(screen.getByText("状态推送间隔")).toBeTruthy();
		expect(screen.getByText("断流接续")).toBeTruthy();
		expect(screen.queryByText("SC 最低金额")).toBeNull();
		expect(screen.queryByText("上舰最低等级")).toBeNull();
	});

	it("消息版式(只报作品):只有作品那一套", async () => {
		const { container } = renderRules();
		await addExtensionTab();
		pickSection(container, "消息版式");
		fireEvent.click(await screen.findByLabelText("覆盖:消息版式覆盖"));

		expect(await screen.findByText("作品消息版式")).toBeTruthy();
		expect(screen.queryByText("直播消息版式")).toBeNull();
	});
});

describe("高级规则 × 拓展订阅:存与清", () => {
	it("开一节再保存:patch 只带 overrides,不带特别关注", async () => {
		const ext = extSub();
		subs = [BILI, ext];
		const { container } = renderRules();
		await addExtensionTab();
		pickSection(container, "推送时段");
		fireEvent.click(await screen.findByLabelText("覆盖:推送时段覆盖"));
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));

		await saveIsland();
		expect(api.patch).toHaveBeenCalledWith(`/api/subscriptions/${ext.id}`, {
			overrides: { schedule: { quietHours: [{ start: 23, end: 7 }] } },
		});
	});

	it("关掉已存的一节再保存:那一格发 null(清得掉)", async () => {
		const ext = extSub({ overrides: { templates: { post: "新作品!" } } });
		subs = [BILI, ext];
		const { container } = renderRules();
		// 已有覆盖的拓展订阅本来就在 tab 条上。
		fireEvent.click(await screen.findByText("抖音乙"));
		await screen.findByText("抖音乙 · 覆盖项");
		pickSection(container, "作品消息");
		fireEvent.click(await screen.findByLabelText("覆盖:作品消息覆盖"));
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));

		await saveIsland();
		expect(api.patch).toHaveBeenCalledWith(`/api/subscriptions/${ext.id}`, {
			overrides: { templates: null },
		});
	});

	it("移除的确认文案不提特别关注(拓展订阅没有这一项)", async () => {
		subs = [BILI, extSub({ overrides: { templates: { post: "新作品!" } } })];
		renderRules();
		fireEvent.click(await screen.findByTitle("移除 抖音乙 的个性化配置"));
		await screen.findByText("移除该订阅的个性化配置?");
		expect(screen.getByText(/的所有覆盖项,该订阅之后跟随全局规则。此操作不可撤销。/)).toBeTruthy();
		expect(screen.queryByText(/特别关注/)).toBeNull();
	});

	it("移除整条的个性化配置:每一格发 null,不带特别关注", async () => {
		const ext = extSub({ overrides: { templates: { post: "新作品!" } } });
		subs = [BILI, ext];
		renderRules();
		fireEvent.click(await screen.findByTitle("移除 抖音乙 的个性化配置"));
		await screen.findByText("移除该订阅的个性化配置?");
		fireEvent.click(screen.getByRole("button", { name: "移除" }));

		await waitFor(() =>
			expect(api.patch).toHaveBeenCalledWith(`/api/subscriptions/${ext.id}`, {
				overrides: { templates: null },
			}),
		);
	});
});
