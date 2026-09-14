// @vitest-environment jsdom

/**
 * 编辑器的**皮肤这一档**:名字 / 作者 / 说明的接线(ADR-0014 第二步续)。
 *
 * 从前皮肤装进来叫什么名字就再也改不了 —— 编辑器与皮肤库都没有入口。补上这一档时最容易
 * 留下的是静默失败:框敲得动、头部那行也跟着变,**存出去的清单里却还是旧名**(改的是草稿
 * 的副本)。所以这里只看两样东西:`PUT` 出去的那份 payload,以及只读皮肤上这几个口在不在。
 *
 * 另钉「名字空了保存钮变灰」:不拦的话按下去吃的是装包门一句「name: 太短」,而皮肤里带
 * 名字的东西有好几样(块有 id、字体有 family),主人根本不知道说的是哪一个。
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

const MANIFEST = {
	schemaVersion: 1,
	name: "霓虹",
	author: "阿绫",
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
				skins: [
					{ id: "default", name: "默认", builtin: true, updatedAt: 0, knobs: [] },
					{ id: "neon", name: "霓虹", builtin, updatedAt: 0, knobs: [] },
				],
				active: "neon",
				fallbacks: [],
			});
		}
		if (url === "/api/card-skins/neon")
			return Promise.resolve({ manifest: structuredClone(MANIFEST) });
		return Promise.resolve({});
	});
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

/** 最近一次 `PUT` 出去的那份清单。 */
const saved = () =>
	vi.mocked(api.put).mock.calls.at(-1)?.[1] as {
		name: string;
		author?: string;
		description?: string;
	};

const saveBtn = () => screen.getByRole("button", { name: "保存" });
const save = () => fireEvent.click(saveBtn());

/** 点头部那行皮肤名 —— 它就是进这一档的门。 */
async function openSkinTab(name = "霓虹"): Promise<void> {
	fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
}

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("编辑器 · 皮肤这一档的接线", () => {
	it("点头部皮肤名 → 检查器换成皮肤那一档;改名存出去真的是新名", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("皮肤名"), { target: { value: "青柠" } });
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(saved().name).toBe("青柠");
	});

	it("作者与说明同一根线;清空的那个是**删键**,不是空串", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("说明"), { target: { value: "夜里好看" } });
		fireEvent.change(screen.getByLabelText("作者"), { target: { value: "" } });
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(saved().description).toBe("夜里好看");
		expect("author" in saved()).toBe(false);
	});

	it("名字空了 → 保存钮变灰,并且说出是哪儿不对", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("皮肤名"), { target: { value: "  " } });

		expect((saveBtn() as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText("皮肤得有个名字")).toBeTruthy();
	});

	it("内置皮肤是只读的 —— 这三个框一个都不给编", async () => {
		mockApi(true);
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		for (const label of ["皮肤名", "作者", "说明"]) {
			expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
		}
	});
});
