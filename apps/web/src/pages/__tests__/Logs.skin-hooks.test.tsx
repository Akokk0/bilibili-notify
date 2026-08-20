// @vitest-environment jsdom

/**
 * 运行日志顶栏那排控制胶囊的皮肤挂点与圆角轴 —— 与 `History.skin-hooks.test.tsx`
 * 同一条契约。这一页此前整排都没挂:同样是筛选胶囊,推送历史那排跟着换肤走造型、
 * 这排不走,换上会改按钮造型的皮肤(如像素窗口的直角实底)两页当场对不齐。
 *
 * 选中态那几个颜色**不**在契约里:等级色走 `LEVEL_TONE`(error 红 / warn 橙 …),
 * 暂停用橙、自动滚动用蓝,都是「这是什么状态」的语义色,不该跟着主强调色换。
 * 它们写在 inline `style` 里,皮肤本来也压不过 —— 挂点管的是造型(圆角、描边
 * 样式、阴影、字重),不是这几个语义色。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import Logs from "../Logs";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));
vi.mock("../../hooks/useLogChannel", () => ({ useLogChannel: () => undefined }));

import { api } from "../../services/api";

function renderLogs() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Logs />
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
	// 这一页挂载后会把视口滚到底;jsdom 不带这个方法,不打桩就死在渲染里、
	// 断言一条都跑不到(红得像挂点没挂,其实是环境缺件)。
	Element.prototype.scrollIntoView = vi.fn();
	(api.get as ReturnType<typeof vi.fn>).mockImplementation(() =>
		Promise.resolve({ entries: [], days: [] }),
	);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("运行日志 · 顶栏控制胶囊", () => {
	it("等级胶囊挂 btn,且圆角走皮肤的 pill 轴", async () => {
		renderLogs();
		await waitFor(() => expect(screen.getAllByText("error").length).toBeGreaterThan(0));
		for (const label of ["error", "warn", "info"]) {
			const el = chip(label);
			expect(el.getAttribute("data-bn"), label).toBe("btn");
			expect(el.className, label).toContain("rounded-bn-pill");
			expect(el.className, label).not.toContain("rounded-full");
		}
	});

	it("暂停 / 自动滚动 / 下载三颗也挂 btn —— 同一排不许半挂", async () => {
		renderLogs();
		await waitFor(() => expect(screen.getAllByText("自动滚动").length).toBeGreaterThan(0));
		for (const label of ["暂停", "自动滚动"]) {
			const el = chip(label);
			expect(el.getAttribute("data-bn"), label).toBe("btn");
			expect(el.className, label).toContain("rounded-bn-pill");
		}
		const dl = screen
			.getAllByText(/\.jsonl/)
			.find((n) => n.closest("button"))
			?.closest("button");
		expect(dl?.getAttribute("data-bn")).toBe("btn");
	});
});
