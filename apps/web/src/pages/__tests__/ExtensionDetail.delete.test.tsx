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

vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: {
		get: vi.fn(async () => ({
			extensions: [
				{
					id: "bridge",
					name: "机器人框架桥接",
					description: "借 bot",
					version: "0.0.1",
					enabled: false,
					state: "disabled",
				},
			],
		})),
		patch: vi.fn(async () => ({})),
		delete: vi.fn(async () => ({ ok: true })),
	},
}));

vi.mock("../extensions/bridge-panel", () => ({
	BridgeAddressRow: () => <div />,
	BridgeConnections: () => <div />,
}));

function renderDetail() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<MemoryRouter initialEntries={["/extensions/bridge"]}>
			<QueryClientProvider client={qc}>
				<Routes>
					<Route path="/extensions/:id" element={<ExtensionDetail />} />
					<Route path="/extensions" element={<div>拓展列表</div>} />
				</Routes>
			</QueryClientProvider>
		</MemoryRouter>,
	);
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

	it("确认之后才删,删完离开这一页", async () => {
		renderDetail();

		await userEvent.click(await screen.findByRole("button", { name: "删除拓展" }));
		await userEvent.click(await screen.findByRole("button", { name: "删掉它" }));

		await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/ext/bridge"));
		expect(await screen.findByText("拓展列表")).toBeTruthy();
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
