// @vitest-environment jsdom

/**
 * About(关于 / 支持项目)页渲染测试。四个 section:支持项目(默认)/ 新手指引 /
 * 更新日志 / 关于本项目,经 SectionNav 切换(URL 驱动,点击 navigate)。
 * SectionNav 双形态(竖栏 + 横向条)→ 标签各出现两次,用 getAllBy*。
 * 新手指引 section 的内容测试在 pages/guide/__tests__/guide.test.tsx。
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import About from "../About";

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

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

it("about navigation follows locale while historical release notes keep their original text", async () => {
	renderAbout("/about/changelog");
	const original = await screen.findByRole("heading", { name: "Changelog · 独立端" });
	for (const [locale, notes, support, project] of [
		["en", "Release notes", "Support the project", "About this project"],
		["ja", "リリースノート", "プロジェクトを応援", "このプロジェクトについて"],
		["zh-TW", "更新日誌", "支持專案", "關於本專案"],
	] as const) {
		await act(async () => {
			i18n.set({ locale, voice: "plain" });
		});
		expect(screen.getAllByRole("button", { name: notes }).length).toBeGreaterThan(0);
		expect(screen.getAllByRole("button", { name: support }).length).toBeGreaterThan(0);
		expect(screen.getAllByRole("button", { name: project }).length).toBeGreaterThan(0);
		expect(screen.getByRole("heading", { name: "Changelog · 独立端" })).toBe(original);
		expect(screen.getAllByText("apps/CHANGELOG.md").length).toBeGreaterThan(0);
	}
});

it.each([
	[
		"ja",
		"/about",
		"ご主人様、Bilibili NotifyはMITライセンスのオープンソースで、これからも無料です。サーバーやテスト機器、開発を続けるためには費用がかかります。お役に立てたら、Afdianでメイドにミルクティーをごちそうしていただけるとうれしいです。いただいたお気持ちは、新機能の開発や不具合の修正につなげますね。",
		"afdian",
	],
	[
		"zh-TW",
		"/about",
		"主人，Bilibili Notify 是採用 MIT 授權、永久免費的開源專案。伺服器、測試設備和持續開發都需要成本，如果有幫上您的忙，歡迎到愛發電請女僕喝杯奶茶喔。每一份心意，都會化為新功能和更少的 bug。",
		"afdian",
	],
	[
		"ja",
		"/about/about",
		"ご主人様、Bilibili Notifyはさまざまなソースの投稿や配信を見守り、画像カードにして送信先へお届けします。Webダッシュボードを備え、Dockerイメージでもデスクトップアプリでも導入できますよ。MITライセンスのオープンソースです。",
		"github.com/Akokk0/bilibili-notify",
	],
	[
		"zh-TW",
		"/about/about",
		"主人，Bilibili Notify 會留意不同來源的作品與直播，繪製成卡片圖片並推播到目標喔。內建 Web 控制台，支援 Docker 映像檔和桌面應用程式部署，採用 MIT 開源授權。",
		"github.com/Akokk0/bilibili-notify",
	],
] as const)("%s %s 女仆说明不改项目与支持链接", (locale, path, description, destination) => {
	renderAbout(path);
	act(() => i18n.set({ locale, voice: "maid" }));
	expect(screen.getByText(description)).toBeTruthy();
	expect(
		screen.getAllByRole("link").some((link) => link.getAttribute("href")?.includes(destination)),
	).toBe(true);
});
