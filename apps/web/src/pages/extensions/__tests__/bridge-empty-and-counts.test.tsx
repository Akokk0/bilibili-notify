// @vitest-environment jsdom
/**
 * 一条接入都没有的那一屏,以及「现在到底接着几条」。
 *
 * 🔴 **空态是这一页最要紧的一屏**:主人装完桥拓展、点进来,看到的必然是它。此前那儿只有
 * 一句「还没有配过接入」—— 而这一刻他需要知道的是**接下来干什么**(建一条、拿 token 和
 * 地址去填插件),那句话一个字都没说。
 *
 * 数字那一行答的是另一个问题:「它现在到底在干活吗」。配了两条、一条都没连上,与配了两条
 * 全连着,在一屏卡片里长得几乎一样。
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

const LINKS = [
	{
		id: "c1",
		name: "家里那台",
		enabled: true,
		kind: "extension",
		extensionId: "bridge",
		config: { token: "0123456789abcdef0123456789abcdef", bridgeKind: "koishi" },
	},
	{
		id: "c2",
		name: "机房那台",
		enabled: true,
		kind: "extension",
		extensionId: "bridge",
		config: { token: "ffffffffffffffffffffffffffffffff", bridgeKind: "astrbot" },
	},
] as unknown as Connection[];

const STATUS = {
	sessions: [
		{
			connectionId: "c1",
			connected: true,
			kind: "koishi",
			name: "客厅那台",
			connectedAt: Date.now() - 60_000,
			bots: [
				{ botId: "onebot:1", platform: "onebot", name: "阿库娅" },
				{ botId: "telegram:2", platform: "telegram", name: "小电视" },
			],
		},
		{ connectionId: "c2", connected: false, bots: [] },
	],
};

function renderPanel(links: Connection[], status: unknown) {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/connections") return links;
		if (path.startsWith("/api/ext/")) {
			if (status === undefined) throw new Error("拓展没跑起来");
			return status;
		}
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

describe("一条接入都没有", () => {
	it("讲的是接下来干什么,不是「这里是空的」", async () => {
		renderPanel([], undefined);
		const empty = await screen.findByText(/还没有桥接入/);
		const box = empty.closest("[data-bridge-empty]");
		expect(box).toBeTruthy();
		// token 与地址要去哪儿、桥怎么连过来 —— 这三样缺一样主人就卡住
		expect(box?.textContent).toMatch(/token/);
		expect(box?.textContent).toMatch(/插件/);
		expect(box?.textContent).toMatch(/自己连过来/);
	});

	it("就地给一颗开工的钮", async () => {
		renderPanel([], undefined);
		const box = (await screen.findByText(/还没有桥接入/)).closest("[data-bridge-empty]");
		expect(box?.querySelector("button")).toBeTruthy();
	});
});

describe("现在接着几条", () => {
	it("数得出接入与在线的 bot —— 「配了两条一条没连上」和「两条全连着」得分得开", async () => {
		renderPanel(LINKS, STATUS);
		await screen.findByText("阿库娅"); // 等两条查询都落地
		const counts = screen.getByTestId("bridge-counts");
		expect(counts.textContent).toMatch(/2\s*条接入/);
		expect(counts.textContent).toMatch(/2\s*个 bot 在线/);
	});

	it("拓展没跑起来时只数接入,不假装有 bot 在线", async () => {
		renderPanel(LINKS, undefined);
		await screen.findByText(/这个拓展现在没跑起来/); // 等状态那条查询认输
		const counts = screen.getByTestId("bridge-counts");
		expect(counts.textContent).toMatch(/2\s*条接入/);
		expect(counts.textContent).not.toMatch(/bot 在线/);
	});
});
