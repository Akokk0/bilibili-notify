// @vitest-environment jsdom

/**
 * 拓展列表卡上那一行(ADR-0019 决策 25):那句「N 个 bot 在线」曾是面板专为桥写的;如今由
 * 拓展的视图交 `summary`,状态点跟着 `tone` 走。
 *
 * 值得钉的:数不出来就不说(关着 / 没跑 / 没交)—— 一个假装是 0 的数字比没有更糟;订阅源没有
 * 「N 条连接」那一行,它的 summary 也得有地方摆。
 */

import type { ExtensionDTO, ExtensionView, MarketplaceResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import Extensions from "../Extensions";

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));

vi.mock("../../services/api", () => ({
	api: {
		get: apiGetMock as unknown as (url: string) => Promise<unknown>,
		patch: vi.fn(),
		post: vi.fn(),
	},
	ApiError: class ApiError extends Error {},
}));

const MARKET: MarketplaceResponse = { available: true, fetchedAt: 1, sources: [], extensions: [] };

const DOUYIN: ExtensionDTO = {
	id: "douyin",
	name: "抖音订阅",
	version: "0.1.0",
	apiVersion: 2,
	provides: ["subscription"],
	enabled: true,
	state: "running",
	dir: "/data/extensions/douyin",
};

const PUSHER: ExtensionDTO = {
	id: "relay",
	name: "中继推送",
	version: "0.1.0",
	apiVersion: 2,
	provides: ["push"],
	enabled: true,
	state: "running",
	dir: "/data/extensions/relay",
};

function renderPage(
	extensions: ExtensionDTO[],
	views: Record<string, ExtensionView>,
	/** 页面打开之前缓存里已经有的状态(刚关掉的拓展,上一份视图还在)。 */
	cached: Record<string, ExtensionView> = {},
) {
	apiGetMock.mockImplementation(async (url: string) => {
		if (url === "/api/connections") return [];
		if (url.startsWith("/api/ext/marketplace")) return MARKET;
		const status = url.match(/^\/api\/ext\/([^/]+)\/status$/);
		if (status) {
			const view = views[status[1] as string];
			if (!view) throw new Error("not found");
			return view;
		}
		if (url === "/api/ext") return { extensions };
		throw new Error(`没有这个口:${url}`);
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	for (const [id, view] of Object.entries(cached)) qc.setQueryData(["extension-status", id], view);
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter>
				<Extensions />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** 那张卡(名字所在的玻璃卡)。 */
async function card(name: string): Promise<HTMLElement> {
	const el = (await screen.findByText(name)).closest(".bn-glass");
	if (!el) throw new Error(`找不到 ${name} 那张卡`);
	return el as HTMLElement;
}

beforeEach(() => {
	apiGetMock.mockReset();
});
afterEach(() => {
	cleanup();
});

describe("列表卡上的 summary", () => {
	it("订阅源也有那一行:点 + 富文本", async () => {
		renderPage([DOUYIN], {
			douyin: { summary: { tone: "ok", text: [{ b: "12" }, " 位作者在看"] } },
		});
		const douyin = await card("抖音订阅");
		const line = await within(douyin).findByText("位作者在看", { exact: false });
		expect(line.textContent).toBe("12 位作者在看");
		expect(within(line).getByText("12").tagName).toBe("STRONG");
	});

	it("推送源:跟在「N 条连接」后面", async () => {
		renderPage([PUSHER], { relay: { summary: { tone: "warn", text: "1 条通道断了" } } });
		const relay = await card("中继推送");
		expect(await within(relay).findByText("1 条通道断了")).toBeTruthy();
		expect(within(relay).getByText("条连接")).toBeTruthy();
	});

	/** 数不出来就不说 —— 关着的状态那一口连问都不问。 */
	it("关着:不问状态,不画", async () => {
		renderPage([{ ...DOUYIN, enabled: false, state: "disabled" }], {
			douyin: { summary: { tone: "ok", text: "12 位作者在看" } },
		});
		await card("抖音订阅");
		expect(screen.queryByText("12 位作者在看")).toBeNull();
		expect(apiGetMock).not.toHaveBeenCalledWith("/api/ext/douyin/status");
	});

	/**
	 * 刚关掉的拓展,缓存里还躺着它上一份视图 —— 那是关掉之前的数,照着画就是在说一件已经
	 * 不成立的事。
	 */
	it("关着:缓存里的旧视图也不画", async () => {
		const stale: ExtensionView = { summary: { tone: "ok", text: "12 位作者在看" } };
		renderPage([{ ...DOUYIN, enabled: false, state: "disabled" }], {}, { douyin: stale });
		await card("抖音订阅");
		expect(screen.queryByText("12 位作者在看")).toBeNull();
	});

	it("视图里没有 summary 就不画那一行", async () => {
		renderPage([DOUYIN], { douyin: { page: [] } });
		await card("抖音订阅");
		await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith("/api/ext/douyin/status"));
		// 没有那一句就什么都不说 —— 不许冒出一个空的点、或者一句 undefined。
		expect((await card("抖音订阅")).textContent).not.toContain("undefined");
	});
});
