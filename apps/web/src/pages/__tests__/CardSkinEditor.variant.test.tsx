// @vitest-environment jsdom

/**
 * 「只改本场」那根线的**接线**(ADR-0014 决策 10 的 2026-09-18 🔗)。
 *
 * 零件各自都有测试:预览那头算得出形态、`setVariantGrid` 写得对、画布合得对。但从服务端
 * 回报到改动落盘中间隔着四跳(预览回报 → 页面记下 → 开关切到本场 → 拖拽落进覆盖),
 * **任意一跳没接上,拖出来的改动就安安静静地写进基础版式** —— 没有报错、没有白屏,
 * 所有零件的单测照样全绿,而主人以为自己只改了一场。所以这条从整页走一遍真链路。
 */

import type { CardSkinManifest } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";
import CardSkinEditor from "../CardSkinEditor";

const COL_W = 40;
const COL_X0 = 100;
const ROW_H = 56;
const ROW_PITCH = 64;
const colX = (n: number) => COL_X0 + (n - 1) * COL_W + COL_W / 2;
const rowY = (n: number) => (n - 1) * ROW_PITCH + ROW_H / 2;

/** 两块的直播卡。`title` 在「直播中」那一档挪到了第 3 列 —— 标与合并都靠它。 */
const MANIFEST = {
	schemaVersion: 1,
	name: "霓虹",
	cards: {
		live: {
			width: 600,
			css: "",
			blocks: [
				{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 4 } },
				{ id: "title", kind: "builtin", builtin: "title", grid: { row: 2, column: 1, span: 12 } },
			],
			variants: { streaming: { blocks: { title: { grid: { column: 3, span: 10 } } } } },
		},
	},
};

function mockApi(variant: string | null): void {
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url === "/api/card-skins") {
			return Promise.resolve({
				skins: [{ id: "neon", name: "霓虹", builtin: false, updatedAt: 0, knobs: [] }],
				active: "neon",
				fallbacks: [],
			});
		}
		if (url === "/api/card-skins/neon")
			return Promise.resolve({ manifest: structuredClone(MANIFEST) });
		return Promise.resolve({});
	});
	vi.mocked(api.post).mockResolvedValue({
		html: "<html><body>卡</body></html>",
		width: 600,
		warnings: [],
		scene: "streaming",
		variant,
	});
	vi.mocked(api.put).mockResolvedValue({ warnings: [] });
}

