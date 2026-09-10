// @vitest-environment jsdom

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ExtensionDetail from "../ExtensionDetail";

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

const CONNECTED_ID = "11111111-1111-4111-8111-111111111111";
const CONFIGURED_ID = "22222222-2222-4222-8222-222222222222";

const LISTED: ExtensionsResponse = {
	extensions: [
		{
			id: "bridge",
			name: "机器人框架桥接",
			description: "把别的机器人框架里的 bot 借过来发推送",
			version: "1.0.0",
			enabled: true,
			state: "running",
			dir: "/data/extensions/bridge",
		},
	],
};

const CONNECTIONS = [
	{ id: CONNECTED_ID, name: "家里那台", kind: "extension", extensionId: "bridge", enabled: true },
	{ id: CONFIGURED_ID, name: "公司那台", kind: "extension", extensionId: "bridge", enabled: true },
	{ id: "33333333-3333-4333-8333-333333333333", name: "本地 OneBot", kind: "direct" },
];

const STATUS = {
	sessions: [
		{
			connectionId: CONNECTED_ID,
			connected: true,
			kind: "koishi",
			name: "客厅那台 koishi",
			version: "0.1.0",
			connectedAt: 1_700_000_000_000,
			bots: [
				{
					botId: "bot-1",
					platform: "telegram",
					name: "小电视",
					capabilities: {
						atAll: "supported",
						inbound: "unsupported",
						forward: "unknown",
						miniAppCard: "unknown",
						shareCardLinks: "unknown",
					},
				},
			],
		},
		{ connectionId: CONFIGURED_ID, connected: false, bots: [] },
	],
};

function route(url: string): string {
	if (url === "/api/ext") return "listed";
	if (url === "/api/connections") return "connections";
	if (url.startsWith("/api/ext/")) return "status";
	return "other";
}

function renderDetail(id = "bridge") {
	apiGetMock.mockImplementation(async (url: string) => {
		switch (route(url)) {
			case "listed":
				return LISTED;
			case "connections":
				return CONNECTIONS;
			case "status":
				return STATUS;
			default:
				return {};
		}
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[`/extensions/${id}`]}>
				<Routes>
					<Route path="/extensions/:id" element={<ExtensionDetail />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("拓展详情页", () => {
	// ⚠️ **花括号不能省**:`mockReset()` 回的是那个 mock 本身,而 mock 是个函数 ——
	// 箭头函数直接返回它,vitest 会把它当成这一条的清理钩子,在收摊时**当函数调一次**。
	// 症状是每条用例末尾多一发 `api.get(undefined)`,栈里看不出是自己写的。
	beforeEach(() => {
		apiGetMock.mockReset();
		apiPatchMock.mockReset();
		apiPatchMock.mockResolvedValue({});
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("头上印的是这个拓展自己的名字与状态", async () => {
		renderDetail();
		// 名字有两处:面包屑与头卡 —— 两处都该是它自己的名字。
		expect(await screen.findAllByText("机器人框架桥接")).toHaveLength(2);
		expect(screen.getByText("已启用")).toBeTruthy();
		expect(screen.getByText("v1.0.0")).toBeTruthy();
	});

	/**
	 * 点进详情页正是为了「摆弄它」,而开关是这一页最主要的那个动作 —— 只能回列表去拨的话,
	 * 这一页就成了只读的展板。补丁仍然**只带自己那一格**(JSON Merge Patch)。
	 */
	it("详情页也能拨开关,发出去的还是只有自己那一格", async () => {
		renderDetail();
		fireEvent.click(await screen.findByLabelText("机器人框架桥接"));
		await waitFor(() =>
			expect(apiPatchMock).toHaveBeenCalledWith("/api/globals", {
				extensions: { bridge: { enabled: false } },
			}),
		);
	});

	it("连上了的那条:桥自报的种类 / 名字 / 版本都印出来", async () => {
		renderDetail();
		expect(await screen.findByText("家里那台")).toBeTruthy();
		expect(screen.getByText(/koishi/)).toBeTruthy();
		expect(screen.getByText(/客厅那台 koishi/)).toBeTruthy();
		expect(screen.getByText(/0\.1\.0/)).toBeTruthy();
		expect(screen.getByText("小电视")).toBeTruthy();
	});

	/**
	 * 🔴 **「配了但没连上」是这一页最该看见的一行。** 只列活着的会话的话,那条根本不显示 ——
	 * 而主人正是为了查它才打开这一页。
	 */
	it("配了但没连上的那条也要在列表里", async () => {
		renderDetail();
		expect(await screen.findByText("公司那台")).toBeTruthy();
		expect(screen.getByText("未连接")).toBeTruthy();
	});

	/**
	 * 🔴 **「不支持」与「还不知道」要分开显示**(桥接设计定案里写死的):前者是结论,
	 * 后者是「试试看,可能行」。混成一个叉号,主人会以为那条平台永远做不到。
	 */
	it("能力三态分开说 —— 支持 / 不支持 / 还不知道", async () => {
		renderDetail();
		await screen.findByText("小电视");
		expect(screen.getByTitle("@全体成员:支持")).toBeTruthy();
		expect(screen.getByTitle("接收消息:不支持")).toBeTruthy();
		expect(screen.getByTitle("合并转发:还不知道")).toBeTruthy();
	});

	it("地址栏里是个不存在的拓展 → 说一句,不是白屏", async () => {
		renderDetail("nope");
		expect(await screen.findByText(/没有装名叫 nope 的拓展/)).toBeTruthy();
	});
});
