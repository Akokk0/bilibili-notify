// @vitest-environment jsdom

/**
 * 「画布跟着预览场景」那根线的**接线**(2026-09-18 主人反馈:各个场景画布都一样)。
 *
 * 零件各自都有测试:`drawnBlocks` 数得对、`SkinCanvas` 给了单子就标得对。但从预览框到
 * 画布中间隔着三跳(框交出文档 → 预览栏数成块 id → 页面递给画布),**任意一跳没接上,
 * 画布就安安静静地一个都不标** —— 没有报错、没有白屏、所有零件的单测照样全绿。
 * 所以这条从整页走一遍真链路。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";
import CardSkinEditor from "../CardSkinEditor";

/** 皮肤里摆两块;真卡这一场只画其中一块,另一块该被标出来。 */
const MANIFEST = {
	schemaVersion: 1,
	name: "霓虹",
	cards: {
		live: {
			width: 600,
			css: "",
			blocks: [
				{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
				{ id: "title", kind: "builtin", builtin: "title", grid: { row: 2, column: 1, span: 12 } },
			],
		},
	},
};

/**
 * 真卡画好之后框里那份文档。桩在**原型**上而不是某个框上 —— jsdom 给插进去的 iframe
 * 补发 `load` 是异步的,等测试拿到那个框时它早发过了,再往那个框上桩就晚了一步。
 */
function drawOnly(id: string): () => void {
	const d = document.implementation.createHTMLDocument("");
	d.body.innerHTML = `<div class="bn-glass"><div class="bn-blk-${id}"></div></div>`;
	const proto = HTMLIFrameElement.prototype;
	const had = Object.getOwnPropertyDescriptor(proto, "contentDocument");
	Object.defineProperty(proto, "contentDocument", { configurable: true, get: () => d });
	return () => {
		if (had) Object.defineProperty(proto, "contentDocument", had);
	};
}

function mockApi(): void {
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
	});
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

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("编辑器 · 画布跟着场景的接线", () => {
	/**
	 * 两条互为对照:同一份皮肤,只换真卡这一场画的是哪一块,画布标出来的就该跟着换。
	 * 链路上任何一跳断了两条一起红 —— 只钉「有标注」的话,一个都不标那条兜底路径会让
	 * 断线看着像正常。
	 */
	for (const [drawnId, otherId] of [
		["cover", "title"],
		["title", "cover"],
	] as const) {
		it(`真卡这一场只画了 ${drawnId} → 画布把 ${otherId} 标成不画`, async () => {
			const restore = drawOnly(drawnId);
			try {
				mockApi();
				renderEditor();
				// 预览栏防抖之后才打那趟请求,框也才画得出来。先要块真渲染出来,再问标注 ——
				// 只问后者的话,块还没出现时 `null?.textContent` 是 undefined,断言当场就过。
				await waitFor(
					() => {
						const other = blockEl(otherId);
						expect(other).toBeTruthy();
						expect(other?.textContent).toContain("这一场不画");
					},
					{ timeout: 3000 },
				);
				expect(blockEl(drawnId)?.textContent).not.toContain("这一场不画");
			} finally {
				restore();
			}
		});
	}
});
