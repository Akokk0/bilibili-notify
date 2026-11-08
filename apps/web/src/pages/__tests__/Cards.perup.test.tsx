// @vitest-environment jsdom
import { chooseSelect, selectOptionsOf } from "../../__tests__/select-controls";

/**
 * Cards 页 per-UP 作用域接线测试。
 *
 * 验证:① 全局作用域以 pageKey "cards" 注册灵动岛;② 点已定制 UP 的 tab 切到
 * pageKey "cards-perup";③ per-UP 保存只下发卡片三片(cards + cardSkin + cardSkinKnobs),
 * 不碰该 sub 的其它 overrides slice;④ 全局 tab 右侧铺四卡全家福(四种 kind 各发一次预览)。
 * (封面覆盖的关闭与空列表见 Cards.cover-override.test.tsx。)
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { useDraftStore } from "../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import type { GlobalSettings } from "../../types/globals";
import Cards from "../Cards";
import { makeDefaults, makeSource } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: {
		blob: vi.fn().mockRejectedValue(new Error("thumbnail unavailable in fixture")),
		get: vi.fn(),
		post: vi.fn(),
		patch: vi.fn(),
		upload: vi.fn(),
	},
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

// 已定制 UP:只有 cards 覆盖(无 cardSkin),并带一个无关 slice(imageGroup)
// 用来确认 per-UP 保存不会动它。
const CUSTOMIZED: Subscription = {
	...makeEmptySubscription({ sourceKey: "bilibili", externalId: "123456" }),
	overrides: {
		cards: { liveCoverImageIds: ["per-up-cover"] },
		imageGroup: { enabled: false },
	},
};

const GLOBALS = {
	logging: {},
	master: {},
	defaults: makeDefaults(),
} as unknown as GlobalSettings;

/** 皮肤库列表(GET /api/cards/skins):内置那份 + 一套自制的。 */
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
	return {
		...render(
			<MemoryRouter>
				<QueryClientProvider client={qc}>
					<Cards />
				</QueryClientProvider>
			</MemoryRouter>,
		),
		qc,
	};
}

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url === "/api/library/images") return Promise.resolve({ ok: true, ids: [] });
		if (url.includes("/api/subscriptions")) return Promise.resolve([CUSTOMIZED]);
		if (url.includes("/api/targets")) return Promise.resolve([]);
		if (url === "/api/sources") return Promise.resolve({ sources: [makeSource()] });
		if (url.includes("/api/cards/skins")) return Promise.resolve(SKINS);
		return Promise.resolve({ core: GLOBALS });
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
	it.each([
		[
			"en",
			"Card rendering",
			"Global",
			"Card previews · global settings",
			"Card previews · this subscription’s settings",
			"Card skin",
			"Remove custom card settings for this subscription?",
			"Cancel",
			"Remove custom settings for UID 123456",
		],
		[
			"ja",
			"カード描画",
			"全体設定",
			"カード一覧プレビュー · 全体設定を反映",
			"カード一覧プレビュー · この購読の設定を反映",
			"カードスキン",
			"この購読のカード個別設定を削除しますか？",
			"キャンセル",
			"UID 123456 の個別設定を削除",
		],
		[
			"zh-TW",
			"卡片繪製",
			"全域",
			"卡片總覽 · 即時反映全域設定",
			"卡片總覽 · 即時反映此訂閱設定",
			"卡片外觀",
			"移除此訂閱的卡片個別設定？",
			"取消",
			"移除 UID 123456 的個別設定",
		],
	] as const)(
		"%s card settings localize global and subscription scopes without saving or removing drafts",
		async (locale, hero, global, family, subFamily, skin, removal, cancel, removeAction) => {
			const { container } = renderCards();
			await screen.findByText("UID 123456");
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(hero)).toBeTruthy();
			expect(screen.getAllByRole("button", { name: global }).length).toBeGreaterThan(0);
			expect(screen.getByText(family)).toBeTruthy();
			await waitFor(() =>
				expect(
					screen.getAllByRole("img", {
						name:
							locale === "en"
								? "Live card preview"
								: locale === "ja"
									? "カードのリアルタイムプレビュー"
									: "卡片即時預覽",
					}).length,
				).toBe(4),
			);
			fireEvent.click(screen.getByText("UID 123456"));
			await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));
			expect(screen.getByText(subFamily)).toBeTruthy();
			expect(screen.getAllByText(skin).length).toBeGreaterThan(0);
			const picker = container.querySelector('[data-code="cardSkin"] [role="combobox"]');
			if (!picker) throw new Error("card skin picker is not ready");
			chooseSelect(picker as HTMLButtonElement, "极光");
			fireEvent.click(screen.getByRole("button", { name: removeAction }));
			expect(await screen.findByText(removal)).toBeTruthy();
			expect(screen.getAllByText("UID 123456", { selector: "b" }).length).toBeGreaterThan(0);
			fireEvent.click(screen.getByRole("button", { name: cancel }));
			expect(picker.textContent).toBe("极光");
			expect(api.patch).not.toHaveBeenCalled();
			await act(async () => {
				await useDraftStore.getState().current?.onSave();
			});
			expect(api.patch).toHaveBeenCalledWith(`/api/subscriptions/${CUSTOMIZED.id}`, {
				overrides: {
					cards: { liveCoverImageIds: ["per-up-cover"] },
					cardSkin: "aurora",
					cardSkinKnobs: null,
				},
			});
		},
	);
	it("localized skin inheritance retains the subscription and explicitly clears only its skin override", async () => {
		const skinned = { ...CUSTOMIZED, overrides: { ...CUSTOMIZED.overrides, cardSkin: "aurora" } };
		const baseGet = vi.mocked(api.get).getMockImplementation();
		if (!baseGet) throw new Error("base API fixture is not configured");
		vi.mocked(api.get).mockImplementation((url: string) =>
			url.includes("/api/subscriptions") ? Promise.resolve([skinned]) : baseGet(url),
		);
		const { container, qc } = renderCards();
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));
		const select = await waitFor(() => {
			const el = container.querySelector('[data-code="cardSkin"] [role="combobox"]');
			if (!el) throw new Error("card skin picker is not ready");
			return el as HTMLButtonElement;
		});
		for (const [locale, inherit, builtin, noName] of [
			["en", "Follow global (默认皮肤)", "默认皮肤 (built-in)", "Follow global"],
			["ja", "全体設定に従う（默认皮肤）", "默认皮肤（内蔵）", "全体設定に従う"],
			["zh-TW", "跟隨全域（默认皮肤）", "默认皮肤（內建）", "跟隨全域"],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			const options = selectOptionsOf(select).map((x) => x.textContent);
			expect(options).toContain(inherit);
			expect(options).toContain(builtin);
			expect(select.textContent).toBe("极光");
			fireEvent.keyDown(select, { key: "Escape" });
			act(() => qc.setQueryData(["cards", "skins"], { ...SKINS, active: "" }));
			await waitFor(() =>
				expect(selectOptionsOf(select).map((x) => x.textContent)).toContain(noName),
			);
			fireEvent.keyDown(select, { key: "Escape" });
			act(() => qc.setQueryData(["cards", "skins"], SKINS));
			await waitFor(() =>
				expect(selectOptionsOf(select).map((x) => x.textContent)).toContain(inherit),
			);
			fireEvent.keyDown(select, { key: "Escape" });
			expect(api.patch).not.toHaveBeenCalled();
		}
		chooseSelect(select, "跟隨全域（默认皮肤）");
		expect(api.patch).not.toHaveBeenCalled();
		await act(async () => {
			await useDraftStore.getState().current?.onSave();
		});
		expect(api.patch).toHaveBeenCalledWith(`/api/subscriptions/${CUSTOMIZED.id}`, {
			overrides: {
				cards: { liveCoverImageIds: ["per-up-cover"] },
				cardSkin: null,
				cardSkinKnobs: null,
			},
		});
	});

	it("来源与语言刷新保留未保存皮肤覆盖，显式保存仍只改卡片", async () => {
		const { qc } = renderCards();
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));
		const picker = await waitFor(() => {
			const el = document.querySelector('[data-code="cardSkin"] [role="combobox"]');
			expect(el).toBeTruthy();
			return el as HTMLButtonElement;
		});
		chooseSelect(picker, "极光");
		act(() =>
			qc.setQueryData(["sources"], {
				sources: [
					{ ...makeSource(), descriptor: { ...makeSource().descriptor, label: "刷新来源" } },
				],
			}),
		);
		const prior = i18n.state();
		try {
			act(() => i18n.set({ locale: "en", voice: "plain" }));
			expect(picker.textContent).toContain("极光");
			expect(api.patch).not.toHaveBeenCalled();
			await useDraftStore.getState().current?.onSave();
			expect(api.patch).toHaveBeenCalledWith(`/api/subscriptions/${CUSTOMIZED.id}`, {
				overrides: {
					cards: { liveCoverImageIds: ["per-up-cover"] },
					cardSkin: "aurora",
					cardSkinKnobs: null,
				},
			});
		} finally {
			act(() => i18n.set(prior));
		}
	});
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
				expect(kinds).toEqual(new Set(["live", "post", "superchat", "membership"]));
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

	it("切到 per-UP → 预览带上这条订阅的 id(真数据由服务端问它的来源要),不再带 fallback", async () => {
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		// 预览 POST 有 500ms 防抖;等防抖追上后那次带订阅 id 的请求落地
		// (默认 kind=live;中间会有 content 尚未追上的过渡请求,故须同时匹配订阅 id)。
		await waitFor(
			() => {
				const call = vi.mocked(api.post).mock.calls.find(([url, body]) => {
					const b = body as { content?: { subscriptionId?: string } };
					return url === "/api/cards/preview" && b.content?.subscriptionId === CUSTOMIZED.id;
				});
				expect(call).toBeTruthy();
				expect(call?.[1]).not.toHaveProperty("fallback");
			},
			{ timeout: 2000 },
		);
	});

	it("per-UP 的全局 tab 全家福:四种卡各自带这条订阅的 id(作品另带第几条)", async () => {
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		await waitFor(
			() => {
				const contentOf = (kind: string) =>
					vi
						.mocked(api.post)
						.mock.calls.filter(([url, body]) => {
							const b = body as { kind?: string };
							return url === "/api/cards/preview" && b?.kind === kind;
						})
						.map(([, body]) => (body as { content: Record<string, unknown> }).content);
				for (const kind of ["live", "post", "superchat", "membership"]) {
					expect(
						contentOf(kind).some((c) => c.subscriptionId === CUSTOMIZED.id),
						kind,
					).toBe(true);
				}
				expect(contentOf("live")).toContainEqual({ subscriptionId: CUSTOMIZED.id });
				expect(contentOf("post")).toContainEqual({ subscriptionId: CUSTOMIZED.id, nth: 1 });
			},
			{ timeout: 2000 },
		);
	});

	it("per-UP 切到「直播开播」→ 预览带这条订阅的 id", async () => {
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));
		// 全局 tab 的全家福先把四张卡各发一次;等它们都落地、清掉,再切到单张,免得拿全家福那一发充数。
		await waitFor(
			() => {
				const kinds = new Set(
					vi
						.mocked(api.post)
						.mock.calls.filter(([url]) => url === "/api/cards/preview")
						.map(([, body]) => (body as { kind?: string }).kind),
				);
				expect(kinds).toEqual(new Set(["live", "post", "superchat", "membership"]));
			},
			{ timeout: 2000 },
		);
		vi.mocked(api.post).mockClear();
		fireEvent.click(screen.getAllByRole("button", { name: "直播开播" })[0] as HTMLElement);

		await waitFor(
			() => {
				const call = vi.mocked(api.post).mock.calls.find(([url, body]) => {
					const b = body as { kind?: string; content?: { subscriptionId?: string } };
					return (
						url === "/api/cards/preview" &&
						b?.kind === "live" &&
						b.content?.subscriptionId === CUSTOMIZED.id
					);
				});
				expect(call).toBeTruthy();
			},
			{ timeout: 2000 },
		);
	});

	it("per-UP 的右侧提示写该 UP 的 uid", async () => {
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));
		expect(screen.getByText("123456", { selector: "b" })).toBeTruthy();
	});

	it("per-UP 切到 SC → 预览带这条订阅的 id(服务端据此把收的人写成它)", async () => {
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
					const b = body as { kind?: string; content?: { subscriptionId?: string } };
					return (
						url === "/api/cards/preview" &&
						b?.kind === "superchat" &&
						b.content?.subscriptionId === CUSTOMIZED.id
					);
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
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "123456" }),
			overrides: { cardSkin: "aurora" },
		};
		vi.mocked(api.get).mockImplementation((url: string) => {
			if (url === "/api/library/images") return Promise.resolve({ ok: true, ids: [] });
			if (url.includes("/api/subscriptions")) return Promise.resolve([skinned]);
			if (url.includes("/api/targets")) return Promise.resolve([]);
			if (url === "/api/sources") return Promise.resolve({ sources: [makeSource()] });
			if (url.includes("/api/cards/skins")) return Promise.resolve(SKINS);
			return Promise.resolve({ core: GLOBALS });
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

	it("per-UP 保存 → 只 PATCH 卡片那几片(cardSkin / 旋钮未覆盖 = null)", async () => {
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		// 经灵动岛触发保存(页内无保存按钮,统一走灵动岛 onSave)。
		useDraftStore.getState().current?.onSave();

		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		const [url, body] = vi.mocked(api.patch).mock.calls.at(-1) as [string, { overrides: unknown }];
		expect(url).toBe(`/api/subscriptions/${CUSTOMIZED.id}`);
		const overrides = body.overrides as Record<string, unknown>;
		// 只含卡片三片:cards 是封面覆盖(列表整份替换,原样带上)、cardSkin 未覆盖故 null、
		// cardSkinKnobs 一枚都没单独拧故 null(ADR-0014 决策 17 的 🔗);不带 imageGroup(不动该 UP 其它 slice)。
		expect(Object.keys(overrides).sort()).toEqual(["cardSkin", "cardSkinKnobs", "cards"]);
		expect(overrides.cardSkin).toBeNull();
		expect(overrides.cardSkinKnobs).toBeNull();
		expect(overrides.cards).toEqual({ liveCoverImageIds: ["per-up-cover"] });
	});

	it("per-UP 作品 → 选「第几条」,nth 进预览请求", async () => {
		const { container } = renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 123456"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		// 切到动态类型(SectionNav 竖栏 + 横向条两份,取第一个)。
		fireEvent.click(screen.getAllByRole("button", { name: "作品发布" })[0]);

		// 把「第几条作品」改成 3。
		const nthInput = await waitFor(() => {
			const el = container.querySelector('[data-code="nth"] input');
			if (!el) throw new Error("nth input not rendered");
			return el as HTMLInputElement;
		});
		fireEvent.change(nthInput, { target: { value: "3" } });

		// 防抖后预览 POST 带这条订阅的 id + 所选第几条(证明不再写死 1)。
		await waitFor(
			() => {
				const call = vi.mocked(api.post).mock.calls.find(([url, body]) => {
					const b = body as {
						kind?: string;
						content?: { subscriptionId?: string; nth?: number };
					};
					return (
						url === "/api/cards/preview" &&
						b?.kind === "post" &&
						b.content?.subscriptionId === CUSTOMIZED.id &&
						b.content?.nth === 3
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
			const el = container.querySelector('[data-code="cardSkin"] [role="combobox"]');
			if (!el) throw new Error("cardSkin select not rendered");
			return el as HTMLButtonElement;
		});
		// 列表里的那套自制皮肤要真的是个选项 —— 下拉只有「跟随全局」的话下面这一步
		// 会把 value 设成空串,断言反而看不出问题。
		expect(selectOptionsOf(select).map((o) => o.textContent)).toContain("极光");
		chooseSelect(select, "极光");

		useDraftStore.getState().current?.onSave();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [string, { overrides: unknown }];
		expect((body.overrides as { cardSkin?: unknown }).cardSkin).toBe("aurora");
	});

	it("per-UP 选回「跟随全局」→ PATCH 把 cardSkin 清成 null(不是键消失)", async () => {
		const skinned: Subscription = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "999000" }),
			overrides: { cardSkin: "aurora" },
		};
		vi.mocked(api.get).mockImplementation((url: string) => {
			if (url === "/api/library/images") return Promise.resolve({ ok: true, ids: [] });
			if (url.includes("/api/subscriptions")) return Promise.resolve([skinned]);
			if (url.includes("/api/targets")) return Promise.resolve([]);
			if (url === "/api/sources") return Promise.resolve({ sources: [makeSource()] });
			if (url.includes("/api/cards/skins")) return Promise.resolve(SKINS);
			return Promise.resolve({ core: GLOBALS });
		});

		const { container } = renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		fireEvent.click(await screen.findByText("UID 999000"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));

		const select = await waitFor(() => {
			const el = container.querySelector('[data-code="cardSkin"] [role="combobox"]');
			if (!el) throw new Error("cardSkin select not rendered");
			return el as HTMLButtonElement;
		});
		// 先确认存量覆盖 seed 进了下拉(否则「清掉」测的是一个本来就空的值)。
		expect(select.textContent).toBe("极光");
		chooseSelect(select, /^跟随全局/);

		useDraftStore.getState().current?.onSave();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [string, { overrides: unknown }];
		const overrides = body.overrides as Record<string, unknown>;
		expect("cardSkin" in overrides).toBe(true);
		expect(overrides.cardSkin).toBeNull();
	});
});

it("updates card event labels on the mounted page while retaining the selected subscription", async () => {
	renderCards();
	fireEvent.click(await screen.findByText("UID 123456"));
	const live = await screen.findByRole("button", { name: "直播开播" });
	const previous = i18n.state();
	try {
		for (const [locale, name] of [
			["en", "Stream started"],
			["ja", "配信開始"],
			["zh-TW", "直播開始"],
		] as const) {
			await act(async () => {
				i18n.set({ locale, voice: "plain" });
			});
			expect(screen.getByRole("button", { name })).toBe(live);
			expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup");
		}
		expect(api.patch).not.toHaveBeenCalled();
	} finally {
		await act(async () => {
			i18n.set(previous);
		});
	}
});
