// @vitest-environment jsdom

/**
 * web 侧的皮肤挂点守卫。
 *
 * `packages/ui` 那边早有一份(`src/__tests__/skin-hooks.test.tsx`,逐个钉住库里
 * 6 个挂点),而 web 侧一条都没有 —— 偏偏 web 的挂点面是库的三倍多。缺口的代价
 * 在 2026-08-20 的清扫里量出来了:设置面板的 87 处输入框、顶栏那条一级导航、
 * ScopeTabs 的 per-UP tab,全都没挂,于是皮肤写 `[data-bn="input"]{…}` 只改到
 * 登录框和几个搜索框,整片设置区纹丝不动。
 *
 * 这些挂点是**零视觉**的(纯属性,不带样式),所以重构时最容易被顺手删掉而没人
 * 发现 —— 构建绿、测试绿、页面看着一模一样,只有装了皮肤的真机上才露馅。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TArea, TInput, TNum, TSelect } from "../components/forms";
import { ThemeRoot } from "../components/theme-root";

const apiGet = vi.hoisted(() =>
	vi.fn(async (path: string) => {
		if (path === "/api/health") return { status: "ok", uptime: 1 };
		if (path === "/api/subs") return [];
		if (path === "/api/targets") return [];
		return null;
	}),
);

vi.mock("../services/api", () => ({ api: { get: apiGet } }));

beforeEach(() => {
	apiGet.mockClear();
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			media: "(prefers-color-scheme: dark)",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("设置面板的输入框挂 input 挂点", () => {
	it("T 系列四件都挂上 —— 全站 87 处输入框走的是它们,不是库里的 Input 原语", () => {
		const noop = () => {};
		const { container } = render(
			<>
				<TInput value="" onChange={noop} />
				<TArea value="" onChange={noop} />
				<TNum value={1} onChange={noop} />
				<TSelect value="a" onChange={noop} options={[{ value: "a", label: "A" }]} />
			</>,
		);

		// 四个控件各自的原生标签,逐个确认挂点落在**控件本身**而不是外层 div ——
		// 挂在包装层上皮肤改的是包装层,输入框还是默认装。
		for (const tag of ["input[type='text']", "textarea", "input[type='number']", "select"]) {
			const el = container.querySelector(tag);
			expect(`${tag} 存在`).toBe(`${el ? tag : "缺失"} 存在`);
			expect(`${tag}=${el?.getAttribute("data-bn")}`).toBe(`${tag}=input`);
		}
	});
});

describe("顶栏的一级导航挂 nav / btn", () => {
	it("顶栏自己那条 nav 也要挂 —— 次级导航挂了它没挂时,同屏对比一眼看得出没做完", async () => {
		const { GlassHeader } = await import("../components/header");
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { container } = render(
			<QueryClientProvider client={qc}>
				<ThemeRoot>
					<MemoryRouter>
						<GlassHeader />
					</MemoryRouter>
				</ThemeRoot>
			</QueryClientProvider>,
		);

		const nav = container.querySelector('nav[data-bn~="nav"]');
		expect(nav).toBeTruthy();
		// 导航项是链接式按钮,与 Btn 同口径挂 btn。
		expect((nav?.querySelectorAll('[data-bn~="btn"]').length ?? 0) > 0).toBe(true);
	});
});
