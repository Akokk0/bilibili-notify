// @vitest-environment jsdom

/**
 * 回归测试 —— 逐订阅的直播封面覆盖(`overrides.cards.liveCoverImageIds`),关得掉、也分得清「空列表」。
 *
 * 复现路径(用户报告,当时还叫 per-kind 覆盖):图片渲染 → 直播卡片 tab → 打开覆盖 → 保存 →
 * 再关掉 → 保存 → 刷新回来开关又是开的。
 *
 * 根因不在开关本身,在**下发方式**。PATCH 走 JSON Merge Patch 语义:键消失 =
 * 「该字段不改」,只有显式 `null` 才是删除(见 `store.ts` 的 deepMerge)。关掉覆盖在网络上必须是
 * `overrides.cards: null`,而不是把键丢掉。㉔e 把「按卡种」与基准两层并成了 `overrides.cards` 这一格,
 * 守卫跟着搬到这里;另一头是「打开覆盖、一张都不选」要存成 `[]`(这位 UP 不用自定义封面),不是不存。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";
import Cards from "../Cards";
import { makeDefaults } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

// 皮肤库那节的「编辑」钮要跳编辑器路由,所以这一页现在吃 router context。
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

/** 切到某个卡片类型 tab。用 desc 定位:label「直播开播」在全家福里也有一份。 */
function pickKindTab(desc: string): void {
	const btn = screen.getByText(desc).closest("button");
	if (!btn) throw new Error(`找不到类型 tab「${desc}」`);
	fireEvent.click(btn);
}

/** GlassBox 的开关在标题所在卡片的头部 —— 取该卡片文档序第一个 button。 */
function toggleOf(title: string): HTMLButtonElement {
	const box = screen.getByText(title).closest(".bn-glass");
	const btn = box?.querySelector("button");
	if (!btn) throw new Error(`找不到「${title}」的开关`);
	return btn as HTMLButtonElement;
}

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.post).mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,xx" });
	vi.mocked(api.patch).mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.post).mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,xx" });
	vi.mocked(api.patch).mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

type PatchBody = { overrides: { cards: { liveCoverImageIds?: string[] } | null } };

async function openPerUp(sub: Subscription): Promise<void> {
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url.includes("/api/subscriptions")) return Promise.resolve([sub]);
		if (url.includes("/api/targets")) return Promise.resolve([]);
		if (url.includes("/api/cards/skins")) {
			return Promise.resolve({
				skins: [{ id: "default", name: "默认皮肤", builtin: true, updatedAt: 0 }],
				active: "default",
			});
		}
		return Promise.resolve({
			app: {},
			master: {},
			defaults: makeDefaults(),
		} as unknown as GlobalConfig);
	});
	renderCards();
	await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
	fireEvent.click(await screen.findByText("UID 123456"));
	await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));
	pickKindTab("开播 / 直播中 / 下播");
}

describe("逐订阅的直播封面覆盖", () => {
	// 验红:把 Cards.tsx 里 savePerUp 的 `: null` 换成 `: undefined`,键消失,这条红。
	it("关掉覆盖 → PATCH 里 cards 显式为 null(否则后端当没说)", async () => {
		await openPerUp({
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "123456" }),
			overrides: { cards: { liveCoverImageIds: ["img1"] } },
		});
		fireEvent.click(await waitFor(() => toggleOf("直播封面")));

		useDraftStore.getState().current?.onSave();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [string, PatchBody];
		// 键必须在,且为 null。键消失 = 「这个字段不改」,后端 deepMerge 会原样留着旧覆盖。
		expect(body.overrides).toHaveProperty("cards");
		expect(body.overrides.cards).toBeNull();
	});

	// 验红:把 savePerUp 里 `puCover !== undefined` 改成 `puCover?.length`,空列表被当成「没覆盖」,这条红。
	it("打开覆盖、一张都不选(全局也没有封面)→ 存成 []:这位 UP 不用自定义封面,不是「没设」", async () => {
		await openPerUp({
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "123456" }),
			// 只指了皮肤、没设封面:这位 UP 在「已定制」名单里(否则点不进去),而封面是跟随态。
			overrides: { cardSkin: "default" },
		});
		fireEvent.click(await waitFor(() => toggleOf("直播封面")));

		useDraftStore.getState().current?.onSave();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [string, PatchBody];
		expect(body.overrides.cards).toEqual({ liveCoverImageIds: [] });
	});
});
