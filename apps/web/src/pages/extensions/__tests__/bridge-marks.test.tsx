// @vitest-environment jsdom
/**
 * 接入卡与 bot 行左边那枚方块。
 *
 * 一屏上常有两三条接入、每条底下挂几个 bot,全是清一色的文字行时,主人得逐行读名字才
 * 认得出谁是谁。方块是**扫一眼就能分**的那条通道 —— 设计稿 V1 里两处都有,实现时漏掉了。
 *
 * bot 那一侧走库里的 `PlatformIcon`:认得的平台画真图标,认不得的退首字方章 ——
 * 而桥后面挂着什么平台是**运行时才知道**的开放词表,退得下去这件事是刚需。
 */

import type { Connection } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";
import { BridgeConnections } from "../bridge-panel";

const KOISHI = {
	id: "c1",
	name: "家里那台",
	enabled: true,
	kind: "extension",
	extensionId: "bridge",
	config: { token: "0123456789abcdef0123456789abcdef", bridgeKind: "koishi" },
} as unknown as Connection;

const ASTRBOT = {
	id: "c2",
	name: "机房那台",
	enabled: true,
	kind: "extension",
	extensionId: "bridge",
	config: { token: "ffffffffffffffffffffffffffffffff", bridgeKind: "astrbot" },
} as unknown as Connection;

const STATUS = {
	sessions: [
		{
			connectionId: "c1",
			connected: true,
			kind: "koishi",
			name: "客厅那台",
			version: "0.1.0",
			connectedAt: 1_700_000_000_000,
			bots: [
				{ botId: "onebot:1", platform: "onebot", name: "阿库娅", selfId: "2854196310" },
				{ botId: "nostalgia:2", platform: "从没见过的平台", name: "小电视" },
			],
		},
		{ connectionId: "c2", connected: false, bots: [] },
	],
};

function renderPanel() {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/connections") return [KOISHI, ASTRBOT];
		if (path.startsWith("/api/ext/")) return STATUS;
		throw new Error("没有这个口");
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<BridgeConnections extensionId="bridge" enabled />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("接入卡的方块", () => {
	/**
	 * 🔴 方块印的是**配置里那一种**,不是桥自报的那一种 —— 连着的那条卡上,自报的种类
	 * 摆在会话元信息里,而「我给这条配的是什么」此前只在**没连上**时才印得出来。
	 */
	it("两条接入各带一枚认得出种类的方块,连着的那条也有", async () => {
		renderPanel();
		await screen.findByText("家里那台");
		expect(screen.getByLabelText("koishi 接入")).toBeTruthy();
		expect(screen.getByLabelText("astrbot 接入")).toBeTruthy();
	});
});

describe("bot 行的平台方块", () => {
	it("认得的平台与认不得的平台都画得出来 —— 桥后面挂什么是运行时才知道的", async () => {
		renderPanel();
		await screen.findByText("阿库娅");
		for (const name of ["阿库娅", "小电视"]) {
			const row = screen.getByText(name).closest("[data-bot-row]");
			expect(row).toBeTruthy();
			expect(row?.querySelector("[data-bot-mark]")?.children.length).toBeGreaterThan(0);
		}
	});
});
