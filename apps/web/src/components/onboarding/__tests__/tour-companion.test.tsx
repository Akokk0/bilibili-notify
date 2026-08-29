// @vitest-environment jsdom

/**
 * 新手导览(四轮定稿:**永久常驻,无关闭态**)的行为:
 * 标签 ⇄ 小卡两态切换,毕业老用户也常驻标签;「跳过/彻底关闭」概念已退役
 * (server dismissed 字段一并删除)。有锚点的子步在目标路由上时渲染聚光灯
 * 挖洞层;折叠时聚光灯一并收起。判据跟随逻辑在 tour.test.ts。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useAuthStore } from "../../../store/auth";
import { BiliLoginStatus } from "../../../types/auth";

const apiGet = vi.hoisted(() => vi.fn(async (_path: string) => null as unknown));
const apiPatch = vi.hoisted(() => vi.fn(async (_p: string, _b?: unknown) => ({})));

vi.mock("../../../services/api", () => ({ api: { get: apiGet, patch: apiPatch } }));

interface Scenario {
	loggedIn?: boolean;
	subs?: unknown[];
	adapters?: unknown[];
	targets?: unknown[];
	route?: string;
}

async function mount(s: Scenario) {
	useAuthStore.setState({
		snapshot: {
			status: s.loggedIn ? BiliLoginStatus.LOGGED_IN : BiliLoginStatus.NOT_LOGIN,
			msg: "",
		},
	});
	apiGet.mockImplementation(async (path: string) => {
		if (path === "/api/subs") return s.subs ?? [];
		if (path === "/api/adapters") return s.adapters ?? [];
		if (path === "/api/targets") return s.targets ?? [];
		if (path === "/api/health")
			return { status: "ok", uptime: 1, modules: { image: false, ai: false } };
		return null;
	});
	const { TourCompanion } = await import("../tour-companion");
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[s.route ?? "/"]}>
				<TourCompanion />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	apiGet.mockReset();
	apiPatch.mockReset();
	apiPatch.mockResolvedValue({});
	localStorage.clear();
	// jsdom 没有 scrollIntoView;聚光灯首次锁定目标时会调它
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	useAuthStore.getState().clear();
	for (const el of document.querySelectorAll("[data-tour]")) el.remove();
	vi.restoreAllMocks();
});

describe("TourCompanion 常驻小卡", () => {
	it("新用户(未收起未毕业):常驻显示当前步,无需任何入口", async () => {
		await mount({ route: "/" });
		expect(await screen.findByText("扫码登录 B 站")).toBeTruthy();
		expect(screen.getByRole("button", { name: "带我去" })).toBeTruthy();
	});

	it("没有任何「彻底关闭」控件 —— 跳过指引已退役,只有收起", async () => {
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		expect(screen.queryByRole("button", { name: "跳过指引" })).toBeNull();
		expect(screen.getByRole("button", { name: "收起" })).toBeTruthy();
	});

	it("聚光灯:在目标路由且锚点元素存在时渲染挖洞层", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(anchorEl);
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
	});

	it("聚光灯交互即退散:在锚点上按下后暗幕整层消失(别盖住点击弹出的二维码)", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(anchorEl);
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
		fireEvent.pointerDown(anchorEl);
		await waitFor(() => expect(screen.queryByTestId("tour-spotlight")).toBeNull());
	});

	it("不在目标路由:无聚光灯,给「带我去」", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(anchorEl);
		await mount({ route: "/" });
		await screen.findByText("扫码登录 B 站");
		expect(screen.queryByTestId("tour-spotlight")).toBeNull();
	});

	it("adapter 主步:登录后直接进入(订阅在最后),子步手动翻页", async () => {
		await mount({ loggedIn: true, route: "/targets" });
		expect(await screen.findByText("先选一条 QQ 接入路线")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "下一步" }));
		expect(await screen.findByText("新建推送适配器")).toBeTruthy();
	});

	it("通道全通后收尾步是订阅", async () => {
		await mount({
			loggedIn: true,
			adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
			targets: [{ id: "t1", enabled: true, testStatus: { ok: true } }],
			route: "/subs",
		});
		expect(await screen.findByText("订阅第一个 UP")).toBeTruthy();
	});

	it("「收起」折叠成左缘标签:卡摘出可达性树与聚光灯,进度还活在标签上", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(anchorEl);
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		fireEvent.click(screen.getByRole("button", { name: "收起" }));
		// 卡仍在 DOM(退场动画要演完 —— styles.css 按 data-shown 做两态交接),
		// 但 inert + aria-hidden 把它摘出焦点链与读屏,byRole 于是查不到。
		const card = document.querySelector('aside[aria-label="新手导览"]');
		expect(card?.getAttribute("data-shown")).toBe("false");
		expect(card?.getAttribute("aria-hidden")).toBe("true");
		expect(card?.hasAttribute("inert")).toBe(true);
		expect(screen.queryByRole("button", { name: "收起" })).toBeNull();
		expect(screen.queryByTestId("tour-spotlight")).toBeNull();
		const tab = screen.getByRole("button", { name: "展开新手导览" });
		expect(tab.textContent).toContain("0/5");
		expect(localStorage.getItem("bn-tour-collapsed")).toBe("1");
	});

	it("morph 轨迹:切换前把对方矩形 pose 写进 CSS 变量(iOS zoom 式互变)", async () => {
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		fireEvent.click(screen.getByRole("button", { name: "收起" }));
		// styles.css 的隐藏态 transform 消费这两个变量 —— 缺了它们 morph 退化成原地淡入
		const card = document.querySelector('aside[aria-label="新手导览"]') as HTMLElement;
		const tab = document.querySelector('button[aria-label="展开新手导览"]') as HTMLElement;
		expect(card.style.getPropertyValue("--bn-tour-to-tab")).toContain("translate(");
		expect(card.style.getPropertyValue("--bn-tour-to-tab")).toContain("scale(");
		expect(tab.style.getPropertyValue("--bn-tour-to-card")).toContain("translate(");
	});

	it("展开态下标签也常驻 DOM(动画交接的前提),同样被 inert 摘出交互", async () => {
		await mount({ route: "/" });
		await screen.findByText("扫码登录 B 站");
		const tab = document.querySelector('button[aria-label="展开新手导览"]');
		expect(tab?.getAttribute("data-shown")).toBe("false");
		expect(tab?.hasAttribute("inert")).toBe(true);
		expect(screen.queryByRole("button", { name: "展开新手导览" })).toBeNull();
	});

	it("点左缘标签重新展开", async () => {
		localStorage.setItem("bn-tour-collapsed", "1");
		await mount({ route: "/" });
		const tab = await screen.findByRole("button", { name: "展开新手导览" });
		fireEvent.click(tab);
		expect(await screen.findByText("扫码登录 B 站")).toBeTruthy();
		expect(localStorage.getItem("bn-tour-collapsed")).toBe("0");
	});

	it("全绿(毕业老用户):照样常驻 —— 祝贺态列未开启尾巴,点「收起」变标签", async () => {
		await mount({
			loggedIn: true,
			subs: [{ id: "s1" }],
			adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
			targets: [{ id: "t1", enabled: true, testStatus: { ok: true } }],
		});
		expect(await screen.findByText(/全部配置完成/)).toBeTruthy();
		// 尾巴链接指向关于页里的教程章节(五轮定稿:/guide 独立路由已撤)
		const tail = screen.getByRole("link", { name: /图片渲染/ });
		expect(tail.getAttribute("href")).toBe("/about/guide/render");
		fireEvent.click(screen.getByRole("button", { name: "收起" }));
		const tab = screen.getByRole("button", { name: "展开新手导览" });
		expect(tab.textContent).toContain("5/5");
		expect(apiPatch).not.toHaveBeenCalled();
	});
});
