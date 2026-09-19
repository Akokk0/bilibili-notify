// @vitest-environment jsdom

/**
 * 「请女仆帮忙写」在编辑器页面上的**接线**(ADR-0015 第二片)。
 *
 * 检查器那层的测试是直接喂 `ai` 的,证明不了页面真把它接上了:判据读没读到模型配置、
 * 发出去的是不是**草稿**(而不是盘上那份)、目标块对不对、默认皮肤有没有被挡住。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
	ApiError: class extends Error {},
}));
vi.mock("../../services/cardSkinAi", () => ({
	streamCardSkinAiCss: vi.fn(async () => ({
		css: '[data-bn="self"]{border-radius:16px}',
		warnings: [],
	})),
}));

import { api } from "../../services/api";
import { streamCardSkinAiCss } from "../../services/cardSkinAi";
import CardSkinEditor from "../CardSkinEditor";

const MANIFEST = {
	schemaVersion: 1,
	name: "霓虹",
	cards: {
		live: {
			width: 600,
			css: "",
			blocks: [
				{
					id: "cover",
					kind: "builtin",
					builtin: "cover",
					grid: { row: 1, column: 1, span: 12 },
					css: '[data-bn="self"]{padding:1px}',
				},
			],
		},
	},
};

function mockApi(opts: { builtin?: boolean; model?: boolean }): void {
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url === "/api/card-skins") {
			return Promise.resolve({
				skins: [
					{ id: "default", name: "默认", builtin: true, updatedAt: 0, knobs: [] },
					{ id: "neon", name: "霓虹", builtin: opts.builtin ?? false, updatedAt: 0, knobs: [] },
				],
				active: "neon",
				fallbacks: [],
			});
		}
		if (url === "/api/card-skins/neon") {
			return Promise.resolve({ manifest: structuredClone(MANIFEST) });
		}
		if (url === "/api/globals") {
			const filled = opts.model ?? true;
			return Promise.resolve({
				defaults: {
					ai: {
						enabled: false,
						activeProfile: "p1",
						providers: {
							p1: {
								provider: "custom",
								apiKey: filled ? "••••" : "",
								baseUrl: filled ? "https://api.test/v1" : "",
								model: "m",
							},
						},
					},
				},
			});
		}
		return Promise.resolve({});
	});
	vi.mocked(api.post).mockResolvedValue({
		html: "<html><body></body></html>",
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

const slot = () => screen.getByRole("button", { name: /请女仆帮忙写/ }) as HTMLButtonElement;

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("编辑器 ·「请女仆帮忙写」的接线", () => {
	it("配好了模型 → 按得动;发出去的是这张卡、这个块、这一刻的草稿", async () => {
		mockApi({});
		renderEditor();
		fireEvent.click(await screen.findByText("封面图"));
		// 先手改一笔:发出去的必须是改过的草稿,不是盘上那份。
		fireEvent.click(screen.getByRole("button", { name: "源码" }));
		fireEvent.change(screen.getByLabelText("这个块的 CSS"), {
			target: { value: '[data-bn="self"]{padding:9px}' },
		});
		await waitFor(() => expect(slot().disabled).toBe(false));

		fireEvent.click(slot());
		const dialog = screen.getByRole("dialog", { name: "请女仆帮忙写" });
		fireEvent.change(within(dialog).getByLabelText("想让这段 CSS 变成什么样"), {
			target: { value: "圆角大一点" },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "拜托啦" }));

		await waitFor(() => expect(streamCardSkinAiCss).toHaveBeenCalledOnce());
		const [skinId, body] = vi.mocked(streamCardSkinAiCss).mock.calls[0] ?? [];
		expect(skinId).toBe("neon");
		expect(body).toMatchObject({ kind: "live", blockId: "cover", instruction: "圆角大一点" });
		const sent = body?.manifest as typeof MANIFEST;
		expect(sent.cards.live.blocks[0]?.css).toBe('[data-bn="self"]{padding:9px}');
		// 写完的内容回到了框里(CSS 那一节默认是结构视图,源码文本框得先切过去)。
		fireEvent.click(screen.getByRole("button", { name: "源码" }));
		await waitFor(() =>
			expect((screen.getByLabelText("这个块的 CSS") as HTMLTextAreaElement).value).toBe(
				'[data-bn="self"]{border-radius:16px}',
			),
		);
	});

	it("没配模型 → 按不动,说去哪配", async () => {
		mockApi({ model: false });
		renderEditor();
		fireEvent.click(await screen.findByText("封面图"));
		await waitFor(() => expect(slot().getAttribute("title")).toMatch(/智能女仆/));
		expect(slot().disabled).toBe(true);
	});

	it("内置皮肤 → 按不动,说先复制一份", async () => {
		mockApi({ builtin: true });
		renderEditor();
		fireEvent.click(await screen.findByText("封面图"));
		await waitFor(() => expect(slot().getAttribute("title")).toMatch(/复制一份/));
		expect(slot().disabled).toBe(true);
	});
});
