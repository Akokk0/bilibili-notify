// @vitest-environment jsdom

/**
 * 拓展详情页上那块「说明 / 更新日志」。
 *
 * 两件事值得钉:① 有就画、**没有就整块不画**(空盒子比没有更难看,也让人以为加载坏了);
 * ② 内容是第三方写的,走 `UNTRUSTED_MARKDOWN_COMPONENTS` 那副受限渲染,不是文档那副。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../../services/api";
import ExtensionDetail from "../ExtensionDetail";

const { FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {}
	return { FakeApiError };
});

const { docs } = vi.hoisted(() => ({ docs: { value: {} as Record<string, unknown> } }));

vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: {
		get: vi.fn(async (url: string) => {
			if (url.endsWith("/docs")) return docs.value;
			return {
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
			};
		}),
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
				</Routes>
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

describe("详情页上的拓展文档", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("有 README → 画出来", async () => {
		docs.value = { readme: "# 桥接\n\n把 koishi 的 bot 借过来。" };
		renderDetail();
		expect(await screen.findByText(/把 koishi 的 bot 借过来/)).toBeTruthy();
	});

	it("有 CHANGELOG → 也看得到", async () => {
		docs.value = { changelog: "## [0.0.1]\n\n第一版。" };
		renderDetail();
		expect(await screen.findByText(/第一版/)).toBeTruthy();
	});

	/** 🔴 两份都没有就**整块不画** —— 空盒子会让人以为是加载坏了。 */
	it("两份都没有 → 连标题都不出现", async () => {
		docs.value = {};
		renderDetail();
		// 等这一条本身就够了 —— 名字在面包屑与标题里各有一份,拿它当信号会撞上两个节点。
		await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/ext/bridge/docs"));
		expect(screen.queryByText("说明")).toBeNull();
		expect(screen.queryByText("更新日志")).toBeNull();
	});
});
