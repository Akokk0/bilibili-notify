// @vitest-environment jsdom
/**
 * 一条接入都没有的那一屏(设计稿 V1 的「A · 一条接入都没有」)。
 *
 * 🔴 **空态是这一页最要紧的一屏**:主人装完桥拓展、点进来,看到的必然是它。此前那儿只有
 * 一句「还没有配过接入」—— 而这一刻他需要知道的是**接下来干什么**(建一条、拿 token 和
 * 地址去填插件),那句话一个字都没说。
 *
 * (「现在接着几条 / 几个 bot 在线」那一行在**列表页**的卡上,守卫在 Extensions.render 里。)
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