function renderEditor() {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/cards/skins/neon"]}>
				<Routes>
					<Route path="/cards/skins/:id" element={<CardSkinEditor />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

const blockEl = (id: string) =>
	document.querySelector(`[data-block-id="${id}"]`) as HTMLElement | null;

/**
 * 存出去的那份清单里的直播卡。⚠️ 形状**从真类型取**,别拿 `typeof MANIFEST` 顶 ——
 * 那是夹具的字面量类型,夹具里没写的键(比如某一形态里的另一块)在断言里会当场「不存在」,
 * 而产物其实是对的。
 */
function savedLiveCard(): NonNullable<CardSkinManifest["cards"]["live"]> {
	const sent = vi.mocked(api.put).mock.calls[0]?.[1] as CardSkinManifest | undefined;
	const live = sent?.cards.live;
	if (!live) throw new Error("存出去的清单里没有直播卡");
	return live;
}

/** 见 `SkinCanvas.drag.test.tsx`:`timeStamp` 只读,而它决定松手速度。 */
function pointer(el: Element, type: string, at: { x: number; y: number }, t: number) {
	const e = new Event(type, { bubbles: true });
	Object.assign(e, { pointerId: 1, clientX: at.x, clientY: at.y, button: 0 });
	Object.defineProperty(e, "timeStamp", { value: t });
	fireEvent(el, e);
}

function drag(el: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
	pointer(el, "pointerdown", from, 1000);
	pointer(el, "pointermove", to, 1500);
	pointer(el, "pointermove", to, 1800);
	pointer(el, "pointerup", to, 1800);
}

beforeEach(() => {
	vi.clearAllMocks();
	// jsdom 没有布局引擎 —— 按 `data-canvas-track` 喂假矩形(同拖拽那份测试)。
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
		const track = this.getAttribute("data-canvas-track");
		const i = Number(this.getAttribute("data-canvas-index") ?? "0");
		const zero = { x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
		if (track === "column") {
			const x = COL_X0 + (i - 1) * COL_W;
			return { ...zero, x, left: x, right: x + COL_W, width: COL_W } as DOMRect;
		}
		if (track === "row") {
			const y = (i - 1) * ROW_PITCH;
			return { ...zero, y, top: y, bottom: y + ROW_H, height: ROW_H } as DOMRect;
		}
		return zero as DOMRect;
	});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

/** 等预览那趟回来、页面记下形态。 */
async function waitForVariant(label: string): Promise<HTMLElement> {
	return await waitFor(() => screen.getByRole("button", { name: `只改「${label}」` }), {
		timeout: 3000,
	});
}

describe("编辑器 · 「只改本场」的接线", () => {
	it("预览回报了形态,头部才出现那个开关,名字用形态的人话名", async () => {
		mockApi("streaming");
		renderEditor();
		await waitForVariant("直播中");
		expect(screen.getByRole("button", { name: "基础版式" })).toBeTruthy();
	});

	// 只有一副样子的卡摆个永远选不动的开关,只会让人以为自己漏了什么。
	it("这一场只有基础版式时,开关整个不出现", async () => {
		mockApi(null);
		renderEditor();
		await waitFor(() => expect(blockEl("title")).toBeTruthy(), { timeout: 3000 });
		expect(screen.queryByRole("button", { name: /^只改/ })).toBeNull();
	});

	// 主人最容易犯的错是「以为改了全部,其实只改了一场」—— 所以这个标在**基础版式**那档
	// 也挂着,它正好是那句提醒。
	it("这一场改过的块挂着标,而且默认那档(基础版式)就看得见", async () => {
		mockApi("streaming");
		renderEditor();
		await waitForVariant("直播中");
		expect(blockEl("title")?.textContent).toContain("本场挪过位置");
		expect(blockEl("cover")?.textContent).not.toContain("本场");
	});

	// 画布画的是哪一层,得跟着开关走 —— 不然在基础版式那档拖一个本场覆盖过的块,
	// 它会纹丝不动,而代码全对。
	it("切到本场之后,画布画的是合并过的位置", async () => {
		mockApi("streaming");
		renderEditor();
		const toCase = await waitForVariant("直播中");
		// 基础版式那档:base 说 1–12。
		expect(blockEl("title")?.textContent).toContain("1–12");
		fireEvent.click(toCase);
		await waitFor(() => expect(blockEl("title")?.textContent).toContain("3–12"));
	});

	/**
	 * 整条线:切到本场 → 拖 → 存。**改动必须落在覆盖里,基础版式一个字节都不动。**
	 * 任意一跳断了,这条会看到改动写进了 `blocks`。
	 */
	it("切到本场后拖块,改动落进覆盖,基础版式原样不动", async () => {
		mockApi("streaming");
		renderEditor();
		const toCase = await waitForVariant("直播中");
		fireEvent.click(toCase);
		await waitFor(() => expect(blockEl("cover")).toBeTruthy());

		// 封面从第 1 列拖到第 5 列(base 与覆盖都没碰过它)。
		drag(blockEl("cover") as Element, { x: colX(1), y: rowY(1) }, { x: colX(5), y: rowY(1) });

		const save = await waitFor(() => {
			const b = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
			expect(b.disabled).toBe(false);
			return b;
		});
		fireEvent.click(save);

		await waitFor(() => expect(vi.mocked(api.put)).toHaveBeenCalled());
		const live = savedLiveCard();
		expect(live.blocks.find((b) => b.id === "cover")?.grid).toEqual({
			row: 1,
			column: 1,
			span: 4,
		});
		expect(live.variants?.streaming?.blocks?.cover?.grid?.column).toBe(5);
	});

	/** 对照:**没切**开关时同一下拖拽改的是基础版式,覆盖里不该多出一块。 */
	it("没切开关时,同一下拖拽改的是基础版式", async () => {
		mockApi("streaming");
		renderEditor();
		await waitForVariant("直播中");
		await waitFor(() => expect(blockEl("cover")).toBeTruthy());

		drag(blockEl("cover") as Element, { x: colX(1), y: rowY(1) }, { x: colX(5), y: rowY(1) });

		const save = await waitFor(() => {
			const b = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
			expect(b.disabled).toBe(false);
			return b;
		});
		fireEvent.click(save);

		await waitFor(() => expect(vi.mocked(api.put)).toHaveBeenCalled());
		const live = savedLiveCard();
		expect(live.blocks.find((b) => b.id === "cover")?.grid?.column).toBe(5);
		expect(live.variants?.streaming?.blocks?.cover).toBeUndefined();
	});
});
