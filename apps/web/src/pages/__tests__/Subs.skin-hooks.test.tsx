// @vitest-environment jsdom

/**
 * Subs 页那两排筛选胶囊的**皮肤挂点**。
 *
 * 页面里手写的按钮够不到 `packages/ui` 那份 `skin-hooks.test.tsx`(它只管库里的
 * 组件),于是同一类漏挂在这仓库里已经犯过两回:tab 条那排(2026-08-20 主人真机
 * 指出),和这两排(次日又指出)。症状一样 —— 整站换了皮,唯独这几颗按钮还是原样。
 *
 * 另一半是**圆角**:写死 `rounded-full` 的话,皮肤的 `radius.pill` 轴够不到它。
 * 像素风皮肤把 pill 调到 0 求一身硬直角,而这排胶囊照旧是圆的。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import Subs from "../Subs";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

function makeSub(uid: string, name: string): Subscription {
	return {
		...makeEmptySubscription(uid),
		cachedProfile: {
			name,
			avatar: "",
			sign: "",
			fans: 0,
			lastRefreshedAt: "1970-01-01T00:00:00.000Z",
		},
	};
}

function renderSubs() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Subs />
		</QueryClientProvider>,
	);
}

/** 一颗按钮身上挂着的 hook 名(`data-bn` 是空格分隔的多值属性)。 */
function hooksOf(el: Element | null): string[] {
	return (el?.getAttribute("data-bn") ?? "").split(/\s+/).filter(Boolean);
}

/** 按可见文字找那颗**按钮**本身 —— 计数与标签各在一个 span 里,得往上找。 */
function chipByText(text: string): Element {
	const hit = screen.getAllByText(text).find((n) => n.closest("button"));
	const btn = hit?.closest("button");
	if (!btn) throw new Error(`没找到写着「${text}」的按钮`);
	return btn;
}

beforeEach(() => {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path.startsWith("/api/subs"))
			// UP甲无分组(出「未分组」)、UP乙有分组(出一颗普通分组胶囊当对照)。
			return Promise.resolve([
				makeSub("111", "UP甲"),
				{ ...makeSub("222", "UP乙"), groups: ["杂谈"] },
			]);
		return Promise.resolve([]);
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("Subs 筛选胶囊 × 皮肤挂点", () => {
	it("状态筛选那排(全部/已启用/已禁用)挂 chip —— 筛选改值不执行动作", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		for (const label of ["已启用", "已禁用"]) {
			expect(hooksOf(chipByText(label)), label).toContain("chip");
		}
	});

	it("分组胶囊挂 chip", async () => {
		renderSubs();
		await waitFor(() => expect(screen.getByText("未分组")).toBeTruthy());
		expect(hooksOf(chipByText("未分组"))).toContain("chip");
	});

	it("分组胶囊的圆角走皮肤的 pill 轴,不写死", async () => {
		// 写死 rounded-full 的话,皮肤把 radius.pill 调到 0 也掰不直它。
		renderSubs();
		await waitFor(() => expect(screen.getByText("未分组")).toBeTruthy());
		const cls = chipByText("未分组").className;
		expect(cls).toContain("rounded-bn-pill");
		expect(cls).not.toContain("rounded-full");
	});

	it("分组胶囊的底不透明 —— 半透明纱靠白页垫底,壁纸皮肤下整颗洗没", async () => {
		// bg-bn-pink/10、bg-bn-surface/60 这类纱在默认装上看着刚好,是因为下面垫着
		// 白页面;壁纸皮肤把页面换掉,纱后面就是花底,选中态与未分组当场隐形
		// (2026-08-30 主人真机指出「正常状态反而看不太清」)。这一排直接坐在页面
		// 背景上,底必须自己不透明,粉调用 color-mix 落在 surface 上出。
		renderSubs();
		await waitFor(() => expect(screen.getByText("未分组")).toBeTruthy());
		// 「全部」在顶排筛选与分组排各有一颗,分组排的靠 rounded-bn-pill 认。
		const groupChips = screen
			.getAllByText(/^(全部|未分组)$/)
			.map((n) => n.closest("button"))
			.filter((b): b is HTMLButtonElement => b?.className.includes("rounded-bn-pill") ?? false);
		expect(groupChips.length).toBeGreaterThanOrEqual(2); // 全部(选中) + 未分组
		for (const b of groupChips) {
			expect(b.className, b.textContent ?? "").not.toMatch(/bg-bn-[a-z-]+\/\d+/);
		}
	});

	it("未分组与普通分组胶囊只差线型 —— 虚线 vs 实线,底/字/hover 完全一致", async () => {
		// 主人定案(2026-08-30):未分组 hover 也要粉描边,不是只加深文字;它与普通
		// 分组钮的唯一区别就是默认态一个虚线一个实线。用类集合的差集钉死「只差
		// border-dashed 一个类」,任何一侧多写/漏写样式都会在这儿露头。
		renderSubs();
		await waitFor(() => expect(screen.getByText("未分组")).toBeTruthy());
		const normal = new Set(chipByText("杂谈").className.split(/\s+/));
		const mutedCls = new Set(chipByText("未分组").className.split(/\s+/));
		expect([...mutedCls].filter((c) => !normal.has(c))).toEqual(["border-dashed"]);
		expect([...normal].filter((c) => !mutedCls.has(c))).toEqual([]);
	});
});
