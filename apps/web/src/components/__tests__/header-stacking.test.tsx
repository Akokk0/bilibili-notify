// @vitest-environment jsdom

import { TabBarShell } from "@bilibili-notify/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ThemeRoot } from "../theme-root";

const apiGet = vi.hoisted(() =>
	vi.fn(async (path: string) => {
		if (path === "/api/health") return { status: "ok", uptime: 1 };
		if (path === "/api/subs") return [];
		if (path === "/api/targets") return [];
		return null;
	}),
);

vi.mock("../../services/api", () => ({ api: { get: apiGet } }));

/** 从 Tailwind 类名里读出层级数字。没写 z-* → NaN,任何比较都会失败,正是想要的。 */
function zOf(el: Element): number {
	const m = /(?:^|\s)z-(\d+)(?:\s|$)/.exec(el.className.toString());
	return m ? Number(m[1]) : Number.NaN;
}

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

/**
 * 吸顶顶栏必须压得住页面内容。
 *
 * 真机上栽过:顶栏是 `sticky top-0 z-10`,而页面级 tab 条是 `relative z-30` ——
 * 往下滚,tab 条整条画在顶栏**之上**,把主导航切掉一截(2026-08-20 用
 * `elementsFromPoint` 实测,重叠 30px 处最前面的元素就是 tab 条)。默认皮肤下
 * tab 条半透明 + backdrop-blur,糊着看不出来;换上带实色描边的皮肤就一目了然。
 *
 * 这条断言钉的是**层级契约**而不是某个具体数字:顶栏 > 页面内任何内容。
 */
describe("吸顶顶栏的层级", () => {
	it("顶栏压得住页面级 tab 条 —— 否则往下滚 tab 会切掉主导航", async () => {
		const { GlassHeader } = await import("../header");
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { container } = render(
			<QueryClientProvider client={qc}>
				<ThemeRoot>
					<MemoryRouter>
						<GlassHeader />
						<TabBarShell>tab</TabBarShell>
					</MemoryRouter>
				</ThemeRoot>
			</QueryClientProvider>,
		);

		const header = container.querySelector('[data-bn~="header"]');
		const tabBar = container.querySelector('[data-bn~="nav"]');
		expect(header).toBeTruthy();
		expect(tabBar).toBeTruthy();
		expect(zOf(header as Element)).toBeGreaterThan(zOf(tabBar as Element));
	});
});
