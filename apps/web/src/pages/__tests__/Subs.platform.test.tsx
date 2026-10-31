// @vitest-environment jsdom

/**
 * 订阅页列表里的拓展订阅(ADR-0019 决策 10 / 51):拓展没在跑的那条订阅置灰、写明「××拓展没在跑」;拓展列表
 * 没回来时不下结论。平台的名字取来源表(`/api/sources`,ADR-0027 决策 6),「在不在跑」看拓展列表。
 * 新建订阅弹窗(选平台、搜人、挑候选)在 `Subs.new-subscription.test.tsx`。
 */

import type { ExtensionDTO, SourceEntry } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import Subs from "../Subs";

const { FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {}
	return { FakeApiError };
});

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: FakeApiError,
}));

import { api } from "../../services/api";

function source(over: Partial<ExtensionDTO> = {}): ExtensionDTO {
	return {
		id: "douyin",
		name: "抖音订阅",
		dir: "/data/extensions/douyin",
		enabled: true,
		state: "running",
		apiVersion: 1,
		provides: ["subscription"],
		...over,
	};
}

/** 来源表里 B 站那一条:不是拓展,按登记先后在最前。 */
const BILI_SOURCE: SourceEntry = {
	status: "running",
	key: "bilibili",
	descriptor: { label: "B 站", shortLabel: "B", color: "#fb7299", supportedFeatures: ["post"] },
	has: { auth: true, liveStatus: true, preview: true },
};

const DOUYIN_SOURCE: SourceEntry = {
	status: "running",
	key: "douyin",
	descriptor: {
		label: "抖音",
		shortLabel: "抖音",
		color: "#161823",
		postNoun: "作品",
		searchAccepts: ["link"],
		supportedFeatures: ["post", "liveStart"],
	},
	has: { auth: false, liveStatus: false, preview: false },
};

function extSub(over: Partial<Subscription> = {}): Subscription {
	return {
		...makeEmptySubscription({ sourceKey: "douyin", externalId: "sec-2" }),
		cachedProfile: { name: "抖音乙", followers: 3, refreshedAt: "t" },
		...over,
	};
}

const BILI: Subscription = {
	...makeEmptySubscription({ sourceKey: "bilibili", externalId: "111" }),
	cachedProfile: { name: "UP甲", followers: 0, refreshedAt: "t" },
};

let subs: Subscription[];
let extensions: Promise<{ extensions: ExtensionDTO[] }>;
let sources: SourceEntry[];

beforeEach(() => {
	subs = [BILI];
	extensions = Promise.resolve({ extensions: [source()] });
	sources = [BILI_SOURCE, DOUYIN_SOURCE];
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		// `/api/subscriptions/tags` 也以 `/api/subscriptions` 开头:订阅列表那条必须精确匹配,别让标签表串味进来。
		if (path === "/api/subscriptions/tags") return Promise.resolve([]);
		if (path === "/api/subscriptions") return Promise.resolve(subs);
		if (path.startsWith("/api/targets")) return Promise.resolve([]);
		if (path === "/api/ext") return extensions;
		if (path === "/api/sources") return Promise.resolve({ sources });
		return Promise.resolve([]);
	});
	(api.post as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderSubs() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/subs"]}>
				<Subs />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("列表里的拓展订阅", () => {
	it("拓展停了 → 那张卡写「抖音拓展没在跑」", async () => {
		subs = [BILI, extSub()];
		extensions = Promise.resolve({
			extensions: [source({ state: "disabled", enabled: false })],
		});
		renderSubs();
		expect(await screen.findByText("抖音拓展没在跑")).toBeTruthy();
	});

	it("拓展开着但没跑起来(加载失败)→ 同样写「抖音拓展没在跑」,不说「没开」", async () => {
		subs = [BILI, extSub()];
		extensions = Promise.resolve({
			extensions: [source({ state: "failed", enabled: true })],
		});
		renderSubs();
		expect(await screen.findByText("抖音拓展没在跑")).toBeTruthy();
	});

	it("拓展没装 → 拿不到名字,写拓展 id", async () => {
		subs = [BILI, extSub({ identity: { sourceKey: "kuaishou", externalId: "sec-2" } })];
		renderSubs();
		expect(await screen.findByText("kuaishou拓展没在跑")).toBeTruthy();
	});

	it("拓展在跑 → 不说「没在跑」,有平台徽章", async () => {
		subs = [BILI, extSub()];
		renderSubs();
		await screen.findByText("抖音乙");
		await waitFor(() => expect(screen.getByText("抖音")).toBeTruthy());
		expect(screen.queryByText(/拓展没在跑/)).toBeNull();
	});

	it("拓展列表还没回来 → 不下结论", async () => {
		subs = [BILI, extSub()];
		extensions = new Promise(() => {});
		renderSubs();
		await screen.findByText("抖音乙");
		expect(screen.queryByText(/拓展没在跑/)).toBeNull();
	});
});
