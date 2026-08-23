// @vitest-environment jsdom

/**
 * 推送历史那排类型筛选胶囊的皮肤挂点与圆角轴 —— 与 `Subs.skin-hooks.test.tsx`
 * 同一条契约,只是长在另一页上。
 *
 * 选中态那三个颜色**不**在契约里:它们走 `PUSH_TONE`(直播粉 / 动态蓝 / SC 橙 /
 * 舰长蓝),那是「这条推送是什么类型」的内容语义色,与卡片渲染器共用一份,不该
 * 跟着换肤走 —— 换了主强调色也不该把「直播」染成别的颜色。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import History from "../History";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

function renderHistory() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<History />
		</QueryClientProvider>,
	);
}

function chip(text: string): HTMLButtonElement {
	const hit = screen.getAllByText(text).find((n) => n.closest("button"));
	const btn = hit?.closest("button");
	if (!btn) throw new Error(`没找到写着「${text}」的按钮`);
	return btn as HTMLButtonElement;
}

beforeEach(() => {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation(() =>
		Promise.resolve({ entries: [], total: 0 }),
	);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("推送历史 · 类型筛选胶囊", () => {
	it("挂 chip(不再挂 btn),且圆角走皮肤的 pill 轴", async () => {
		renderHistory();
		await waitFor(() => expect(screen.getAllByText("直播").length).toBeGreaterThan(0));
		for (const label of ["全部", "直播", "动态"]) {
			const el = chip(label);
			const hooks = (el.getAttribute("data-bn") ?? "").split(/\s+/);
			expect(hooks, label).toContain("chip");
			expect(hooks, label).not.toContain("btn");
			expect(el.className, label).toContain("rounded-bn-pill");
			expect(el.className, label).not.toContain("rounded-full");
		}
	});
});
