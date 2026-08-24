// @vitest-environment jsdom

/**
 * 顶栏导航项右侧那颗计数气泡 —— **选中态的颜色必须跟着这一格的文字色走**。
 *
 * 原先选中态写死 `bg-bn-pink/15 text-bn-pink`,里头藏着一条假设:「选中格的背景
 * 仍是页面底色」。默认主题下成立(选中格只是把字染粉,底没变),于是淡粉底 + 粉字
 * 看得清清楚楚 —— 一路没人发现。
 *
 * 皮肤把 `tab-active` 画成实心粉块之后假设就没了:15% 的粉纱铺在粉块上还是粉,
 * 纯粉的数字落上去等于隐形。主人真机看到的是「未选中那格数字好好的,一点进去就
 * 没了」(2026-08-24)。皮肤也救不了 —— 这颗 span 压根没有挂点。
 *
 * 所以钉的是**跟随**这件事本身,而不是某一组颜色:数字的可读性搭在「选中格的字
 * 本来就得看得清」这条既有不变量上,皮肤把 tab-active 的字改成深紫还是纯白,气泡
 * 都自动同色。未选中态反过来必须自带配色 —— 那时父色是 tertiary 浅灰。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ThemeRoot } from "../theme-root";

const apiGet = vi.hoisted(() =>
	vi.fn(async (path: string) => {
		if (path === "/api/health") return { status: "ok", uptime: 1 };
		// 两个计数都给非零 —— 0 也照样渲染气泡,但非零更贴近主人截图里的样子。
		if (path === "/api/subs") return [{ uid: "1" }, { uid: "2" }, { uid: "3" }];
		if (path === "/api/targets") return [{ id: "a" }, { id: "b" }];
		return null;
	}),
);

vi.mock("../../services/api", () => ({ api: { get: apiGet } }));

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

/** 落在 `/subs` 上 —— 于是「订阅 UP 主」是选中格,「推送目标」是未选中格。 */
async function mountAtSubs(): Promise<void> {
	const { GlassHeader } = await import("../header");
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<ThemeRoot>
				<MemoryRouter initialEntries={["/subs"]}>
					<GlassHeader />
				</MemoryRouter>
			</ThemeRoot>
		</QueryClientProvider>,
	);
	await screen.findByText("订阅 UP 主");
}

/** 某一格里那颗气泡 —— 认纯数字文本(同级还有条空的下划线 span)。 */
function countBadge(label: string): HTMLElement {
	const nav = document.querySelector('nav[data-bn~="nav"]') as Element;
	const cell = [...nav.querySelectorAll<HTMLElement>('[data-bn~="tab"]')].find((el) =>
		(el.textContent ?? "").includes(label),
	);
	if (!cell) throw new Error(`导航里没有「${label}」这一格`);
	const badge = [...cell.querySelectorAll<HTMLElement>("span")].find((s) =>
		/^\d+$/.test(s.textContent ?? ""),
	);
	if (!badge) throw new Error(`「${label}」这一格没有计数气泡`);
	return badge;
}

function isActive(label: string): boolean {
	const nav = document.querySelector('nav[data-bn~="nav"]') as Element;
	const cell = [...nav.querySelectorAll<HTMLElement>('[data-bn~="tab"]')].find((el) =>
		(el.textContent ?? "").includes(label),
	);
	return (cell?.getAttribute("data-bn") ?? "").split(/\s+/).includes("tab-active");
}

describe("顶栏计数气泡", () => {
	it("选中格的气泡不自带颜色,底与字都跟着这一格的文字色走", async () => {
		await mountAtSubs();
		expect(isActive("订阅 UP 主")).toBe(true);
		const badge = countBadge("订阅 UP 主");

		// 写死品牌粉就是那个 bug:皮肤把选中格画成粉实心块时,粉字落在粉上没影了。
		expect(badge.className).not.toContain("text-bn-pink");
		// 底也得跟随 —— 固定的粉纱铺在别的实心色上会脏,而且同样吃不到皮肤的字色。
		expect(badge.className).toContain("bg-current");
	});

	it("未选中格的气泡照旧自带配色 —— 两态没被顺手统一成一个", async () => {
		await mountAtSubs();
		expect(isActive("推送目标")).toBe(false);
		const badge = countBadge("推送目标");

		// 未选中时父色是 tertiary 浅灰,跟着走会让气泡整个糊掉:数字看不清,块也
		// 看不出边。这一态本来就没毛病(主人截图里未选中的数字是好的),别一起改。
		expect(badge.className).toContain("bg-bn-code-bg");
		expect(badge.className).toContain("text-bn-text-secondary");
	});
});
