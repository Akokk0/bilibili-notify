// @vitest-environment jsdom

/**
 * 订阅页列表里的拓展订阅(ADR-0019 决策 10 / 51):拓展没在跑的那条订阅置灰、写明「××拓展没在跑」;拓展列表
 * 没回来时不下结论。平台的名字取来源表(`/api/sources`,ADR-0027 决策 6),「在不在跑」看拓展列表。
 * 新建订阅弹窗(选平台、搜人、挑候选)在 `Subs.new-subscription.test.tsx`。
 */

import type { ExtensionEntryView, SourceEntry } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import Subscriptions from "../Subscriptions";

const { FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {}
	return { FakeApiError };
});

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: FakeApiError,
}));

import { i18n } from "../../i18n";
import { api } from "../../services/api";

// These scenarios assert Chinese UI labels explicitly.
beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

function source(over: Partial<ExtensionEntryView> = {}): ExtensionEntryView {
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
	descriptor: {
		label: "B 站",
		shortLabel: "B",
		color: "#fb7299",
		icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
		supportedFeatures: ["post"],
	},
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
let extensions: Promise<{ extensions: ExtensionEntryView[] }>;
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
				<Routes>
					<Route path="/subs" element={<Subscriptions />} />
					<Route path="/extensions/:id" element={<div>Source settings destination</div>} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("列表里的拓展订阅", () => {
	it("拓展停了 → 那张卡写「抖音来源未运行」", async () => {
		subs = [BILI, extSub()];
		extensions = Promise.resolve({
			extensions: [source({ state: "disabled", enabled: false })],
		});
		sources = [BILI_SOURCE, { ...DOUYIN_SOURCE, status: "disabled" }];
		renderSubs();
		expect(await screen.findByText("抖音来源未运行")).toBeTruthy();
	});

	it("拓展开着但没跑起来(加载失败)→ 同样写「抖音来源未运行」,不说「没开」", async () => {
		subs = [BILI, extSub()];
		extensions = Promise.resolve({
			extensions: [source({ state: "failed", enabled: true })],
		});
		sources = [BILI_SOURCE, { ...DOUYIN_SOURCE, status: "failed" }];
		renderSubs();
		expect(await screen.findByText("抖音来源未运行")).toBeTruthy();
	});

	it("拓展没装 → 拿不到名字,写拓展 id", async () => {
		subs = [BILI, extSub({ identity: { sourceKey: "kuaishou", externalId: "sec-2" } })];
		renderSubs();
		expect(await screen.findByText("kuaishou来源未安装")).toBeTruthy();
	});

	it("拓展在跑 → 不说「没在跑」,有平台徽章", async () => {
		subs = [BILI, extSub()];
		renderSubs();
		await screen.findByText("抖音乙");
		await waitFor(() => expect(screen.getByRole("img", { name: "抖音" })).toBeTruthy());
		expect(screen.queryByText(/来源未运行|来源未安装/)).toBeNull();
	});

	it("拓展列表还没回来 → 不下结论", async () => {
		subs = [BILI, extSub()];
		extensions = new Promise(() => {});
		renderSubs();
		await screen.findByText("抖音乙");
		expect(screen.queryByText(/来源未运行|来源未安装/)).toBeNull();
	});
});

it.each(["disabled", "failed", "running"] as const)(
	"%s 的来源入口只在对应订阅卡内,点击不打开订阅编辑",
	async (state) => {
		subs = [BILI, extSub()];
		extensions = Promise.resolve({
			extensions: [source({ state, enabled: state !== "disabled" })],
		});
		sources = [BILI_SOURCE, { ...DOUYIN_SOURCE, status: state, has: undefined }];
		renderSubs();
		const card = await screen.findByRole("button", { name: /抖音乙/ });
		const link = await within(card).findByRole("button", { name: "抖音订阅设置" });
		expect(link.textContent).toBe("");
		expect(link.getAttribute("title")).toBe("抖音订阅设置");
		fireEvent.click(link);
		expect(await screen.findByText("Source settings destination")).toBeTruthy();
	},
);

it("只展示当前订阅对应的拓展,不列其他已安装来源或推送拓展", async () => {
	subs = [BILI, extSub()];
	extensions = Promise.resolve({
		extensions: [
			source(),
			source({ id: "push-only", name: "推送专用", provides: ["push"] }),
			source({ id: "another-source", name: "其他来源" }),
		],
	});
	renderSubs();
	await screen.findByRole("button", { name: "抖音订阅设置" });
	expect(screen.getAllByRole("button", { name: /设置$/ })).toHaveLength(1);
});
it("拓展未安装时不从来源键拼设置链接", async () => {
	extensions = Promise.resolve({ extensions: [] });
	subs = [BILI, extSub()];
	renderSubs();
	await screen.findByText("抖音乙");
	expect(screen.queryAllByRole("button", { name: /设置$/ })).toHaveLength(0);
});

it("没有拓展订阅时不把已安装拓展列成页顶按钮", async () => {
	renderSubs();
	await screen.findByText("UP甲");
	expect(screen.queryAllByRole("button", { name: /设置$/ })).toHaveLength(0);
});
it.each(["{Enter}", " "])("来源设置按钮支持键盘 %s,不触发订阅卡的编辑操作", async (key) => {
	subs = [extSub()];
	renderSubs();
	const link = await screen.findByRole("button", { name: "抖音订阅设置" });
	link.focus();
	await userEvent.setup().keyboard(key);
	expect(await screen.findByText("Source settings destination")).toBeTruthy();
	expect(screen.queryByRole("dialog")).toBeNull();
});

it("平台用来源描述符图标显示,不把 B 短名画成文字徽章", async () => {
	renderSubs();
	const mark = await screen.findByRole("img", { name: "B 站" });
	expect(mark.querySelector("img")?.getAttribute("src")).toBe(
		"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
	);
	expect(screen.queryByText("B", { exact: true })).toBeNull();
});
