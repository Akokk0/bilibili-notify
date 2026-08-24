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

describe("推送历史 · 类型筛选", () => {
	it("挂 chip(不再挂 btn),圆角走轴不写死", async () => {
		renderHistory();
		await waitFor(() => expect(screen.getAllByText("直播").length).toBeGreaterThan(0));
		for (const label of ["全部", "直播", "动态"]) {
			const el = chip(label);
			const hooks = (el.getAttribute("data-bn") ?? "").split(/\s+/);
			expect(hooks, label).toContain("chip");
			expect(hooks, label).not.toContain("btn");
			// 2026-08-24 从一排浮在页面上的描边胶囊换成 Picker(段选),圆角那一档
			// 也从 pill 轴挪到了 `rounded-sm`(`--radius-sm`,同样从 radius.card 派生)。
			// **要钉的不变量没变**:跟着皮肤的圆角轴走,不写死。
			expect(el.className, label).not.toContain("rounded-full");
			expect(el.className, label).not.toMatch(/rounded-\[/);
		}
	});

	/**
	 * 换成 Picker 是主人在真机上提的(2026-08-24):一排只有细描边的胶囊浮在皮肤
	 * 那层花底上,「都看不清」。Picker 自带一条实底轨道,选中那段抬起来 —— 组和
	 * 选中态都不再靠背景对比。
	 */
	it("是段选而不是一排散胶囊 —— 五段共处一条**实底**轨道", async () => {
		renderHistory();
		await waitFor(() => expect(screen.getAllByText("直播").length).toBeGreaterThan(0));
		const track = chip("全部").parentElement as HTMLElement;
		const labels = [...track.querySelectorAll("button")].map((b) => b.textContent ?? "");
		expect(labels).toEqual(["全部", "直播", "动态", "SC", "舰长"]);
		// **实底**是这次换控件的全部意义:散胶囊只有一圈细边,浮在皮肤那层花底上时
		// 组和选中态都靠背景对比,而背景是皮肤说了算的。轨道自带底色就不吃这个亏。
		expect(track.className).toMatch(/\bbg-bn-[\w-]+/);
	});

	/**
	 * 选中那段把自己那档的类型色露成 `--bn-tint`,皮肤才能顺着它描边 —— 写死一个
	 * 颜色会把五档罩成一样(真机上 chip-active 那圈紫框正是这么把颜色抹平的)。
	 */
	it("选中那段露出类型色,好让皮肤描边时认得出是哪一档", async () => {
		renderHistory();
		await waitFor(() => expect(screen.getAllByText("直播").length).toBeGreaterThan(0));
		const all = chip("全部");
		expect(all.getAttribute("data-bn")).toContain("chip-active");
		expect(all.style.getPropertyValue("--bn-tint")).not.toBe("");
		// 没选中的那几段不带 —— 同 ToneChip:未选中是中性档。
		expect(chip("直播").style.getPropertyValue("--bn-tint")).toBe("");
	});
});
