// @vitest-environment jsdom
/**
 * 首页「粉丝数变化」面板也列拓展订阅(ADR-0020 决策 8)。
 *
 * 条目按订阅 id 记(`FansRefreshEntry.subscriptionId`),B 站条目带 uid、拓展条目带拓展 id + 外部 id。面板按
 * 订阅 id 对订阅:名字走订阅卡那条链(资料里的名字 → 别名 → 外部 id),拓展行标一枚平台徽章(同「正在直播」),
 * 头像是那条订阅的。起点 / 24h / 7d 三格两支同一个画法。
 */

import type { ExtensionDTO } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { FansEntry } from "../../services/dashboard";
import {
	type ExtensionSubscription,
	makeEmptyExtensionSubscription,
	makeEmptySubscription,
	type Subscription,
} from "../../types/domain";

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
	apiVersion: 2,
	provides: ["subscription"],
	subscription: {
		display: { label: "抖音", shortLabel: "抖", color: "#161823" },
		events: ["post", "liveStart", "liveEnd"],
	},
};

function biliSub(id: string, uid: string, name: string): Subscription {
	return {
		...makeEmptySubscription(uid),
		id,
		cachedProfile: { name, avatar: "", sign: "", lastRefreshedAt: "2026-09-24T00:00:00Z" },
	};
}

function extSub(id: string, externalId: string, over: Partial<ExtensionSubscription> = {}) {
	return { ...makeEmptyExtensionSubscription("douyin", externalId), id, ...over };
}

const BILI_ENTRY: FansEntry = {
	subscriptionId: "s-bili",
	uid: "12345",
	current: 1000,
	ts: "2026-09-24T00:00:00Z",
	deltaSubscribed: 10,
	delta24h: 1,
	delta7d: 5,
};
const EXT_ENTRY: FansEntry = {
	subscriptionId: "s-dy",
	extensionId: "douyin",
	externalId: "sec-1",
	current: 22_222,
	ts: "2026-09-24T00:00:00Z",
	deltaSubscribed: 3_333,
	delta24h: -44,
	delta7d: null,
};

function renderPanel(entries: FansEntry[], subs: Subscription[], extensions?: ExtensionDTO[]) {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path === "/api/fans") return Promise.resolve({ entries });
		return Promise.reject(new Error(`没料到的请求 ${path}`));
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<FansPanel subs={subs} extensions={extensions} />
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
						avatar: "/api/subs/s-dy/avatar?v=abc",
						sign: "",
						lastRefreshedAt: "2026-09-24T00:00:00Z",
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
		expect(screen.getByText("+3,333")).toBeTruthy();
		expect(screen.getByText("-44")).toBeTruthy();
		expect(container.querySelector('img[src="/api/subs/s-dy/avatar?v=abc"]')).not.toBeNull();
		expect(screen.queryByText(/UID/)).toBeNull();
	});

	it("名字链:资料里没名字 → 主人起的别名 → 外部 id;不写「UID undefined」", async () => {
		renderPanel(
			[EXT_ENTRY, { ...EXT_ENTRY, subscriptionId: "s-dy2", externalId: "sec-2" }],
			[extSub("s-dy", "sec-1", { name: "主人起的名" }), extSub("s-dy2", "sec-2")],
			[DOUYIN],
		);
		await waitFor(() => expect(screen.getByText("主人起的名")).toBeTruthy());
		expect(screen.getByText("sec-2")).toBeTruthy();
		expect(screen.queryByText(/UID/)).toBeNull();
	});

	it("订阅列表还没回来:拓展行写外部 id,B 站行照旧写 UID", async () => {
		renderPanel([BILI_ENTRY, EXT_ENTRY], []);
		await waitFor(() => expect(screen.getByText("sec-1")).toBeTruthy());
		expect(screen.getByText("UID 12345")).toBeTruthy();
	});

	it("外部 id 恰好等于某个 B 站 uid:两行各对各的订阅,不串人", async () => {
		renderPanel(
			[BILI_ENTRY, { ...EXT_ENTRY, externalId: "12345" }],
			[biliSub("s-bili", "12345", "B 站甲"), extSub("s-dy", "12345", { name: "抖音同号" })],
			[DOUYIN],
		);
		await waitFor(() => expect(screen.getByText("抖音同号")).toBeTruthy());
		expect(screen.getAllByText("B 站甲")).toHaveLength(1);
	});
});
