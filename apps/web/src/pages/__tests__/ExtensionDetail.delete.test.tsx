// @vitest-environment jsdom

/**
 * 拓展详情页的「删除」。
 *
 * 三件事值得钉:① 危险动作要先过确认框,不许一点就没;② 服务端拦下时把它那句话
 * **原样**摆出来(「还有 N 条连接在用它」是用户唯一能照着做的线索,自编一句「删除失败」
 * 等于让人对着黑盒猜);③ 删成了要离开这一页 —— 留在原地的话页面立刻变成
 * 「没有装名叫 X 的拓展」,像是出了错。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../../services/api";
import ExtensionDetail from "../ExtensionDetail";

// class 表达式塞在对象字面量里 biome 的解析器过不去,搬进 vi.hoisted 的函数体。
const { FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {}
	return { FakeApiError };
});

/**
 * 迁到 v2 的桥,关着 —— 头卡里没有视图可画,「配置」里是照清单画的那一格接入列表。删除这件事
 * 与它是哪一档无关,但拿一个真有设置的拓展来量:「删掉它的设置也会一起没」说的正是这种。
 */
vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: {
		get: vi.fn(async (url: string) => {
			if (url === "/api/globals") {
				return { extensions: { bridge: { enabled: false, settings: { links: [] } } } };
			}
			if (url.endsWith("/docs")) return {};
			return {
				extensions: [
					{
						id: "bridge",
						name: "机器人框架桥接",
						description: "借 bot",
						version: "0.0.1",
						apiVersion: 2,
						provides: ["push"],
						settings: {
							fields: [
								{
									key: "links",
									type: "list",
									label: "桥接入",
									itemLabel: "接入",
									title: "name",
									fields: [{ key: "name", type: "string", label: "名字", required: true }],
								},
							],
						},
						enabled: false,
						state: "disabled",
					},
				],
			};
		}),
		patch: vi.fn(async () => ({})),
		delete: vi.fn(async () => ({ ok: true })),
	},
}));

function renderDetail() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidate = vi.spyOn(qc, "invalidateQueries");
	render(
		<MemoryRouter initialEntries={["/extensions/bridge"]}>
			<QueryClientProvider client={qc}>
				<Routes>
					<Route path="/extensions/:id" element={<ExtensionDetail />} />
					<Route path="/extensions" element={<div>拓展列表</div>} />
				</Routes>
			</QueryClientProvider>
		</MemoryRouter>,
	);
	return { invalidate };
}

describe("删掉一个拓展", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("点删除只是弹确认框,还没发请求", async () => {
		renderDetail();

		await userEvent.click(await screen.findByRole("button", { name: "删除拓展" }));

		expect(await screen.findByText(/删掉它的设置也会一起没/)).toBeTruthy();
		expect(api.delete).not.toHaveBeenCalled();
	});

	it("确认之后才删,删完刷新拓展表、离开这一页", async () => {
		const { invalidate } = renderDetail();

		await userEvent.click(await screen.findByRole("button", { name: "删除拓展" }));
		await userEvent.click(await screen.findByRole("button", { name: "删掉它" }));

		await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/ext/bridge"));
		expect(await screen.findByText("拓展列表")).toBeTruthy();
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["extensions"] });
	});

	/** 🔴 服务端那句「还有 N 条连接在用它」是用户唯一能照着做的线索,不许换成自编的概括。 */
	it("服务端拦下 → 原样摆出它那句话,框留在原地", async () => {
		vi.mocked(api.delete).mockRejectedValueOnce(
			new Error("还有 2 条连接在用它 —— 先去推送目标页把它们删掉,再回来卸这个拓展"),
		);
		renderDetail();

		await userEvent.click(await screen.findByRole("button", { name: "删除拓展" }));
		await userEvent.click(await screen.findByRole("button", { name: "删掉它" }));

		expect(await screen.findByText(/还有 2 条连接在用它/)).toBeTruthy();
		expect(screen.queryByText("拓展列表")).toBeNull();
	});
});
