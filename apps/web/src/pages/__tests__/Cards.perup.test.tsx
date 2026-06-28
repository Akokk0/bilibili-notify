// @vitest-environment jsdom

/**
 * Cards 页 per-UP 作用域接线测试。
 *
 * 验证:① 全局作用域以 pageKey "cards" 注册灵动岛;② 点已定制 UP 的 tab 切到
 * pageKey "cards-perup";③ per-UP 保存只下发卡片三片(cardStyle + cardStyleByKind
 * + cardLayout),不碰该 sub 的其它 overrides slice;④ 已有按类型覆盖往返不丢;
 * ⑤ 全局 tab 右侧铺四卡全家福(四种 kind 各发一次预览)。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// 已定制 UP:只有 cardStyle 覆盖(无 cardLayout),并带一个无关 slice(imageGroup)
// 用来确认 per-UP 保存不会动它。
const CUSTOMIZED: Subscription = {
	...makeEmptySubscription("123456"),
	overrides: {
		cardStyle: { cardColorStart: "#123456" },
		imageGroup: { enable: false },
	},
};

const GLOBALS = {
	app: {},
	master: {},
	defaults: makeDefaults(),
} as unknown as GlobalConfig;

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

function renderCards() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Cards />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url.includes("/api/subs")) return Promise.resolve([CUSTOMIZED]);
		if (url.includes("/api/targets")) return Promise.resolve([]);
		return Promise.resolve(GLOBALS);
	});
	// 预览走 puppeteer 路由,测试里给个假数据 URL 即可。
	vi.mocked(api.post).mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,xx" });
	vi.mocked(api.patch).mockResolvedValue(CUSTOMIZED);
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

describe("Cards per-UP 作用域接线", () => {
	it("全局作用域 → 以 pageKey 'cards' 注册灵动岛", async () => {
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
	});

	it("全局 tab → 四张卡各发一次预览(全家福,取代旧的内层 kind 选择器)", async () => {
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));

		// 全局 tab 右侧铺四张卡:live/dyn/sc/guard 各应发出一次预览请求(旧版只发当前选中一种)。
		await waitFor(
			() => {
				const kinds = new Set(
					vi
						.mocked(api.post)
						.mock.calls.filter(([url]) => url === "/api/cards/preview")
						.map(([, body]) => (body as { kind?: string }).kind),
				);
				expect(kinds).toEqual(new Set(["live", "dyn", "sc", "guard"]));
			},
			{ timeout: 2000 },
		);
	});

	it("点已定制 UP 的 tab → 灵动岛切到 pageKey 'cards-perup'", async () => {
		renderCards();
		// 等全局先就位,确保 subs 已加载、tab 已渲染。
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));
	});

	it("切到 per-UP → 预览改用该 UP 真实数据(uid)+ fallback:true", async () => {
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		// 预览 POST 有 500ms 防抖;等防抖追上后那次「真实数据(uid)+ fallback」请求落地
		// (默认 kind=live;中间会有 content 尚未追上的过渡请求,故须同时匹配 uid)。
		await waitFor(
			() => {
				const call = vi.mocked(api.post).mock.calls.find(([url, body]) => {
					const b = body as { fallback?: boolean; content?: { uid?: string } };
					return (
						url === "/api/cards/preview" && b?.fallback === true && b.content?.uid === "123456"
					);
				});
				expect(call).toBeTruthy();
			},
			{ timeout: 2000 },
		);
	});

	it("per-UP 切到 SC → 预览带该 UP 的 uid(后端据此渲染真实接收方)", async () => {
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));
		// 卡片类型选择在左侧 SectionNav。它响应式渲染竖栏 + 横向条两份(jsdom 不应用 CSS,
		// 两个同名按钮都在 DOM),取第一个点击即可切到 SC。
		fireEvent.click(screen.getAllByRole("button", { name: "SC 提醒" })[0]);

		await waitFor(
			() => {
				const call = vi.mocked(api.post).mock.calls.find(([url, body]) => {
					const b = body as { kind?: string; content?: { uid?: string } };
					return url === "/api/cards/preview" && b?.kind === "sc" && b.content?.uid === "123456";
				});
				expect(call).toBeTruthy();
			},
			{ timeout: 2000 },
		);
	});

	it("per-UP 保存 → 只 PATCH cardStyle + cardLayout(cardLayout 未覆盖 = null)", async () => {
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		// 经灵动岛触发保存(页内无保存按钮,统一走灵动岛 onSave)。
		useDraftStore.getState().current?.onSave();

		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		const [url, body] = vi.mocked(api.patch).mock.calls.at(-1) as [string, { overrides: unknown }];
		expect(url).toBe(`/api/subs/${CUSTOMIZED.id}`);
		const overrides = body.overrides as Record<string, unknown>;
		// 只含卡片三片:cardStyle 为完整快照、cardLayout 未覆盖故 null、cardStyleByKind 无
		// 按类型覆盖故 null;不带 imageGroup(不动该 UP 其它 slice)。
		expect(Object.keys(overrides).sort()).toEqual(["cardLayout", "cardStyle", "cardStyleByKind"]);
		expect(overrides.cardLayout).toBeNull();
		expect(overrides.cardStyleByKind).toBeNull();
		expect((overrides.cardStyle as { cardColorStart: string }).cardColorStart).toBe("#123456");
	});

	it("per-UP 已有按类型覆盖 → 保存原样下发 cardStyleByKind(不丢)", async () => {
		// 仅含 cardStyleByKind 覆盖的 UP(无基准 cardStyle)：确认它进 tab、seed 进草稿、
		// 保存时按类型覆盖原样回传,基准 cardStyle 仍下发 null。
		const byKindSub: Subscription = {
			...makeEmptySubscription("654321"),
			overrides: {
				cardStyleByKind: { sc: { cardColorStart: "#abcdef" } },
				imageGroup: { enable: false },
			},
		};
		vi.mocked(api.get).mockImplementation((url: string) => {
			if (url.includes("/api/subs")) return Promise.resolve([byKindSub]);
			if (url.includes("/api/targets")) return Promise.resolve([]);
			return Promise.resolve(GLOBALS);
		});

		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 654321"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		useDraftStore.getState().current?.onSave();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		const [url, body] = vi.mocked(api.patch).mock.calls.at(-1) as [string, { overrides: unknown }];
		expect(url).toBe(`/api/subs/${byKindSub.id}`);
		const overrides = body.overrides as Record<string, unknown>;
		expect(overrides.cardStyle).toBeNull();
		expect(overrides.cardStyleByKind).toEqual({ sc: { cardColorStart: "#abcdef" } });
	});

	it("per-UP 动态 → 选「第几条」,offset 进预览请求", async () => {
		const { container } = renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		// 切到动态类型(SectionNav 竖栏 + 横向条两份,取第一个)。
		fireEvent.click(screen.getAllByRole("button", { name: "动态发布" })[0]);

		// 把「第几条动态」改成 3。
		const offsetInput = await waitFor(() => {
			const el = container.querySelector('[data-code="offset"] input');
			if (!el) throw new Error("offset input not rendered");
			return el as HTMLInputElement;
		});
		fireEvent.change(offsetInput, { target: { value: "3" } });

		// 防抖后预览 POST 用该 UP 的 uid + 所选 offset(证明不再写死 1)。
		await waitFor(
			() => {
				const call = vi.mocked(api.post).mock.calls.find(([url, body]) => {
					const b = body as { kind?: string; content?: { uid?: string; offset?: number } };
					return (
						url === "/api/cards/preview" &&
						b?.kind === "dyn" &&
						b.content?.uid === "123456" &&
						b.content?.offset === 3
					);
				});
				expect(call).toBeTruthy();
			},
			{ timeout: 2000 },
		);
	});
});
