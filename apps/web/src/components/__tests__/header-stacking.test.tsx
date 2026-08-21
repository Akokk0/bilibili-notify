// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * 从类名里读出层级值。
 *
 * 类名现在是 `z-bn-header` 这样的名字,数字在 `theme.css` 的分层表里 —— jsdom 不加载
 * 那份 CSS,所以直接解析文件。没写 `z-bn-*`、或名字表里查无此项 → NaN,任何比较都会
 * 失败,正是想要的(拼错的 utility Tailwind 是静默丢弃的,一个 NaN 比一条假绿好)。
 */
const Z_TABLE = (() => {
	const css = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "../../../../../packages/ui/src/theme.css"),
		"utf8",
	);
	return new Map(
		[...css.matchAll(/--(z-bn-[a-z-]+):\s*(\d+)/g)].map(([, name, v]) => [name, Number(v)]),
	);
})();

function zOf(el: Element): number {
	const m = /(?:^|\s)(z-bn-[a-z-]+)(?:\s|$)/.exec(el.className.toString());
	return m ? (Z_TABLE.get(m[1]) ?? Number.NaN) : Number.NaN;
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
		// 顶栏**内部**也有一条挂 `nav` 的一级导航,所以不能拿第一个 `[data-bn~="nav"]`
		// 了事 —— 那样量到的是顶栏自己的子元素(它没写 z-*,zOf 会得到 NaN,断言直接
		// 失败但原因具有误导性)。这里要的是**页面级**那条,即顶栏之外的那个。
		const tabBar = Array.from(container.querySelectorAll('[data-bn~="nav"]')).find(
			(el) => !header?.contains(el),
		);
		expect(header).toBeTruthy();
		expect(tabBar).toBeTruthy();
		expect(zOf(header as Element)).toBeGreaterThan(zOf(tabBar as Element));
	});
});
