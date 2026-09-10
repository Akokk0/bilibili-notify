// @vitest-environment jsdom
/**
 * 拓展被关着的时候这一页长什么样(设计稿 V1 的「B · 模块被关着」)。
 *
 * 🔴 关掉拓展与「拓展崩了」在这一页此前**长得一模一样** —— 两者都只有一句「没跑起来」。
 * 可它们要主人做的事完全相反:前者是他自己刚拨的开关,后者要他去查日志。
 *
 * ⚠️ V1 那张黄盒里还有第三句「期间发往桥的推送一律失败并记『桥接模块已关闭』」。
 * **那个字符串今天不存在**(全仓查过),所以只写查得到的:配置全留、重开会自己连回来。
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

const LINK = {
	id: "c1",
	name: "家里那台",
	enabled: true,
	kind: "extension",
	extensionId: "bridge",
	config: { token: "0123456789abcdef0123456789abcdef", bridgeKind: "koishi" },
} as unknown as Connection;

function renderPanel(enabled: boolean) {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/connections") return [LINK];
		// 关着的拓展没跑起来 —— `/status` 是 404,与「崩了」在这条路上一模一样
		throw new Error("没跑起来");
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<BridgeConnections extensionId="bridge" enabled={enabled} />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("拓展被关着", () => {
	it("说的是「是你关的」,不是「它没跑起来」", async () => {
		renderPanel(false);
		const note = await screen.findByText(/拓展关着,桥都被断开了/);
		expect(note.textContent).toMatch(/配置一样不动/);
		expect(note.textContent).toMatch(/重新打开/);
		// 「没跑起来」那句是给「崩了」用的,这时候不该出现 —— 两句一起等于没说
		expect(screen.queryByText(/没跑起来/)).toBeNull();
	});

	it("接入照样列得出来,只是整片压暗 —— 关着也得改得了配置", async () => {
		renderPanel(false);
		expect(await screen.findByText("家里那台")).toBeTruthy();
		const list = document.querySelector("[data-links-dimmed]");
		expect(list).toBeTruthy();
	});

	it("开着而 /status 还是拿不到 → 那才是「没跑起来」", async () => {
		renderPanel(true);
		expect(await screen.findByText(/没跑起来/)).toBeTruthy();
		expect(screen.queryByText(/拓展关着,桥都被断开了/)).toBeNull();
		expect(document.querySelector("[data-links-dimmed]")).toBeNull();
	});
});
