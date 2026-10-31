// @vitest-environment jsdom
/**
 * 首页「粉丝数变化」面板也列拓展订阅(ADR-0020 决策 8)。
 *
 * 条目按订阅 id 记(`FollowersRefreshEntry.subscriptionId`),每条带 `identity`(来源键 + 外部 id)。面板按
 * 订阅 id 对订阅:名字走订阅卡那条链(资料里的名字 → 别名 → 外部 id),拓展行标一枚平台徽章(同「正在直播」),
 * 头像是那条订阅的。起点 / 24h / 7d 三格两支同一个画法。
 */

import type { ExtensionDTO, SourceEntry } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { FollowersRefreshEntry } from "../../services/dashboard";
import { makeEmptySubscription, type Subscription } from "../../types/domain";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";
import { FansPanel } from "../Dashboard";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const DOUYIN: ExtensionDTO = {
	id: "douyin",
	name: "抖音订阅",
	dir: "/data/extensions/douyin",
	enabled: true,
	state: "running",
	apiVersion: 1,
	provides: ["subscription"],
};

/** 来源表里抖音那一行:平台徽章的名字与颜色照它。 */
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

function biliSub(id: string, uid: string, name: string): Subscription {
	return {
		...makeEmptySubscription({ sourceKey: "bilibili", externalId: uid }),
		id,
		cachedProfile: { name, refreshedAt: "2026-09-24T00:00:00Z" },
	};
}

function extSub(id: string, externalId: string, over: Partial<Subscription> = {}) {
	return { ...makeEmptySubscription({ sourceKey: "douyin", externalId: externalId }), id, ...over };
}

const BILI_ENTRY: FollowersRefreshEntry = {
	subscriptionId: "s-bili",
	identity: { sourceKey: "bilibili", externalId: "12345" },
	current: 1000,
	refreshedAt: "2026-09-24T00:00:00Z",
	deltaSubscribed: 10,
	delta24h: 1,
	delta7d: 5,
};
const EXT_ENTRY: FollowersRefreshEntry = {
	subscriptionId: "s-dy",
	identity: { sourceKey: "douyin", externalId: "sec-1" },
	current: 22_222,
	refreshedAt: "2026-09-24T00:00:00Z",
	deltaSubscribed: 3_333,
	delta24h: -44,
	delta7d: null,
};

/** 来源表照装着的拓展列:装了抖音订阅源,表里就有它那一行。 */
function sourcesOf(extensions: ExtensionDTO[] | undefined): SourceEntry[] | undefined {
	return extensions?.flatMap((one) => (one.id === DOUYIN.id ? [DOUYIN_SOURCE] : []));
}

function renderPanel(
	entries: FollowersRefreshEntry[],
	subs: Subscription[],
	extensions?: ExtensionDTO[],
) {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path === "/api/stats/followers") return Promise.resolve({ entries });
		return Promise.reject(new Error(`没料到的请求 ${path}`));
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<FansPanel subs={subs} sources={sourcesOf(extensions)} extensions={extensions} />
		</QueryClientProvider>,
	);
}

describe("粉丝数变化 · 拓展订阅", () => {
	it("两支都列:拓展行名字照订阅资料、平台徽章照清单、头像是那条订阅的;三格照画", async () => {
		const { container } = renderPanel(
			[BILI_ENTRY, EXT_ENTRY],
			[
				biliSub("s-bili", "12345", "B 站甲"),
				extSub("s-dy", "sec-1", {
					cachedProfile: {
						name: "抖音乙",
						avatar: `${"d".repeat(64)}.png`,
						refreshedAt: "2026-09-24T00:00:00Z",
					},
				}),
			],
			[DOUYIN],
		);
		await waitFor(() => expect(screen.getByText("抖音乙")).toBeTruthy());
		expect(screen.getByText("B 站甲")).toBeTruthy();
		expect(screen.getByText("抖")).toBeTruthy();
		expect(screen.getByText("● 2 位订阅")).toBeTruthy();
		expect(screen.getByText("2.2万 粉丝")).toBeTruthy();
		expect(screen.getByText("+3333")).toBeTruthy();
		expect(screen.getByText("-44")).toBeTruthy();
		expect(container.querySelector(`img[src="/api/images/${"d".repeat(64)}.png"]`)).not.toBeNull();
		expect(screen.queryByText(/UID/)).toBeNull();
	});

	it("名字链:资料名 → 外部 id(别名已退役,ADR-0021 决策 16);不写「UID undefined」", async () => {
		renderPanel(
			[
				EXT_ENTRY,
				{
					...EXT_ENTRY,
					subscriptionId: "s-dy2",
					identity: { sourceKey: "douyin", externalId: "sec-2" },
				},
			],
			[
				extSub("s-dy", "sec-1", {
					cachedProfile: {
						name: "资料里的名",
						refreshedAt: "2026-09-24T00:00:00Z",
					},
				}),
				extSub("s-dy2", "sec-2"),
			],
			[DOUYIN],
		);
		await waitFor(() => expect(screen.getByText("资料里的名")).toBeTruthy());
		expect(screen.getByText("sec-2")).toBeTruthy();
		expect(screen.queryByText(/UID/)).toBeNull();
	});

	// 验红:兜底改回只写外部 id,拓展行少了平台名,这条红。
	it("订阅列表还没回来:拓展行写「平台名 · 外部 id」(平台名照清单,清单也没回来写拓展 id),B 站行写 UID", async () => {
		const first = renderPanel([BILI_ENTRY, EXT_ENTRY], [], [DOUYIN]);
		await waitFor(() => expect(screen.getByText("抖音 · sec-1")).toBeTruthy());
		expect(screen.getByText("UID 12345")).toBeTruthy();
		first.unmount();
		cleanup();
		renderPanel([BILI_ENTRY, EXT_ENTRY], []);
		await waitFor(() => expect(screen.getByText("douyin · sec-1")).toBeTruthy());
		expect(screen.getByText("UID 12345")).toBeTruthy();
	});

	it("外部 id 恰好等于某个 B 站 uid:两行各对各的订阅,不串人", async () => {
		renderPanel(
			[BILI_ENTRY, { ...EXT_ENTRY, identity: { sourceKey: "douyin", externalId: "12345" } }],
			[
				biliSub("s-bili", "12345", "B 站甲"),
				extSub("s-dy", "12345", {
					cachedProfile: {
						name: "抖音同号",
						refreshedAt: "2026-09-24T00:00:00Z",
					},
				}),
			],
			[DOUYIN],
		);
		await waitFor(() => expect(screen.getByText("抖音同号")).toBeTruthy());
		expect(screen.getAllByText("B 站甲")).toHaveLength(1);
	});
});
