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
		if (path.startsWith("/api/subs")) return Promise.resolve([makeSub("111", "UP甲")]);
		return Promise.resolve([]);
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("Subs 筛选胶囊 × 皮肤挂点", () => {
	it("状态筛选那排(全部/已启用/已禁用)挂 btn", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		for (const label of ["已启用", "已禁用"]) {
			expect(hooksOf(chipByText(label)), label).toContain("btn");
		}
	});

	it("分组胶囊挂 btn", async () => {
		renderSubs();
		await waitFor(() => expect(screen.getByText("未分组")).toBeTruthy());
		expect(hooksOf(chipByText("未分组"))).toContain("btn");
	});

	it("分组胶囊的圆角走皮肤的 pill 轴,不写死", async () => {
		// 写死 rounded-full 的话,皮肤把 radius.pill 调到 0 也掰不直它。
		renderSubs();
		await waitFor(() => expect(screen.getByText("未分组")).toBeTruthy());
		const cls = chipByText("未分组").className;
		expect(cls).toContain("rounded-bn-pill");
		expect(cls).not.toContain("rounded-full");
	});
});
