// @vitest-environment jsdom

/**
 * 新手导览(四轮定稿:**永久常驻,无关闭态**)的行为:
 * 标签 ⇄ 小卡两态切换,毕业老用户也常驻标签;**没有关闭态**(旧 server dismissed
 * 字段已删),但有「跳过指引」—— 它只记一笔 `onboarding.skipped` 让导览不再自动
 * 展开,标签照旧在(见下方同名 describe)。有锚点的子步在目标路由上时渲染聚光灯
 * 挖洞层 —— 亮灯即引导锁(洞外拦截层吃掉点击);折叠时聚光灯与锁一并收起。
 * 流转单向:说明步抵达即翻过,没有「上一步」。判据跟随逻辑在 tour.test.ts。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useAuthStore } from "../../../store/auth";
import { useNavStore } from "../../../store/nav";
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
	/** globals 里那笔 `onboarding.skipped` —— 缺省 = 老配置补出来的「没跳过」。 */
	skipped?: boolean;
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
		if (path === "/api/globals") return { onboarding: { skipped: s.skipped === true } };
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
	useNavStore.setState({ hidden: [], order: [] });
	// jsdom 没有 scrollIntoView;聚光灯首次锁定目标时会调它
	Element.prototype.scrollIntoView = vi.fn();
	// jsdom 不做布局,getClientRects 恒空 —— 聚光灯用它滤掉 display:none 的实例,
	// 这里默认给所有元素一个盒,单个测试可在具体元素上覆盖为空来模拟隐藏。
	Element.prototype.getClientRects = () => [new DOMRect(0, 0, 24, 24)] as unknown as DOMRectList;
});

afterEach(() => {
	cleanup();
	useAuthStore.getState().clear();
	for (const el of document.querySelectorAll("[data-tour]")) el.remove();
	for (const el of document.querySelectorAll("[data-tour-nav]")) el.remove();
	for (const el of document.querySelectorAll('[data-bn="modal"]')) el.remove();
	vi.restoreAllMocks();
});

/** 模拟顶栏导航页签挂点(真身在 header.tsx 的 NavLink 上)。 */
function mountNavAnchor(to: string): HTMLElement {
	const el = document.createElement("a");
	el.setAttribute("data-tour-nav", to);
	document.body.appendChild(el);
	return el;
}

