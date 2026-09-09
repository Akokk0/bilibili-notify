// @vitest-environment jsdom

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import Extensions from "../Extensions";

const { apiGetMock, apiPatchMock } = vi.hoisted(() => ({
	apiGetMock: vi.fn(),
	apiPatchMock: vi.fn(),
}));

vi.mock("../../services/api", () => ({
	api: {
		get: apiGetMock as unknown as (url: string) => Promise<unknown>,
		patch: apiPatchMock as unknown as (url: string, body?: unknown) => Promise<unknown>,
	},
}));

const LISTED: ExtensionsResponse = {
	extensions: [
		{
			id: "bridge",
			name: "机器人框架桥接",
			description: "把别的机器人框架里的 bot 借过来发推送",
			version: "1.0.0",
			provides: ["push"],
			enabled: true,
			state: "running",
		},
		{
			id: "douyin",
			name: "抖音订阅源",
			version: "0.2.0",
			enabled: true,
			state: "blocked",
			detail: "连续加载失败 3 次,已自动停用;换一版会重新试",
		},
	],
};

function renderPage(listed: ExtensionsResponse = LISTED) {
	apiGetMock.mockResolvedValue(listed);
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter>
				<Extensions />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("拓展页", () => {
	beforeEach(() => {
		apiGetMock.mockReset();
		apiPatchMock.mockReset();
		apiPatchMock.mockResolvedValue({});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("装了什么就列什么 —— 卡片文案来自服务端,不在前端再抄一份", async () => {
		renderPage();
		expect(await screen.findByText("机器人框架桥接")).toBeTruthy();
		expect(screen.getByText("把别的机器人框架里的 bot 借过来发推送")).toBeTruthy();
		expect(screen.getByText("抖音订阅源")).toBeTruthy();
		expect(apiGetMock).toHaveBeenCalledWith("/api/ext");
	});

	/**
	 * 🔴 **开关开着却没跑,正是最该看见的那一格。** 只印开关的话,连败自动停用的那个
	 * 拓展看起来跟正常跑着的一模一样,而主人只会觉得「推送怎么不来了」。
	 */
	it("没跑起来的说得出为什么 —— 状态与开关是两件事", async () => {
		renderPage();
		expect(await screen.findByText("已自动停用")).toBeTruthy();
		expect(screen.getByText(/连续加载失败 3 次/)).toBeTruthy();
	});

	/**
	 * 🔴 **补丁只带自己那一格。** 配置是 JSON Merge Patch:整份 `extensions` 发出去的话,
	 * 别人刚拨的开关会被这一发悄悄按回旧值,而两边都不会报错。
	 */
	it("拨开关只发自己那一格,不把整张表发出去", async () => {
		renderPage();
		const toggle = await screen.findByLabelText("机器人框架桥接");
		fireEvent.click(toggle);
		// mutate 是异步发起的,同步断言会在请求出门之前就跑完。
		await waitFor(() =>
			expect(apiPatchMock).toHaveBeenCalledWith("/api/globals", {
				extensions: { bridge: { enabled: false } },
			}),
		);
	});

	/**
	 * 🔴 **热装卸还没做。** 拨完开关什么都不会发生,直到重启 —— 不说清楚的话,主人会
	 * 反复拨那个开关找原因。
	 */
	it("说清楚开关要重启才生效", async () => {
		renderPage();
		expect(await screen.findByText(/重启后生效/)).toBeTruthy();
	});

	/** 详情页是拓展自己那块面板的唯一去处 —— 卡片上不给入口的话只能手敲地址。 */
	it("每张卡都通到自己的详情页", async () => {
		renderPage();
		const links = await screen.findAllByText("详情 →");
		expect(links.map((a) => a.getAttribute("href"))).toEqual([
			"/extensions/bridge",
			"/extensions/douyin",
		]);
	});

	it("一个拓展都没装时给一句空态,不是空白", async () => {
		renderPage({ extensions: [] });
		expect(await screen.findByText(/还没有装任何拓展/)).toBeTruthy();
	});
});
