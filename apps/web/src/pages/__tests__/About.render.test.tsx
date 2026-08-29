// @vitest-environment jsdom

/**
 * About(关于 / 支持项目)页渲染测试。四个 section:支持项目(默认)/ 新手指引 /
 * 更新日志 / 关于本项目,经 SectionNav 切换(URL 驱动,点击 navigate)。
 * SectionNav 双形态(竖栏 + 横向条)→ 标签各出现两次,用 getAllBy*。
 * 新手指引 section 的内容测试在 pages/guide/__tests__/guide.test.tsx。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import About from "../About";

function renderAbout(path = "/about") {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route path="/about/:section?/:chapter?" element={<About />} />
			</Routes>
		</MemoryRouter>,
	);
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("About page", () => {
	it("defaults to the sponsor section with an afdian entry and empty sponsor list", () => {
		renderAbout();
		expect(screen.getByText("前往爱发电支持")).toBeTruthy();
		const link = screen.getByRole("link", { name: /前往爱发电/ });
		expect(link.getAttribute("href")).toContain("afdian");
		expect(screen.getByText(/还没有人发电/)).toBeTruthy();
	});

	it("shows project info after switching to the about section", async () => {
		renderAbout();
		fireEvent.click(screen.getAllByRole("button", { name: /关于本项目/ })[0]);
		expect(await screen.findByText("Akokk0/bilibili-notify")).toBeTruthy();
		expect(screen.getByText("801338523")).toBeTruthy();
		expect(screen.getByText(/MIT License/)).toBeTruthy();
	});

	it("renders the changelog panel only after switching to it", async () => {
		renderAbout();
		expect(screen.queryByText("apps/CHANGELOG.md")).toBeNull();
		fireEvent.click(screen.getAllByRole("button", { name: /更新日志/ })[0]);
		expect(await screen.findByText("apps/CHANGELOG.md")).toBeTruthy();
	});

	// 回归:入场动画(bn-anim-page-in,动画期间持有 transform)不挂在 grid 上,否则会改写
	// 内部 sticky 竖栏的包含块,使窄视口单列布局坍缩。该约束随「更新日志」从 Logs 一并迁来。
	it("keeps the entrance-animation transform off the grid/sticky layer", () => {
		const { container } = renderAbout();
		const fade = container.querySelector(".bn-anim-page-in");
		expect(fade).toBeTruthy();
		expect(fade?.classList.contains("grid")).toBe(false);
		const grid = fade?.querySelector(".grid");
		expect(grid).toBeTruthy();
		expect(grid?.querySelector("aside.sticky")).toBeTruthy();
	});

	it("renders sponsor chips with avatar and name from sponsors.json", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					sponsors: [
						{ name: "Alice", avatar: "https://cdn/a.png" },
						{ name: "Bob", avatar: "" },
					],
				}),
			})),
		);
		renderAbout();
		expect(await screen.findByText("Alice")).toBeTruthy();
		expect(screen.getByText("Bob")).toBeTruthy();
		// 有头像 → 渲染 <img alt=昵称>;无头像 → 不渲染 img
		expect(screen.getByAltText("Alice").getAttribute("src")).toBe("https://cdn/a.png");
		expect(screen.queryByAltText("Bob")).toBeNull();
	});
	it("赞助链接是颗按钮 —— 挂 btn,圆角走 pill token", () => {
		renderAbout();
		const a = screen.getByRole("link", { name: /前往爱发电支持/ });
		// 两个挂点都得有。只挂 `btn` 的话,皮肤惯写的 `[data-bn="btn"]` 精确匹配会把
		// 这颗刷成中性底,而 text-white 是写死的类 —— 真机上就这么白底白字过一次。
		expect(a.getAttribute("data-bn")).toBe("btn btn-primary");
		// rounded-full 是写死的 9999px,皮肤的 radius.pill 压不平;必须走 token 类。
		expect([a.className.includes("rounded-bn-pill"), a.className.includes("rounded-full")]).toEqual(
			[true, false],
		);
	});

	/**
	 * 换 section / 换章节是**看同一页的不同面**,不是「去了别的地方」。用 push
	 * 的话逛四个 section 再翻三个章节就压了七条历史,想退回进来前那一页要连按
	 * 七次;点当前这个 section 还会再压一条重复的。URL 仍是选中态的真源,只是
	 * 换成 replace 落。
	 */
	it("换 section 走 replace —— 逛几圈不该把返回键堵死", async () => {
		const router = createMemoryRouter(
			[{ path: "/about/:section?/:chapter?", element: <About /> }],
			{ initialEntries: ["/about"] },
		);
		render(<RouterProvider router={router} />);
		fireEvent.click(screen.getAllByText("关于本项目")[0]);
		expect(await screen.findByText(/项目主页|开源/)).toBeTruthy();
		expect(router.state.historyAction).toBe("REPLACE");
		expect(router.state.location.pathname).toBe("/about/about");
	});
});
