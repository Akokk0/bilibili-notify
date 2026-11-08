// @vitest-environment jsdom
import { chooseSelect, selectOptionsOf } from "../../__tests__/select-controls";
import { i18n } from "../../i18n";

/**
 * 卡片页预览挑订阅(4-14):全局作用域的房间号 / uid 输入框换成「从订阅里挑一条」(可不挑)。挑了,预览请求带上
 * 那条订阅的 id(作品再带第几条),真数据由服务端问它的来源要;服务端画成示例时带回原因,面板写在图下面。
 * 订阅一律可挑,不再只有 B 站的(按订阅覆盖对所有订阅开放,ADR-0021 决策 12)。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import type { GlobalSettings } from "../../types/globals";
import Cards from "../Cards";
import { makeDefaults, makeSource } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() },
	ApiError: class extends Error {},
	OFFLINE_STATUS: 0,
}));

import { api } from "../../services/api";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

const GLOBALS = { logging: {}, master: {}, defaults: makeDefaults() } as unknown as GlobalSettings;

const BILI: Subscription = makeEmptySubscription({ sourceKey: "bilibili", externalId: "123456" });
const DOUYIN: Subscription = makeEmptySubscription({ sourceKey: "douyin", externalId: "sec-1" });

interface PreviewBody {
	kind: string;
	content?: Record<string, unknown>;
}

function previewBodies(kind: string): PreviewBody[] {
	return vi
		.mocked(api.post)
		.mock.calls.filter(([url]) => url === "/api/cards/preview")
		.map(([, body]) => body as PreviewBody)
		.filter((b) => b.kind === kind);
}

function renderCards() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<MemoryRouter>
			<QueryClientProvider client={qc}>
				<Cards />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

/** 切到「动态发布」那张卡(左侧导航竖栏 + 横向条两份,取第一个)。 */
async function openPostCard() {
	await waitFor(() => expect(screen.getAllByText("作品发布").length).toBeGreaterThan(0), {
		timeout: 5000,
	});
	fireEvent.click(screen.getAllByRole("button", { name: "作品发布" })[0] as HTMLElement);
}

function subscriptionSelect(container: HTMLElement): HTMLButtonElement {
	const el = container.querySelector('[data-code="subscriptionId"] [role="combobox"]');
	if (!el) throw new Error("subscription picker not rendered");
	return el as HTMLButtonElement;
}

beforeEach(() => {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url.includes("/api/subscriptions")) return Promise.resolve([BILI, DOUYIN]);
		if (url.includes("/api/targets")) return Promise.resolve([]);
		if (url === "/api/sources") return Promise.resolve({ sources: [makeSource()] });
		return Promise.resolve({ core: GLOBALS });
	});
	vi.mocked(api.post).mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,xx" });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("卡片预览挑订阅", () => {
	it("全局作用域:订阅下拉列出全部订阅(拓展的也在),默认不挑;作品卡不挑时不带订阅与第几条", async () => {
		const { container } = renderCards();
		await openPostCard();
		const select = await waitFor(() => subscriptionSelect(container));
		const options = selectOptionsOf(select).map((o) => o.textContent);
		expect(options).toEqual(["不挑，用示例", "UID 123456", "douyin · sec-1"]);
		expect(select.textContent).toBe("不挑，用示例");
		// 没挑订阅:「第几条作品」不出现,请求里作品卡一格都不带(服务端画示例)。
		expect(container.querySelector('[data-code="nth"]')).toBeNull();
		await waitFor(() => expect(previewBodies("post").length).toBeGreaterThan(0), { timeout: 5000 });
		expect(previewBodies("post").at(-1)?.content).toEqual({});
	});

	// 验红:把 Cards.tsx 的 previewContentOf 里作品那一支改回不带订阅 id,这条红。
	it("全局作用域:挑了一条订阅,作品卡请求带它的 id 与第几条,「第几条作品」这才出现", async () => {
		const { container } = renderCards();
		await openPostCard();
		const select = await waitFor(() => subscriptionSelect(container));
		chooseSelect(select, "douyin · sec-1");
		await waitFor(() => expect(container.querySelector('[data-code="nth"] input')).not.toBeNull());
		await waitFor(
			() =>
				expect(previewBodies("post").at(-1)?.content).toEqual({
					subscriptionId: DOUYIN.id,
					nth: 1,
				}),
			{ timeout: 5000 },
		);
	});

	// 验红:把 PreviewImage 里那行 `reasonLine` 去掉(或不把 sampleReason 带出 queryFn),这条红。
	it("服务端画成示例时带回原因:写在预览图下面", async () => {
		vi.mocked(api.post).mockResolvedValue({
			ok: true,
			dataUrl: "data:image/png;base64,xx",
			sampleReason: "这位创作者还没有作品",
		});
		renderCards();
		await openPostCard();
		expect(
			await screen.findByText(/这位创作者还没有作品/, undefined, { timeout: 5000 }),
		).toBeTruthy();
	});
});
