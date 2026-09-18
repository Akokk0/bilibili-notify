// @vitest-environment jsdom

/**
 * 「画布跟着场景」那根线的**接线**(ADR-0014 决策 10 的 2026-09-19 🔗)。
 *
 * 零件各自有测试:`SkinCanvas` 给了 `scene` 就只摆那一场的块。但从头部那排场景钮到画布
 * 隔着页面这一跳 —— 没接上的话画布永远停在第一场,所有零件的单测照样全绿。所以这条从
 * 整页走一遍:切场景,独有块该消失就消失;选中的块在新的那一场不露面,选中要放掉。
 */

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

/** 动态卡摆三块:头像共有,图廊只属图文,视频封面只属视频投稿。 */
const MANIFEST = {
	schemaVersion: 1,
	name: "霓虹",
	cards: {
		dynamic: {
			width: 600,
			css: "",
			blocks: [
				{ id: "avatar", kind: "builtin", builtin: "avatar", grid: { row: 1, column: 1, span: 3 } },
				{ id: "pics", kind: "builtin", builtin: "pics", grid: { row: 2, column: 1, span: 12 } },
				{
					id: "video-cover",
					kind: "builtin",
					builtin: "videoCover",
					grid: { row: 2, column: 1, span: 12, rowSpan: 3 },
				},
			],
		},
	},
};

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
		scene: "text",
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

/** 切到动态卡,等画布画出共有的那块。 */
async function openDynamic() {
	mockApi();
	renderEditor();
	await waitFor(() => expect(screen.getByRole("button", { name: /动态/ })).toBeTruthy());
	fireEvent.click(screen.getByRole("button", { name: /动态/ }));
	await waitFor(() => expect(blockEl("avatar")).toBeTruthy());
}

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("编辑器 · 画布跟着场景的接线", () => {
	it("默认在纯文字那场:两块独有的都不露面;切到图文只见图廊,切到视频投稿只见封面", async () => {
		await openDynamic();
		expect(blockEl("pics")).toBeNull();
		expect(blockEl("video-cover")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "图文" }));
		expect(blockEl("pics")).toBeTruthy();
		expect(blockEl("video-cover")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "视频投稿" }));
		expect(blockEl("video-cover")).toBeTruthy();
		expect(blockEl("pics")).toBeNull();
	});

	it("选中的块在新的那一场不露面 → 放掉选中;共有块的选中跟着走", async () => {
		await openDynamic();
		fireEvent.click(screen.getByRole("button", { name: "图文" }));
		fireEvent.click(blockEl("pics") as HTMLElement);
		expect(blockEl("pics")?.getAttribute("aria-pressed")).toBe("true");

		fireEvent.click(screen.getByRole("button", { name: "视频投稿" }));
		// 图廊没了,选中也放掉:检查器回到「点一个块」那句空态,而不是对着一个画布上
		// 找不到的块。(只查画布上「没有选中的块」是空断言 —— 块都不在了,当然没有。)
		expect(screen.getByText(/在中间画布上点一个块/)).toBeTruthy();

		fireEvent.click(blockEl("avatar") as HTMLElement);
		fireEvent.click(screen.getByRole("button", { name: "转发" }));
		expect(blockEl("avatar")?.getAttribute("aria-pressed")).toBe("true");
	});
});
