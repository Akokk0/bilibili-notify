// @vitest-environment jsdom
/**
 * 「联网搜索」胶囊 —— 与隔壁「深度思考」同一套纪律:会话级受控、不落盘。
 *
 * 特有的一条:「能不能开」看**当前搜索后端那格 key 配没配**。GET 回来的 globals
 * 里 key 是脱敏占位(REDACTED),但「非空 = 配了」这个判据照常成立 —— 这里守住
 * 它别退化成去比对 key 内容。没配时灰着并指路设置页。
 */

import { makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { SearchControl } from "../search-control";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

function globalsWith(bochaKey: string | { masked: string }) {
	const g = makeDefaultGlobalSettings();
	// GET 出来的形态:key 非空时是 `{ masked }`,不是明文;没配是空串。
	g.ai.search.keys.bocha = bochaKey as string;
	return g;
}

function mount(
	bochaKey: string | { masked: string },
	props: { on: boolean; onToggle: (v: boolean) => void },
) {
	vi.mocked(api.get).mockResolvedValue({ core: JSON.parse(JSON.stringify(globalsWith(bochaKey))) });
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SearchControl {...props} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	i18n.set({ locale: "zh-CN", voice: "plain" });
});
afterEach(cleanup);

it("search capsule translates without changing its session state or persisting settings", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	const onToggle = vi.fn();
	mount({ masked: "••••••••" }, { on: true, onToggle });
	const button = await screen.findByRole("button", { name: "Web search" });
	for (const [locale, label, hint] of [
		["en", "Web search", "Web search is on (Bocha) for this conversation only."],
		["ja", "ウェブ検索", "ウェブ検索は有効です（Bocha）。この会話だけに適用します。"],
		["zh-TW", "網路搜尋", "網路搜尋已開啟（博查），僅適用於目前對話。"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByRole("button", { name: label })).toBe(button);
		expect(button.getAttribute("title")).toBe(hint);
		expect(button.getAttribute("aria-pressed")).toBe("true");
		expect(onToggle).not.toHaveBeenCalled();
		expect(api.patch).not.toHaveBeenCalled();
		expect(api.post).not.toHaveBeenCalled();
	}
	fireEvent.click(button);
	expect(onToggle).toHaveBeenCalledExactlyOnceWith(false);
});

describe("SearchControl — 会话级受控胶囊", () => {
	it("key 已配(下发的是遮挡)→ 可点,点一下回调 onToggle 且不写配置", async () => {
		const onToggle = vi.fn();
		mount({ masked: "••••••••" }, { on: false, onToggle });
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
		mount({ masked: "••••••••" }, { on: true, onToggle: () => {} });
		const btn = await screen.findByRole("button", { name: "联网搜索" });
		expect(btn.getAttribute("aria-pressed")).toBe("true");
	});
});
