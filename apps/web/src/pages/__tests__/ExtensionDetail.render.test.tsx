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

/** 接入住桥的设置里(`globals.extensions.bridge.settings.links`),不在连接表里(ADR-0012 决策 45)。 */
const GLOBALS = {
	extensions: {
		bridge: {
			enabled: true,
			settings: {
				links: [
					{ id: CONNECTED_ID, name: "家里那台", enabled: true, token: "t1", bridgeKind: "koishi" },
					{ id: CONFIGURED_ID, name: "公司那台", enabled: true, token: "t2", bridgeKind: "koishi" },
				],
			},
		},
	},
};

const STATUS = {
	sessions: [
		{
			linkId: CONNECTED_ID,
			connected: true,
			kind: "koishi",
			name: "客厅那台 koishi",
			version: "0.1.0",
			connectedAt: 1_700_000_000_000,
			remoteAddress: "192.168.1.5",
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
		{ linkId: CONFIGURED_ID, connected: false, bots: [] },
	],
};

function route(url: string): string {
	if (url === "/api/ext") return "listed";
	if (url === "/api/globals") return "globals";
	if (url.startsWith("/api/ext/")) return "status";
	return "other";
}

function renderDetail(id = "bridge") {
	apiGetMock.mockImplementation(async (url: string) => {
		switch (route(url)) {
			case "listed":
				return LISTED;
			case "globals":
				return GLOBALS;
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

	it("头上印的是这个拓展自己的名字、说明与状态", async () => {
		renderDetail();
		// 名字有两处:面包屑与头卡 —— 两处都该是它自己的名字。
		expect(await screen.findAllByText("机器人框架桥接")).toHaveLength(2);
		expect(screen.getByText("已启用")).toBeTruthy();
		expect(screen.getByText("把别的机器人框架里的 bot 借过来发推送")).toBeTruthy();
	});

	/**
	 * 🔴 接入卡是**页面级**的兄弟节点,不套在头卡肚子里(设计稿 V1)——
	 * 此前整张接入列表被塞进头卡正文,头卡长成了整页。
	 */
	it("接入卡不在头卡肚子里", async () => {
		renderDetail();
		const head = (await screen.findByText("已启用")).closest(".bn-glass");
		expect(head).toBeTruthy();
		const card = (await screen.findByText("家里那台")).closest("[data-link-card]");
		expect(card).toBeTruthy();
		expect(head?.contains(card as Node)).toBe(false);
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

	it("连上了的那条:桥自报的种类 / 名字 / 版本 / 从哪来都印出来", async () => {
		renderDetail();
		expect(await screen.findByText("家里那台")).toBeTruthy();
		// 两条接入各有一枚「哪一种」徽章 —— 两条都配的 koishi
		expect(screen.getAllByText("koishi")).toHaveLength(2);
		expect(screen.getByText(/客厅那台 koishi v0\.1\.0/)).toBeTruthy();
		expect(screen.getByText(/来自 192\.168\.1\.5/)).toBeTruthy();
		expect(screen.getByText("已连接")).toBeTruthy();
		expect(screen.getByText("小电视")).toBeTruthy();
	});

	/**
	 * 🔴 **「配了但没连上」是这一页最该看见的一行。** 只列活着的会话的话,那条根本不显示 ——
	 * 而主人正是为了查它才打开这一页。
	 */
	it("配了但没连上的那条也要在列表里", async () => {
		renderDetail();
		expect(await screen.findByText("公司那台")).toBeTruthy();
		expect(screen.getByText("没连上")).toBeTruthy();
	});

	/**
	 * 🔴 **「不支持」与「还不知道」要分开显示**(桥接设计定案里写死的):前者是结论,
	 * 后者是「试试看,可能行」。混成一个叉号,主人会以为那条平台永远做不到。
	 */
	it("能力三态分开说 —— 支持 / 不支持 / 还不知道", async () => {
		renderDetail();
		await screen.findByText("小电视");
		expect(screen.getByTitle("@全体:支持")).toBeTruthy();
		expect(screen.getByTitle("收私聊指令:不支持")).toBeTruthy();
		expect(screen.getByTitle("合并转发:还不知道")).toBeTruthy();
	});

	it("地址栏里是个不存在的拓展 → 说一句,不是白屏", async () => {
		renderDetail("nope");
		expect(await screen.findByText(/没有装名叫 nope 的拓展/)).toBeTruthy();
	});
});
