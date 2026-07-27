// @vitest-environment jsdom

/**
 * 导航条上的「挑要显示的标签」—— 接线那一半。
 *
 * 纯判定另有单测(`config/__tests__/nav.test.ts`、`store/__tests__/nav.test.ts`),
 * 这里只管界面上真的少了那一项、以及「系统」那格确实点不动。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NAV_ITEMS } from "../../config/nav";
import { useNavStore } from "../../store/nav";
import { GlassHeader } from "../header";

const apiGet = vi.hoisted(() =>
	vi.fn(async (path: string) => {
		if (path === "/api/health") return { status: "ok", uptime: 1 };
		if (path === "/api/subs") return [];
		if (path === "/api/targets") return [];
		return null;
	}),
);
vi.mock("../../services/api", () => ({ api: { get: apiGet } }));

function renderHeader() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter>
				<GlassHeader />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** 导航条上那几个链接的文字。面板里的勾选项是 label 不是 link,不会混进来。 */
function navLabels(): string[] {
	return Array.from(document.querySelectorAll("nav a")).map((a) =>
		(a.textContent ?? "").replace(/\d+$/, "").trim(),
	);
}

function openEditor(): void {
	fireEvent.click(screen.getByTitle("挑要显示的标签"));
}

beforeEach(() => {
	localStorage.clear();
	useNavStore.setState({ hidden: [], order: [] });
});

afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("导航条 — 挑要显示的标签", () => {
	it("默认全都在", async () => {
		renderHeader();
		await waitFor(() => expect(navLabels()).toContain("日志"));
		expect(navLabels()).toContain("数据统计");
	});

	it("勾掉一项 → 导航条上当场就没了", async () => {
		renderHeader();
		await waitFor(() => expect(navLabels()).toContain("日志"));

		openEditor();
		fireEvent.click(await screen.findByRole("checkbox", { name: "日志" }));

		await waitFor(() => expect(navLabels()).not.toContain("日志"));
		// 只走了这一项,别的没受牵连。
		expect(navLabels()).toContain("数据统计");
	});

	it("藏起来的只是入口 —— 路由没动,取消勾选就回来了", async () => {
		useNavStore.setState({ hidden: ["/logs"] });
		renderHeader();
		await waitFor(() => expect(navLabels()).not.toContain("日志"));

		openEditor();
		fireEvent.click(await screen.findByRole("checkbox", { name: "日志" }));
		await waitFor(() => expect(navLabels()).toContain("日志"));
	});

	it("「系统」那格点不动 —— 藏了就没地方把别的改回来了", async () => {
		renderHeader();
		openEditor();
		const box = await screen.findByRole("checkbox", { name: "系统" });
		expect((box as HTMLInputElement).disabled).toBe(true);
		expect((box as HTMLInputElement).checked).toBe(true);
	});

	it("「全部显示」一键收回,藏多了不必一个个点回来", async () => {
		useNavStore.setState({ hidden: ["/logs", "/stats", "/about"] });
		renderHeader();
		await waitFor(() => expect(navLabels()).not.toContain("日志"));

		openEditor();
		fireEvent.click(await screen.findByText("全部显示"));

		await waitFor(() => expect(navLabels()).toContain("日志"));
		expect(navLabels()).toContain("数据统计");
		expect(navLabels()).toContain("关于");
	});

	it("每一项都有拖拽手柄 —— 重排本身由 moveNavPath / store 的单测钉住", async () => {
		renderHeader();
		openEditor();
		// 面板里列的是**全部**项(含藏起来的):先摆好位置再决定显不显示。
		await waitFor(() => expect(screen.getAllByTitle("拖动排序")).toHaveLength(NAV_ITEMS.length));
	});

	it("藏起来的项在面板里照样列着,也照样能拖", async () => {
		useNavStore.setState({ hidden: ["/logs"] });
		renderHeader();
		openEditor();
		expect(await screen.findByRole("checkbox", { name: "日志" })).toBeTruthy();
		expect(screen.getByLabelText("拖动排序 日志")).toBeTruthy();
	});

	it("顺序改了 → 导航条跟着改,不用刷新", async () => {
		renderHeader();
		await waitFor(() => expect(navLabels()[0]).toBe("概览"));

		useNavStore.getState().reorder("/about", "/");
		await waitFor(() => expect(navLabels()[0]).toBe("关于"));
	});

	it("「默认顺序」把顺序收回代码里那份", async () => {
		useNavStore.getState().reorder("/about", "/");
		renderHeader();
		await waitFor(() => expect(navLabels()[0]).toBe("关于"));

		openEditor();
		fireEvent.click(await screen.findByText("默认顺序"));
		await waitFor(() => expect(navLabels()[0]).toBe("概览"));
	});

	it("排序与显隐互不干扰 —— 拖一下不该把藏起来的抖回来", async () => {
		useNavStore.setState({ hidden: ["/logs"] });
		renderHeader();
		await waitFor(() => expect(navLabels()).not.toContain("日志"));

		useNavStore.getState().reorder("/about", "/");
		await waitFor(() => expect(navLabels()[0]).toBe("关于"));
		expect(navLabels()).not.toContain("日志");
	});

	it("点面板外面就收起来 —— 但勾选框本身不该顺手把面板关掉", async () => {
		renderHeader();
		openEditor();
		expect(await screen.findByText("标签显示与排序")).toBeTruthy();

		// 面板里点一下:还开着,好接着勾下一项。
		fireEvent.click(await screen.findByRole("checkbox", { name: "日志" }));
		expect(screen.queryByText("标签显示与排序")).toBeTruthy();

		fireEvent.pointerDown(document.body);
		await waitFor(() => expect(screen.queryByText("标签显示与排序")).toBeNull());
	});
});
