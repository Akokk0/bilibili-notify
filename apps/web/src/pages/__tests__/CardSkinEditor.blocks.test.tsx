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

function mockApi(builtin = false, manifest: unknown = MANIFEST): void {
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
		if (url === "/api/card-skins/neon") {
			return Promise.resolve({ manifest: structuredClone(manifest) });
		}
		// 出厂那份:接管一种卡时抄的就是它。
		if (url === "/api/card-skins/default") {
			return Promise.resolve({
				manifest: {
					schemaVersion: 1,
					name: "默认",
					cards: {
						sc: {
							width: 430,
							blocks: [
								{
									id: "amount",
									kind: "builtin",
									builtin: "amount",
									grid: { row: 1, column: 1, span: 12 },
								},
							],
						},
					},
				},
			});
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

	it("接管一种卡:抄出厂那份,存出去的清单里真的多了这张卡", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");

		// 这套皮肤只定义了直播卡,切到 SC 卡是空的。
		fireEvent.click(screen.getByRole("button", { name: /SC/ }));
		fireEvent.click(await screen.findByText(/接管这种卡/));
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		const body = vi.mocked(api.put).mock.calls.at(-1)?.[1] as {
			cards: { sc?: { blocks: unknown[] } };
		};
		expect(body.cards.sc?.blocks).toHaveLength(1);
	});

	it("内置皮肤是只读的 —— 增删的口一个都不给", async () => {
		mockApi(true);
		renderEditor();
		fireEvent.click(await screen.findByText("封面图"));

		expect(screen.queryByText(/添加块/)).toBeNull();
		expect(screen.queryByText(/删除这个块/)).toBeNull();
	});
});

/**
 * **放下一个块**那根线(主人 2026-09-15 报:「我明明是把块拖到对方上面,但是却被对方
 * 覆盖了」)。
 *
 * 叠放次序不在 `grid` 里 —— 没写层次时它是**块在数组里的先后**,而拖动只改 `grid`。
 * 于是画布这一口必须走 `dropBlockGrid` 而不是 `setBlockGrid`;两个口在 `skin-draft-ops`
 * 的测试里各自绿,证明不了页面上接对了哪一个。这里只看**存出去的那份清单**里块的先后。
 *
 * 检查器那几个数字框反过来:它们不许改先后 —— 精确编辑不该有副作用,换层次有旋钮。
 */
describe("编辑器 · 放下一个块的接线", () => {
	const TWO = {
		schemaVersion: 1,
		name: "霓虹",
		cards: {
			live: {
				width: 600,
				css: "",
				blocks: [
					{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 4 } },
					{ id: "title", kind: "builtin", builtin: "title", grid: { row: 2, column: 1, span: 4 } },
				],
			},
		},
	};

	const COL_W = 40;
	const COL_X0 = 100;
	const ROW_H = 56;
	const ROW_PITCH = 64;
	const colX = (n: number) => COL_X0 + (n - 1) * COL_W + COL_W / 2;
	const rowY = (n: number) => (n - 1) * ROW_PITCH + ROW_H / 2;

	beforeEach(() => {
		// jsdom 没有布局:按画布标出来的 `data-canvas-track` 喂假矩形,别的一律零矩形。
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
			this: Element,
		) {
			const track = this.getAttribute("data-canvas-track");
			const i = Number(this.getAttribute("data-canvas-index") ?? "0");
			if (track === "column") {
				const x = COL_X0 + (i - 1) * COL_W;
				return {
					x,
					y: 0,
					left: x,
					right: x + COL_W,
					top: 0,
					bottom: 0,
					width: COL_W,
					height: 0,
				} as DOMRect;
			}
			if (track === "row") {
				const y = (i - 1) * ROW_PITCH;
				return {
					x: 0,
					y,
					left: 0,
					right: 0,
					top: y,
					bottom: y + ROW_H,
					width: 0,
					height: ROW_H,
				} as DOMRect;
			}
			return { x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
		});
	});
	afterEach(() => vi.restoreAllMocks());

	// `timeStamp` 是只读的,`fireEvent` 的 init 里传不进去,而它决定松手速度;起点不能用 0
	// (React 写的是 `nativeEvent.timeStamp || Date.now()`,0 是 falsy)。
	const T0 = 1000;
	function pointer(el: Element, type: string, at: { x: number; y: number }, t: number) {
		const e = new Event(type, { bubbles: true });
		Object.assign(e, { pointerId: 1, clientX: at.x, clientY: at.y, button: 0 });
		Object.defineProperty(e, "timeStamp", { value: t });
		fireEvent(el, e);
	}
	function dragTo(el: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
		pointer(el, "pointerdown", from, T0);
		pointer(el, "pointermove", to, T0 + 500);
		pointer(el, "pointermove", to, T0 + 800);
		pointer(el, "pointerup", to, T0 + 800);
	}

	it("把块拖到对方身上 → 存出去的清单里它排在对方**之后**(也就是压在上面)", async () => {
		mockApi(false, TWO);
		renderEditor();
		const cover = await screen.findByRole("button", { name: /封面图/ });

		dragTo(cover, { x: colX(1), y: rowY(1) }, { x: colX(1), y: rowY(2) });
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedBlocks().map((b) => b.id)).toEqual(["title", "cover"]);
	});

	it("检查器里把「行」改成一样 → 位置变了,但块的先后**不许**动", async () => {
		mockApi(false, TWO);
		renderEditor();
		fireEvent.click(await screen.findByRole("button", { name: /封面图/ }));

		fireEvent.change(screen.getByRole("spinbutton", { name: /^行\(/ }), {
			target: { value: "2" },
		});
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedBlocks().map((b) => b.id)).toEqual(["cover", "title"]);
	});
});
