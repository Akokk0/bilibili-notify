// @vitest-environment jsdom

/**
 * 编辑器增删块的**接线**(ADR-0014 第二步)。
 *
 * 零件各自都有测试:`skin-draft-ops` 的增删算得对、`SkinCanvas` / `SkinInspector` 的
 * 控件画得对。但页面上那两根线要是没接(`onAdd` / `onRemove` 忘了传、或者改了草稿的
 * 副本而不是草稿本身),界面照样点得动、画布照样多一格,**存出去的那份清单里却一个
 * 字都没变** —— 门禁全绿,只有真存一次才露馅。所以这三条只看两样东西:`PUT` 出去的
 * 那份 payload,以及只读皮肤上这两个口在不在。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";
import CardSkinEditor from "../CardSkinEditor";

const MANIFEST = {
	schemaVersion: 1,
	name: "霓虹",
	cards: {
		live: {
			width: 600,
			css: "",
			blocks: [
				{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
			],
		},
	},
};

function mockApi(builtin = false): void {
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url === "/api/card-skins") {
			return Promise.resolve({
				skins: [{ id: "neon", name: "霓虹", builtin, updatedAt: 0, knobs: [] }],
				active: "neon",
				fallbacks: [],
			});
		}
		if (url === "/api/card-skins/neon") {
			return Promise.resolve({ manifest: structuredClone(MANIFEST) });
		}
		return Promise.resolve({});
	});
	// 预览栏防抖 400ms 之后会打一趟,让它有东西可收 —— 不然收摊时多一条没人接的 rejection。
	vi.mocked(api.post).mockResolvedValue({
		html: "<html><body></body></html>",
		width: 600,
		warnings: [],
		scene: "streaming",
	});
	vi.mocked(api.put).mockResolvedValue({ ok: true, warnings: [] });
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

/** 最近一次 `PUT` 出去的那份清单里,直播卡的块表。 */
const savedBlocks = (): Array<{ id: string; kind: string; builtin?: string; html?: string }> => {
	const body = vi.mocked(api.put).mock.calls.at(-1)?.[1] as {
		cards: {
			live: { blocks: Array<{ id: string; kind: string; builtin?: string; html?: string }> };
		};
	};
	return body.cards.live.blocks;
};

const save = () => fireEvent.click(screen.getByRole("button", { name: "保存" }));

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("编辑器 · 增删块的接线", () => {
	it("添加块 → 存出去的清单里真的多了那一块", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");

		fireEvent.click(screen.getByText(/添加块/));
		const catalogue = screen.getByRole("group", { name: "可以添加的块" });
		fireEvent.click(within(catalogue).getByRole("button", { name: /直播标题/ }));
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedBlocks().map((b) => b.builtin)).toEqual(["cover", "title"]);
	});

	it("删块 → 存出去的清单里真的没了", async () => {
		mockApi();
		renderEditor();
		fireEvent.click(await screen.findByText("封面图"));

		fireEvent.click(screen.getByText(/删除这个块/));
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedBlocks()).toEqual([]);
	});

	it("自定义块也走同一根线 —— 存出去的清单里带着它的 HTML", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");

		fireEvent.click(screen.getByText(/添加块/));
		const catalogue = screen.getByRole("group", { name: "可以添加的块" });
		fireEvent.click(within(catalogue).getByRole("button", { name: /自定义块/ }));
		fireEvent.change(screen.getByLabelText("这个块的 HTML"), {
			target: { value: "<div>{up.name}</div>" },
		});
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedBlocks().at(-1)).toMatchObject({ kind: "custom", html: "<div>{up.name}</div>" });
	});

	it("内置皮肤是只读的 —— 增删的口一个都不给", async () => {
		mockApi(true);
		renderEditor();
		fireEvent.click(await screen.findByText("封面图"));

		expect(screen.queryByText(/添加块/)).toBeNull();
		expect(screen.queryByText(/删除这个块/)).toBeNull();
	});
});
