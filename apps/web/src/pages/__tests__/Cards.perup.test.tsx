// @vitest-environment jsdom

/**
 * Cards 页 per-UP 作用域接线测试。
 *
 * 验证:① 全局作用域以 pageKey "cards" 注册灵动岛;② 点已定制 UP 的 tab 切到
 * pageKey "cards-perup";③ per-UP 保存只下发卡片三片(cardStyle + cardStyleByKind
 * + cardSkin),不碰该 sub 的其它 overrides slice;④ 已有按类型覆盖往返不丢;
 * ⑤ 全局 tab 右侧铺四卡全家福(四种 kind 各发一次预览)。
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

// 已定制 UP:只有 cardStyle 覆盖(无 cardSkin),并带一个无关 slice(imageGroup)
// 用来确认 per-UP 保存不会动它。
const CUSTOMIZED: Subscription = {
	...makeEmptySubscription("123456"),
	overrides: {
		cardStyle: { font: "PerUP Sans" },
		imageGroup: { enable: false },
	},
};

const GLOBALS = {
	app: {},
	master: {},
	defaults: makeDefaults(),
} as unknown as GlobalConfig;

/** 皮肤库列表(GET /api/card-skins):内置那份 + 一套自制的。 */
const SKINS = {
	skins: [
		{ id: "default", name: "默认皮肤", builtin: true, updatedAt: 0 },
		{ id: "aurora", name: "极光", builtin: false, updatedAt: 1 },
	],
	active: "default",
};

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

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url.includes("/api/subs")) return Promise.resolve([CUSTOMIZED]);
		if (url.includes("/api/targets")) return Promise.resolve([]);
		if (url.includes("/api/card-skins")) return Promise.resolve(SKINS);
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

	/**
	 * **皮肤要跟着请求走**(ADR-0014)。服务端对「没指皮肤」的解释是「全局在用的那套」,
	 * 所以全局作用域一个字都不用传;但 per-UP 单独指了一套时不传就永远看不到它 ——
	 * 选择器上写着「单独指定」、预览里却是全局那张,两边对不上。
	 */
	it("per-UP 指了皮肤 → 预览请求带上它", async () => {
		const skinned: Subscription = {
			...makeEmptySubscription("123456"),
			overrides: { cardSkin: "aurora" },
		};
		vi.mocked(api.get).mockImplementation((url: string) => {
			if (url.includes("/api/subs")) return Promise.resolve([skinned]);
			if (url.includes("/api/targets")) return Promise.resolve([]);
			if (url.includes("/api/card-skins")) return Promise.resolve(SKINS);
			return Promise.resolve(GLOBALS);
		});

		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		await waitFor(
			() => {
				const call = vi.mocked(api.post).mock.calls.find(([url, body]) => {
					const b = body as { cardSkin?: string };
					return url === "/api/cards/preview" && b?.cardSkin === "aurora";
				});
				expect(call).toBeTruthy();
			},
			{ timeout: 2000 },
		);
	});

	it("全局作用域不传皮肤 —— 缺省只归服务端解释,面板别再抄一份", async () => {
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		await waitFor(
			() => {
				expect(
					vi.mocked(api.post).mock.calls.filter(([url]) => url === "/api/cards/preview").length,
				).toBeGreaterThan(0);
			},
			{ timeout: 2000 },
		);
		const withSkin = vi.mocked(api.post).mock.calls.find(([url, body]) => {
			const b = body as { cardSkin?: string };
			return url === "/api/cards/preview" && b?.cardSkin !== undefined;
		});
		expect(withSkin).toBeFalsy();
	});

	it("per-UP 保存 → 只 PATCH cardStyle + cardSkin(cardSkin 未覆盖 = null)", async () => {
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
		// 只含卡片三片:cardStyle 为完整快照、cardSkin 未覆盖故 null、cardStyleByKind 无
		// 按类型覆盖故 null;不带 imageGroup(不动该 UP 其它 slice)。
		expect(Object.keys(overrides).sort()).toEqual(["cardSkin", "cardStyle", "cardStyleByKind"]);
		expect(overrides.cardSkin).toBeNull();
		expect(overrides.cardStyleByKind).toBeNull();
		expect((overrides.cardStyle as { font: string }).font).toBe("PerUP Sans");
	});

	it("per-UP 已有按类型覆盖 → 保存原样下发 cardStyleByKind(不丢)", async () => {
		// 仅含 cardStyleByKind 覆盖的 UP(无基准 cardStyle)：确认它进 tab、seed 进草稿、
		// 保存时按类型覆盖原样回传,基准 cardStyle 仍下发 null。
		const byKindSub: Subscription = {
			...makeEmptySubscription("654321"),
			overrides: {
				cardStyleByKind: { sc: { font: "SC Sans" } },
				imageGroup: { enable: false },
			},
		};
		vi.mocked(api.get).mockImplementation((url: string) => {
			if (url.includes("/api/subs")) return Promise.resolve([byKindSub]);
			if (url.includes("/api/targets")) return Promise.resolve([]);
			if (url.includes("/api/card-skins")) return Promise.resolve(SKINS);
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
		// 有覆盖的类型原样带上,没覆盖过的**不**凭空发 null —— 删除哨兵只发给「基线
		// 里有、草稿里没了」的键(见 buildPatch)。关掉已保存的类型会发 null,那条在
		// Cards.bykind-off.test.tsx。
		expect(overrides.cardStyleByKind).toEqual({ sc: { font: "SC Sans" } });
	});

	it("per-UP live 外观 + 封面共存于 cardStyleByKind.live,保存两者都不丢", async () => {
		// 字段不相交(外观 omitCover、封面 pickCover)→ seed 同时含两类覆盖时往返保留。
		// 从前的第三族「数据区 show」2026-09-14 随三个开关一起退役。
		const mixedSub: Subscription = {
			...makeEmptySubscription("555666"),
			overrides: { cardStyleByKind: { live: { font: "Abc Sans", liveCoverImages: ["c1"] } } },
		};
		vi.mocked(api.get).mockImplementation((url: string) => {
			if (url.includes("/api/subs")) return Promise.resolve([mixedSub]);
			if (url.includes("/api/targets")) return Promise.resolve([]);
			if (url.includes("/api/card-skins")) return Promise.resolve(SKINS);
			return Promise.resolve(GLOBALS);
		});

		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 555666"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		useDraftStore.getState().current?.onSave();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [string, { overrides: unknown }];
		const overrides = body.overrides as { cardStyleByKind?: { live?: Record<string, unknown> } };
		expect(overrides.cardStyleByKind?.live).toEqual({
			font: "Abc Sans",
			liveCoverImages: ["c1"],
		});
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
	// ── per-UP 卡片皮肤(ADR-0014 决策 17)───────────────────────────────────
	//
	// 「选一套」与「选回跟随全局」是两条不同的线:前者要把 id 写进 overrides,后者
	// 要把这个键**清掉**。后者尤其容易写成「键消失」——JSON 里表达不出 undefined,
	// 服务端读作「不改」,于是选回跟随全局永远不生效(本仓「配置 PATCH 的删除语义」)。

	it("per-UP 选一套皮肤 → PATCH 的 overrides 带 cardSkin", async () => {
		const { container } = renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		const select = await waitFor(() => {
			const el = container.querySelector('[data-code="cardSkin"] select');
			if (!el) throw new Error("cardSkin select not rendered");
			return el as HTMLSelectElement;
		});
		// 列表里的那套自制皮肤要真的是个选项 —— 下拉只有「跟随全局」的话下面这一步
		// 会把 value 设成空串,断言反而看不出问题。
		expect([...select.options].map((o) => o.value)).toContain("aurora");
		fireEvent.change(select, { target: { value: "aurora" } });

		useDraftStore.getState().current?.onSave();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [string, { overrides: unknown }];
		expect((body.overrides as { cardSkin?: unknown }).cardSkin).toBe("aurora");
	});

	it("per-UP 选回「跟随全局」→ PATCH 把 cardSkin 清成 null(不是键消失)", async () => {
		const skinned: Subscription = {
			...makeEmptySubscription("999000"),
			overrides: { cardSkin: "aurora" },
		};
		vi.mocked(api.get).mockImplementation((url: string) => {
			if (url.includes("/api/subs")) return Promise.resolve([skinned]);
			if (url.includes("/api/targets")) return Promise.resolve([]);
			if (url.includes("/api/card-skins")) return Promise.resolve(SKINS);
			return Promise.resolve(GLOBALS);
		});

		const { container } = renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 999000"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		const select = await waitFor(() => {
			const el = container.querySelector('[data-code="cardSkin"] select');
			if (!el) throw new Error("cardSkin select not rendered");
			return el as HTMLSelectElement;
		});
		// 先确认存量覆盖 seed 进了下拉(否则「清掉」测的是一个本来就空的值)。
		expect(select.value).toBe("aurora");
		fireEvent.change(select, { target: { value: "" } });

		useDraftStore.getState().current?.onSave();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [string, { overrides: unknown }];
		const overrides = body.overrides as Record<string, unknown>;
		expect("cardSkin" in overrides).toBe(true);
		expect(overrides.cardSkin).toBeNull();
	});
});