describe("TourCompanion 常驻小卡", () => {
	it("新用户(未收起未毕业):常驻显示当前步,无需任何入口", async () => {
		await mount({ route: "/" });
		expect(await screen.findByText("扫码登录 B 站")).toBeTruthy();
		// 「带我去」已退役 —— 跨页由聚光灯照导航页签指路,小卡只留一句提示
		expect(screen.queryByRole("button", { name: "带我去" })).toBeNull();
		expect(screen.getByText(/点亮起的页签前往/)).toBeTruthy();
		// 小卡是步骤指令来源,z 走 tour-panel 档 —— 弹窗遮罩/聚光灯暗幕都压不到它
		const card = document.querySelector('aside[aria-label="新手导览"]');
		expect(card?.className).toContain("z-bn-tour-panel");
	});

	/**
	 * 「跳过指引」(2026-08-30 主人定案,针对存量用户被引导锁困住的问题)。
	 *
	 * 判据认「按过测试」才算配好适配器,而绝大多数老用户从没点过那个按钮 ——
	 * 升级后他们一律被判成「没配完」,导览自动展开、引导锁把面板锁到只剩聚光灯
	 * 那一处。跳过是他们唯一的出口,所以它必须:落在**配置**(换浏览器/换机器
	 * 不该再被锁一次)、且**不是关闭**(左缘标签照常常驻,随时点回来)。
	 */
	describe("跳过指引", () => {
		it("配置里已跳过 → 开面板直接是标签态,不自动展开(存量用户不再被锁)", async () => {
			await mount({ route: "/system", skipped: true });
			await waitFor(() =>
				expect(
					document.querySelector('aside[aria-label="新手导览"]')?.getAttribute("data-shown"),
				).toBe("false"),
			);
			// 收起 ≠ 关闭:标签仍在,进度照常挂在上面
			expect(screen.getByRole("button", { name: "展开新手导览" })).toBeTruthy();
			expect(screen.queryByTestId("tour-spotlight")).toBeNull();
		});

		it("点「跳过指引」→ 标记落进配置并收起;标签不跟着消失", async () => {
			await mount({ route: "/system" });
			await screen.findByText("扫码登录 B 站");
			fireEvent.click(screen.getByRole("button", { name: "跳过指引" }));
			await waitFor(() =>
				expect(apiPatch).toHaveBeenCalledWith("/api/globals", { onboarding: { skipped: true } }),
			);
			const card = document.querySelector('aside[aria-label="新手导览"]');
			expect(card?.getAttribute("data-shown")).toBe("false");
			expect(screen.getByRole("button", { name: "展开新手导览" })).toBeTruthy();
		});

		it("走完五步毕业 → 自动记下标记,下次开面板不再拿 🎉 卡糊人一脸", async () => {
			await mount({
				subs: [{ id: "s1" }],
				adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
				targets: [{ id: "t1", enabled: true, testStatus: { ok: true } }],
				route: "/system",
			});
			await screen.findByText("扫码登录 B 站");
			expect(apiPatch).not.toHaveBeenCalled();
			act(() => {
				useAuthStore.setState({ snapshot: { status: BiliLoginStatus.LOGGED_IN, msg: "" } });
			});
			await waitFor(() =>
				expect(apiPatch).toHaveBeenCalledWith("/api/globals", { onboarding: { skipped: true } }),
			);
		});

		it("已跳过的实例不重复写标记 —— 每次开面板都 PATCH 一次是纯噪音", async () => {
			await mount({ route: "/system", skipped: true });
			await waitFor(() =>
				expect(
					document.querySelector('aside[aria-label="新手导览"]')?.getAttribute("data-shown"),
				).toBe("false"),
			);
			expect(apiPatch).not.toHaveBeenCalled();
		});
	});

	it("聚光灯:在目标路由且锚点元素存在时渲染挖洞层", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(anchorEl);
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
	});

	it("聚光灯即引导锁:亮灯时铺四块洞外拦截层,退散后一并撤掉", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(anchorEl);
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
		// 洞外指针操作被吃掉 —— 引导模式下只允许做被指的那一步;洞内无遮挡
		// (块数 = 视口减洞集的矩形分割结果,几何相关,只钉「确实铺了」)
		const blocker = screen.getByTestId("tour-blocker");
		expect(blocker.querySelectorAll(".pointer-events-auto").length).toBeGreaterThan(0);
		fireEvent.pointerDown(anchorEl);
		await waitFor(() => expect(screen.queryByTestId("tour-blocker")).toBeNull());
	});

	it("聚光灯交互即退散:在锚点上按下后暗幕消失(别盖住点击弹出的内容)", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(anchorEl);
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
		fireEvent.pointerDown(anchorEl);
		await waitFor(() => expect(screen.queryByTestId("tour-spotlight")).toBeNull());
	});

	it("聚光灯目标在弹窗内 → 整个让位(modal 自带遮罩就是聚焦,套框被真机否掉)", async () => {
		const modal = document.createElement("div");
		modal.setAttribute("data-bn", "modal");
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		modal.appendChild(anchorEl);
		document.body.appendChild(modal);
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		// 给 rAF 解析留几拍 —— 让位是持续判定,不是初始态碰巧没渲染
		await new Promise((r) => setTimeout(r, 80));
		expect(screen.queryByTestId("tour-spotlight")).toBeNull();
		// 弹窗关掉(锚点随之消失)→ 无回落目标,仍无聚光灯;页面锚点补挂后回落
		modal.remove();
		const pageEl = document.createElement("div");
		pageEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(pageEl);
		await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
	});

	it("弹窗内的点击不影响页面锚点的退散状态", async () => {
		const pageEl = document.createElement("div");
		pageEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(pageEl);
		const modal = document.createElement("div");
		modal.setAttribute("data-bn", "modal");
		const inModalEl = document.createElement("div");
		modal.appendChild(inModalEl);
		document.body.appendChild(modal);
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
		fireEvent.pointerDown(inModalEl);
		await new Promise((r) => setTimeout(r, 50));
		expect(screen.getByTestId("tour-spotlight")).toBeTruthy();
	});

	it("退散过弹窗即复原:点按钮(退散)→ 弹窗让位 → 取消关掉 → 灯重新聚回按钮", async () => {
		const btn = document.createElement("div");
		btn.setAttribute("data-tour", "bili-login");
		document.body.appendChild(btn);
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
		fireEvent.pointerDown(btn);
		await waitFor(() => expect(screen.queryByTestId("tour-spotlight")).toBeNull());
		// 二维码弹窗出现:链解析到 qr(在 modal 内)→ 让位,同时清掉退散
		const modal = document.createElement("div");
		modal.setAttribute("data-bn", "modal");
		const qr = document.createElement("div");
		qr.setAttribute("data-tour", "bili-login-qr");
		modal.appendChild(qr);
		document.body.appendChild(modal);
		await new Promise((r) => setTimeout(r, 80));
		expect(screen.queryByTestId("tour-spotlight")).toBeNull();
		// 用户取消弹窗 → 回落按钮,灯要重新指路(真机踩过:取消后灯永远不回来)
		modal.remove();
		await waitFor(() =>
			expect(screen.getByTestId("tour-spotlight").getAttribute("data-target")).toBe(
				'[data-tour="bili-login"]',
			),
		);
	});

	it("不在目标路由:聚光灯改照顶栏对应页签(页内锚点在也不聚它)", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(anchorEl);
		mountNavAnchor("/system");
		await mount({ route: "/" });
		await screen.findByText("扫码登录 B 站");
		await waitFor(() =>
			expect(screen.getByTestId("tour-spotlight").getAttribute("data-target")).toBe(
				'[data-tour-nav="/system"]',
			),
		);
		// 页签是此刻唯一被指的操作 —— 引导锁照常铺
		expect(screen.getByTestId("tour-blocker")).toBeTruthy();
	});

	/**
	 * 页签是可以被主人藏起来的(`config/nav.ts` 只钉死了「系统」)。藏掉之后跨页
	 * 那一步的聚光灯选择器解析不到任何元素 —— 灯不亮、锁也不铺,而小卡还在说
	 * 「点亮起的页签前往」,指着一个根本不存在的东西。「带我去」按钮已在四轮定稿
	 * 里退役,于是导览彻底走不下去。这是那个死胡同的降级出口。
	 */
	it("目标页签被藏 → 小卡给回「带我去」,不再指一个不存在的页签", async () => {
		useNavStore.setState({ hidden: ["/targets"] });
		await mount({ loggedIn: true, route: "/" });
		await screen.findByText(/先选一条接入路线|接入路线/);
		expect(screen.queryByText(/点亮起的页签前往/)).toBeNull();
		const go = screen.getByRole("button", { name: "带我去" });
		expect(go).toBeTruthy();
	});

	it("页签没被藏时「带我去」照旧不出现 —— 降级出口只在真死胡同里露面", async () => {
		mountNavAnchor("/targets");
		await mount({ loggedIn: true, route: "/" });
		await screen.findByText(/先选一条接入路线|接入路线/);
		expect(screen.queryByRole("button", { name: "带我去" })).toBeNull();
		expect(screen.getByText(/点亮起的页签前往/)).toBeTruthy();
	});

	it("教程阅读区(/about)只亮灯指路、不锁 —— 点「选型指引」进来要能读", async () => {
		mountNavAnchor("/system");
		await mount({ route: "/about/guide" });
		await screen.findByText("扫码登录 B 站");
		await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
		expect(screen.queryByTestId("tour-blocker")).toBeNull();
	});

	it("adapter 主步 · 出发前(在系统页):说明步聚光目标页签,没有下一步", async () => {
		mountNavAnchor("/targets");
		await mount({ loggedIn: true, route: "/system" });
		expect(await screen.findByText("先选一条接入路线")).toBeTruthy();
		// 复杂讲解不塞小卡 —— 选型细节收进教程页,小卡只给跳转按钮
		expect(screen.getByRole("button", { name: "选型指引" })).toBeTruthy();
		// 说明步的流转方式就是点亮起的页签抵达,不给「下一步」按钮
		expect(screen.getByText(/点亮起的页签前往/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "下一步" })).toBeNull();
		await waitFor(() =>
			expect(screen.getByTestId("tour-spotlight").getAttribute("data-target")).toBe(
				'[data-tour-nav="/targets"]',
			),
		);
	});

	it("adapter 主步 · 抵达即流转:身在 /targets 时说明步直接翻过,灯与文案同步进动手子步", async () => {
		await mount({ loggedIn: true, route: "/targets" });
		expect(await screen.findByText("新建推送适配器")).toBeTruthy();
		expect(screen.queryByText("先选一条接入路线")).toBeNull();
		// 说明步被翻过也不丢选型入口 —— 动手子步上同样挂着「选型指引」
		expect(screen.getByRole("button", { name: "选型指引" })).toBeTruthy();
	});

	it("适配器已落库(未测通)→ 子步判据对齐:直接站在「测试适配器连通」,灯指测试按钮", async () => {
		const testBtn = document.createElement("div");
		testBtn.setAttribute("data-tour", "adapter-test");
		document.body.appendChild(testBtn);
		// 保存适配器后的下一拍轮询就是这个状态 —— 灯不许断档(真机踩过)
		await mount({ loggedIn: true, adapters: [{ id: "a1", enabled: true }], route: "/targets" });
		expect(await screen.findByText("测试适配器连通")).toBeTruthy();
		await waitFor(() =>
			expect(screen.getByTestId("tour-spotlight").getAttribute("data-target")).toBe(
				'[data-tour="adapter-test"]',
			),
		);
	});

	it("同名挂点多实例(左栏按钮+空态 CTA)是等价入口 —— 灯一起亮,一洞不落", async () => {
		const railBtn = document.createElement("div");
		railBtn.setAttribute("data-tour", "adapter-add");
		document.body.appendChild(railBtn);
		const cta = document.createElement("div");
		cta.setAttribute("data-tour", "adapter-add");
		document.body.appendChild(cta);
		await mount({ loggedIn: true, route: "/targets" });
		await screen.findByText("新建推送适配器");
		await waitFor(() => expect(screen.getAllByTestId("tour-spot-frame").length).toBe(2));
	});

	it("display:none 的同名实例不开洞 —— 响应式双形态的隐藏份曾在视口原点画出一枚粉弧", async () => {
		const visible = document.createElement("div");
		visible.setAttribute("data-tour", "adapter-add");
		document.body.appendChild(visible);
		const hiddenEl = document.createElement("div");
		hiddenEl.setAttribute("data-tour", "adapter-add");
		// 实例级覆盖模拟 display:none(无盒)
		(hiddenEl as unknown as { getClientRects: () => DOMRectList }).getClientRects = () =>
			[] as unknown as DOMRectList;
		document.body.appendChild(hiddenEl);
		await mount({ loggedIn: true, route: "/targets" });
		await screen.findByText("新建推送适配器");
		await waitFor(() => expect(screen.getAllByTestId("tour-spot-frame").length).toBe(1));
	});

	it("子步只向前翻页:永远没有「上一步」(单向流转定案)", async () => {
		await mount({ loggedIn: true, route: "/targets" });
		await screen.findByText("新建推送适配器");
		fireEvent.click(screen.getByRole("button", { name: "下一步" }));
		expect(await screen.findByText("测试适配器连通")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "上一步" })).toBeNull();
	});

	it("通道全通后收尾步是订阅:灯指页面级「添加」按钮(搜索框在弹窗里,弹窗没开指不了)", async () => {
		const addBtn = document.createElement("div");
		addBtn.setAttribute("data-tour", "subs-add");
		document.body.appendChild(addBtn);
		await mount({
			loggedIn: true,
			adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
			targets: [{ id: "t1", enabled: true, testStatus: { ok: true } }],
			route: "/subs",
		});
		expect(await screen.findByText("订阅第一个 UP")).toBeTruthy();
		await waitFor(() =>
			expect(screen.getByTestId("tour-spotlight").getAttribute("data-target")).toBe(
				'[data-tour="subs-add"]',
			),
		);
	});

	it("主步判据变绿的那一拍:操作位置弹完成徽章;全绿再加放毕业烟花", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(anchorEl);
		// 除登录外全绿 —— 登录一完成即毕业,徽章与烟花一次验俩
		await mount({
			subs: [{ id: "s1" }],
			adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
			targets: [{ id: "t1", enabled: true, testStatus: { ok: true } }],
			route: "/system",
		});
		await screen.findByText("扫码登录 B 站");
		expect(screen.queryByTestId("tour-done-badge")).toBeNull();
		act(() => {
			useAuthStore.setState({ snapshot: { status: BiliLoginStatus.LOGGED_IN, msg: "" } });
		});
		expect(await screen.findByText("B 站登录完成!")).toBeTruthy();
		await waitFor(() => expect(screen.getByTestId("tour-fireworks")).toBeTruthy());
		// 已完成的步在下一次挂载(如刷新)不再庆祝 —— 首拍只记录
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
		// 已经全绿的实例(含这个特性上线前就配完的老用户)照样补上标记 —— 它的作用
		// 只是「别再自动展开」,标签仍然常驻,进度也还挂在上面
		await waitFor(() =>
			expect(apiPatch).toHaveBeenCalledWith("/api/globals", { onboarding: { skipped: true } }),
		);
	});
});
