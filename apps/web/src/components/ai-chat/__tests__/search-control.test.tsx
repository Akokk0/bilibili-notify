// @vitest-environment jsdom
/**
 * 「联网搜索」胶囊 —— 与隔壁「深度思考」同一套纪律:会话级受控、不落盘。
 *
 * 特有的一条:「能不能开」看**当前搜索后端那格 key 配没配**。GET 回来的 globals
 * 里 key 是脱敏占位(REDACTED),但「非空 = 配了」这个判据照常成立 —— 这里守住
 * 它别退化成去比对 key 内容。没配时灰着并指路设置页。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SearchControl } from "../search-control";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

function globalsWith(bochaKey: string) {
	const g = makeDefaultGlobalConfig();
	// GET 出来的形态:key 非空时是脱敏占位,不是明文。
	g.defaults.ai.search.keys.bocha = bochaKey;
	return g;
}

function mount(bochaKey: string, props: { on: boolean; onToggle: (v: boolean) => void }) {
	vi.mocked(api.get).mockResolvedValue(JSON.parse(JSON.stringify(globalsWith(bochaKey))));
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SearchControl {...props} />
		</QueryClientProvider>,
	);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("SearchControl — 会话级受控胶囊", () => {
	it("key 已配(脱敏占位也算)→ 可点,点一下回调 onToggle 且不写配置", async () => {
		const onToggle = vi.fn();
		mount("__BN_REDACTED__", { on: false, onToggle });
		const btn = (await screen.findByRole("button", { name: "联网搜索" })) as HTMLButtonElement;
		expect(btn.disabled).toBe(false);
		fireEvent.click(btn);
		expect(onToggle).toHaveBeenCalledWith(true);
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("key 没配 → 灰着并指路设置页", async () => {
		mount("", { on: false, onToggle: () => {} });
		const btn = (await screen.findByRole("button", { name: "联网搜索" })) as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
		expect(btn.title).toContain("联网搜索");
		expect(btn.title).toContain("API Key");
	});

	it("aria-pressed 跟 props 走", async () => {
		mount("__BN_REDACTED__", { on: true, onToggle: () => {} });
		const btn = await screen.findByRole("button", { name: "联网搜索" });
		expect(btn.getAttribute("aria-pressed")).toBe("true");
	});
});
