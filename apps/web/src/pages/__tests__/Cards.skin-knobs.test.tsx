// @vitest-environment jsdom

/**
 * 皮肤旋钮的**接线**(ADR-0014 决策 16 的 🔗)—— 卡片页把旋钮草稿接进保存路径那一段。
 *
 * 零件各自的测试都绿证明不了两个零件真的接上了:`knob-ops` 的表算得对、
 * `CardSkinKnobs` 的控件画得对,而页面上那根线要是没接(草稿没进 `buildPatch` 的
 * 两侧、或者进了 payload 却没进基线),界面照样拧得动、灵动岛照样亮、PATCH 里却
 * 一个字都没有。所以这两条只看**发出去的那份 payload**:
 *
 * - 拧一枚 → `defaults.cardSkinKnobs` 里出现它;
 * - 还原 → 那一层是显式 `null`(键消失 = 服务端读作「别动」,还原就永远不生效 ——
 *   同一个坑在 `cardStyleByKind` 上栽过一次见 Cards.bykind-off,在按模块日志等级上
 *   栽过一次见 System.module-log-levels)。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import type { GlobalConfig } from "../../types/globals";
import Cards from "../Cards";
import { makeDefaults } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const SKIN_LIST = {
	skins: [
		{
			id: "default",
			name: "默认",
			builtin: true,
			updatedAt: 0,
			knobs: [
				{
					key: "glass-opacity",
					label: "玻璃白纱",
					type: "number",
					default: 0.82,
					min: 0,
					max: 1,
					step: 0.01,
				},
			],
		},
	],
	active: "default",
	fallbacks: [],
};

/** `knobs` 是这一套皮肤已经拧过的键(空 = 一枚都没拧过)。 */
function mockApi(knobs: Record<string, Record<string, unknown>>): void {
	const defaults = makeDefaults() as unknown as Record<string, unknown>;
	defaults.cardSkinKnobs = knobs;
	const globals = { app: {}, master: {}, defaults } as unknown as GlobalConfig;
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url.includes("/api/subs")) return Promise.resolve([]);
		if (url.includes("/api/targets")) return Promise.resolve([]);
		if (url.includes("/api/card-skins")) return Promise.resolve(SKIN_LIST);
		return Promise.resolve(globals);
	});
}

// 皮肤库那节的「编辑」钮要跳编辑器路由,所以这一页现在吃 router context。
function renderCards() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidate = vi.spyOn(qc, "invalidateQueries");
	return {
		invalidate,
		...render(
			<MemoryRouter>
				<QueryClientProvider client={qc}>
					<Cards />
				</QueryClientProvider>
			</MemoryRouter>,
		),
	};
}

type InvalidateSpy = { mock: { calls: unknown[][] } };

/** 这一轮作废过预览缓存没有(prefix 匹配,把四张全家福一起带上)。 */
function previewInvalidated(invalidate: InvalidateSpy): boolean {
	return invalidate.mock.calls.some(
		(c) => (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0] === "card-preview",
	);
}

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

/** 保存并取回最后那一份 PATCH body。 */
async function saveAndRead(): Promise<{ defaults: { cardSkinKnobs: Record<string, unknown> } }> {
	useDraftStore.getState().current?.onSave();
	await waitFor(() => expect(api.patch).toHaveBeenCalled());
	const [url, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
		string,
		{ defaults: { cardSkinKnobs: Record<string, unknown> } },
	];
	expect(url).toBe("/api/globals");
	return body;
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

describe("皮肤旋钮接进卡片页的保存路径", () => {
	it("拧一枚 → PATCH 的 defaults.cardSkinKnobs 里带着它,并且作废预览缓存", async () => {
		mockApi({});
		const { invalidate } = renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));

		const row = await waitFor(() => {
			const el = document.querySelector('[data-knob="glass-opacity"]');
			if (!el) throw new Error("旋钮那一行还没渲染出来");
			return el as HTMLElement;
		});
		fireEvent.change(row.querySelector('input[type="range"]') as HTMLInputElement, {
			target: { value: "0.4" },
		});

		const body = await saveAndRead();
		expect(body.defaults.cardSkinKnobs).toEqual({ default: { "glass-opacity": 0.4 } });
		// 旋钮不进预览 spec(服务端自己从 globals 读),queryKey 一个字没变 —— 不显式作废
		// 的话保存完看到的还是旧图,主人看着就是「拧了没反应」。
		await waitFor(() => expect(previewInvalidated(invalidate)).toBe(true));
	});

	it("这一轮没动过旋钮 → 不白白作废预览缓存(那是一轮凭空多出来的 puppeteer)", async () => {
		mockApi({});
		const { invalidate } = renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));

		// 旋钮一枚没碰就保存 —— 作废与否只该由旋钮那一片说了算,别的什么都不算。
		await waitFor(() => expect(document.querySelector('[data-knob="glass-opacity"]')).toBeTruthy());
		await saveAndRead();
		expect(previewInvalidated(invalidate)).toBe(false);
	});

	it("还原 → 那一层是显式 null,不是键消失也不是写回 default", async () => {
		mockApi({ default: { "glass-opacity": 0.4 } });
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));

		fireEvent.click(await screen.findByText("还原"));

		const body = await saveAndRead();
		// 键必须在,且为 null。少了它后端 deepMerge 原样留着 0.4,主人报的就是「还原没用」。
		expect(body.defaults.cardSkinKnobs).toHaveProperty("default");
		expect(body.defaults.cardSkinKnobs.default).toBeNull();
	});
});
