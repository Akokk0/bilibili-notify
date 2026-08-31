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
	/** globals 里那笔 `onboarding.skipped` —— `null` = 配置缺失(还没问过,该弹
	 *  询问框);不传 = false(已选「要指引」,绝大多数旧测试的语境)。 */
	skipped?: boolean | null;
	/** `/api/globals` 直接失败 —— 代理抖动 / 502 / auth 竞态。 */
	globalsError?: boolean;
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
		if (path === "/api/globals") {
			if (s.globalsError) throw new Error("globals 挂了");
			return { onboarding: s.skipped === null ? {} : { skipped: s.skipped === true } };
		}
		return null;
	});
	const { TourCompanion } = await import("../tour-companion");
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const utils = render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[s.route ?? "/"]}>
				<TourCompanion />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	// qc 带出去:测试中途改 Scenario 后手动 invalidate,不用干等 3s 判据轮询
	return { ...utils, qc };
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
	 * 三态 `onboarding.skipped`(2026-08-30 主人定案改版)。
	 *
	 * 缺失 = 还没问过 → 屏幕中间弹询问框(新用户开始指引 / 老用户跳过);
	 * false = 要指引 → 导览照常;true = 不要 → **整个导览不渲染**(标签也没有,
	 * 对「永久常驻」的修订),系统页可重开。判据认「按过测试」才算配好适配器,
	 * 存量老用户升级后会被判成没配完 —— 询问框就是他们的出口,选一次记一世。
	 */
	describe("三态询问框", () => {
		it("配置缺失 → 弹询问框,导览的标签与卡都不出现", async () => {
			await mount({ route: "/system", skipped: null });
			expect(await screen.findByText(/需要新手指引吗/)).toBeTruthy();
			expect(screen.queryByRole("button", { name: "展开新手导览" })).toBeNull();
			expect(document.querySelector('aside[aria-label="新手导览"]')).toBeNull();
			expect(screen.queryByTestId("tour-spotlight")).toBeNull();
		});

		it("选「我是新用户」→ 记下 false,询问框关,导览展开", async () => {
			const s: Scenario = { route: "/system", skipped: null };
			apiPatch.mockImplementation(async (_p: string, body?: unknown) => {
				s.skipped = (body as { onboarding: { skipped: boolean } }).onboarding.skipped;
				return {};
			});
			await mount(s);
			fireEvent.click(await screen.findByRole("button", { name: /我是新用户/ }));
			await waitFor(() =>
				expect(apiPatch).toHaveBeenCalledWith("/api/globals", { onboarding: { skipped: false } }),
			);
			await screen.findByText("扫码登录 B 站");
			expect(screen.queryByText(/需要新手指引吗/)).toBeNull();
		});

		it("选「我是老用户」→ 记下 true,提示系统页可重开,确认后什么都不渲染", async () => {
			const s: Scenario = { route: "/system", skipped: null };
			apiPatch.mockImplementation(async (_p: string, body?: unknown) => {
				s.skipped = (body as { onboarding: { skipped: boolean } }).onboarding.skipped;
				return {};
			});
			await mount(s);
			fireEvent.click(await screen.findByRole("button", { name: /我是老用户/ }));
			await waitFor(() =>
				expect(apiPatch).toHaveBeenCalledWith("/api/globals", { onboarding: { skipped: true } }),
			);
			// 教育提示:以后去系统页重开
			expect(await screen.findByText(/系统/)).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: "知道了" }));
			await waitFor(() =>
				expect(document.querySelector('aside[aria-label="新手导览"]')).toBeNull(),
			);
			expect(screen.queryByRole("button", { name: "展开新手导览" })).toBeNull();
		});

		it("已选跳过(true)→ 整个导览不渲染,也不再弹询问框", async () => {
			await mount({ route: "/system", skipped: true });
			// 让数据链路完全落定后再断言「什么都没有」
			await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/globals"));
			await new Promise((r) => setTimeout(r, 50));
			expect(document.querySelector('aside[aria-label="新手导览"]')).toBeNull();
			expect(screen.queryByRole("button", { name: "展开新手导览" })).toBeNull();
			expect(screen.queryByText(/需要新手指引吗/)).toBeNull();
			expect(apiPatch).not.toHaveBeenCalled();
		});

		/**
		 * TourCompanion 是在 App 里无条件挂载的,判据 query 却开在任何 choice 判断之前 ——
		 * 已经关掉导览的人整棵树 render null,四条请求却照发,而且是**每开一个页面**都发
		 * 一遍(在 /logs、/cards 上连订阅全表都白拉)(2026-08-31 审查)。
		 */
		it("已选跳过(true)→ 判据 query 一条都不发(整棵树都不渲染,问了纯浪费)", async () => {
			await mount({ route: "/system", skipped: true });
			await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/globals"));
			await new Promise((r) => setTimeout(r, 50));
			for (const path of ["/api/subs", "/api/adapters", "/api/targets", "/api/health"]) {
				expect(apiGet, `${path} 不该被问`).not.toHaveBeenCalledWith(path);
			}
		});

		/**
		 * 三态是**配置读出来的**,不是「data 有没有值」读出来的。`/api/globals` 失败时
		 * data 同样是 undefined,而 undefined 在三态里就是「还没问过」—— 一次 502
		 * 就能把已经选过「我是老用户,跳过」的人重新问一遍,而且他按哪个键都会当场
		 * 覆写自己的配置(2026-08-31 审查)。失败 = 不知道,那就一个字都别说。
		 */
		it("globals 请求失败 → 不弹询问框(拿不到答案 ≠ 还没问过)", async () => {
			await mount({ route: "/system", globalsError: true });
			await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/globals"));
			await new Promise((r) => setTimeout(r, 50));
			expect(screen.queryByText(/需要新手指引吗/)).toBeNull();
			expect(document.querySelector('aside[aria-label="新手导览"]')).toBeNull();
			// 最要命的那半:问了就会写。一个字都没问,自然一笔都没写。
			expect(apiPatch).not.toHaveBeenCalled();
		});

		it("点「跳过指引」→ 记下 true,导览整个消失", async () => {
			const s: Scenario = { route: "/system" };
			apiPatch.mockImplementation(async (_p: string, body?: unknown) => {
				s.skipped = (body as { onboarding: { skipped: boolean } }).onboarding.skipped;
				return {};
			});
			await mount(s);
			await screen.findByText("扫码登录 B 站");
			fireEvent.click(screen.getByRole("button", { name: "跳过指引" }));
			await waitFor(() =>
				expect(apiPatch).toHaveBeenCalledWith("/api/globals", { onboarding: { skipped: true } }),
			);
			await waitFor(() =>
				expect(document.querySelector('aside[aria-label="新手导览"]')).toBeNull(),
			);
			expect(screen.queryByRole("button", { name: "展开新手导览" })).toBeNull();
		});

		it("走完五步毕业 → 自动记下 true,🎉 卡演完点「收起」才消失", async () => {
			const s: Scenario = {
				subs: [{ id: "s1" }],
				adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
				targets: [{ id: "t1", enabled: true, testStatus: { ok: true } }],
				route: "/system",
			};
			apiPatch.mockImplementation(async (_p: string, body?: unknown) => {
				s.skipped = (body as { onboarding: { skipped: boolean } }).onboarding.skipped;
				return {};
			});
			await mount(s);
			await screen.findByText("扫码登录 B 站");
			expect(apiPatch).not.toHaveBeenCalled();
			act(() => {
				useAuthStore.setState({ snapshot: { status: BiliLoginStatus.LOGGED_IN, msg: "" } });
			});
			await waitFor(() =>
				expect(apiPatch).toHaveBeenCalledWith("/api/globals", { onboarding: { skipped: true } }),
			);
			// 标记已写、数据已回流,🎉 卡还得站着 —— 别把毕业庆祝掐没
			expect(await screen.findByText(/全部配置完成/)).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: "收起" }));
			await waitFor(() =>
				expect(document.querySelector('aside[aria-label="新手导览"]')).toBeNull(),
			);
		});

		/**
		 * 毕业写标记那一拍有个 ref 闸(markedRef)挡重入 —— 它一旦落下就再没抬起来过。
		 * 于是「已经毕业的人在系统页点重新开启」这条路上:choice 回到 false、判据仍然
		 * 全绿 → 渲染 🎉 卡,但自动写标记被闸挡住,而卡上唯一那颗「收起」只会
		 * `setJustGraduated(false)` —— choice===false 时这个值根本不参与渲染判断。
		 * 结果是一张关不掉的贺卡,除非去点「跳过指引」或刷新(2026-08-31 审查)。
		 */
		it("同一会话里毕业过、再重新开启指引:🎉 卡的「收起」照样谢幕,不是一颗死钮", async () => {
			const s: Scenario = {
				subs: [{ id: "s1" }],
				adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
				targets: [{ id: "t1", enabled: true, testStatus: { ok: true } }],
				route: "/system",
			};
			apiPatch.mockImplementation(async (_p: string, body?: unknown) => {
				s.skipped = (body as { onboarding: { skipped: boolean } }).onboarding.skipped;
				return {};
			});
			const { qc } = await mount(s);
			await screen.findByText("扫码登录 B 站");
			// ① 本会话内走完最后一步 → 自动写标记(ref 闸在这一拍落下),🎉 卡谢幕
			act(() => {
				useAuthStore.setState({ snapshot: { status: BiliLoginStatus.LOGGED_IN, msg: "" } });
			});
			await screen.findByText(/全部配置完成/);
			fireEvent.click(screen.getByRole("button", { name: "收起" }));
			await waitFor(() =>
				expect(document.querySelector('aside[aria-label="新手导览"]')).toBeNull(),
			);
			// ② 系统页「重新开启」= 写回 false + 发信号(两半各走各的通道)
			s.skipped = false;
			const { useOnboardingReopen } = await import("../../../store/onboarding");
			await act(async () => {
				useOnboardingReopen.getState().reopen();
				await qc.invalidateQueries({ queryKey: ["globals"] });
			});
			expect(await screen.findByText(/全部配置完成/)).toBeTruthy();
			// ③ 落下的闸不许把这颗按钮变成摆设
			fireEvent.click(screen.getByRole("button", { name: "收起" }));
			await waitFor(() =>
				expect(document.querySelector('aside[aria-label="新手导览"]')).toBeNull(),
			);
		});

		it("系统页「重新开启」信号 → 收着的导览重新展开", async () => {
			localStorage.setItem("bn-tour-collapsed", "1");
			await mount({ route: "/system" });
			const tab = await screen.findByRole("button", { name: "展开新手导览" });
			expect(tab.getAttribute("data-shown")).toBe("true");
			const { useOnboardingReopen } = await import("../../../store/onboarding");
			act(() => {
				useOnboardingReopen.getState().reopen();
			});
			await waitFor(() =>
				expect(
					document.querySelector('aside[aria-label="新手导览"]')?.getAttribute("data-shown"),
				).toBe("true"),
			);
		});
	});

	/**
	 * 聚光灯静止后会降频(每帧全文档查询 + getBoundingClientRect 是强制同步重排,
	 * 导览常常整段停着,停着还逐帧重排等于让图表页/长列表白白陪跑)。降频只准影响
	 * **多久测一次**,不准让洞跟丢 —— 有些位移不发任何事件(脚本直接改样式),低频
	 * 巡查是那种情况唯一的兜底。
	 */
	it("降频之后洞照样跟着目标走 —— 没有任何事件也要跟上", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		anchorEl.getBoundingClientRect = () => new DOMRect(10, 10, 40, 20);
		document.body.appendChild(anchorEl);
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		await waitFor(() =>
			expect(screen.getByTestId("tour-spot-frame").getAttribute("x")).toBe(String(10 - 6)),
		);
		// 静止够久 → 进低频(要熬过 STABLE_FRAMES_TO_IDLE 帧,别缩这个等待:等不够
		// 就还在逐帧路径上,这条测试会变成空跑的假绿)
		await new Promise((r) => setTimeout(r, 800));
		anchorEl.getBoundingClientRect = () => new DOMRect(200, 120, 40, 20);
		await waitFor(
			() => expect(screen.getByTestId("tour-spot-frame").getAttribute("x")).toBe(String(200 - 6)),
			{ timeout: 3000 },
		);
	});

	/**
	 * `animationend` 会冒泡。徽章里那颗玻璃胶囊是皮肤的常见挂钩(styles.css 自带
	 * bn-anim-aura 之类会落在玻璃面上),子元素的动画一结束就冒到 portal 根上,
	 * 把整块徽章提前卸掉 —— 2.2 秒的提示变成一闪而过。
	 *
	 * 事件名用带前缀的那个:React 靠 `style.animation` 在不在来挑事件名,jsdom 的
	 * CSSStyleDeclaration 没有它,于是 React 实际监听的是 `webkitAnimationEnd`,
	 * `fireEvent.animationEnd` 派发的标准名压根进不了处理器(空跑的假测试)。
	 */
	it("完成徽章只认自己那段动画结束 —— 子元素冒泡上来的不算", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		document.body.appendChild(anchorEl);
		await mount({
			subs: [{ id: "s1" }],
			adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
			targets: [{ id: "t1", enabled: true, testStatus: { ok: true } }],
			route: "/system",
		});
		await screen.findByText("扫码登录 B 站");
		act(() => {
			useAuthStore.setState({ snapshot: { status: BiliLoginStatus.LOGGED_IN, msg: "" } });
		});
		const badge = await screen.findByTestId("tour-done-badge");
		const endAnimation = (el: Element) =>
			act(() => {
				el.dispatchEvent(new Event("webkitAnimationEnd", { bubbles: true }));
			});
		endAnimation(badge.firstElementChild as HTMLElement);
		expect(screen.queryByTestId("tour-done-badge")).toBeTruthy();
		endAnimation(badge);
		await waitFor(() => expect(screen.queryByTestId("tour-done-badge")).toBeNull());
	});

	/**
	 * 兄弟件 Fireworks 早就认 `prefers-reduced-motion`,而这枚徽章的 2.2 秒
	 * 缩放+上飘 keyframes 一直无条件跑(styles.css 那几段 reduced-motion 只盖了
	 * 小卡/标签、流光和玻璃抬升)—— 每完成一步就在减动效用户脸上弹一次。
	 * 两件的口径故意不同:烟花纯装饰可整场跳过,徽章带着「刚才那步成了」这条
	 * 信息,只去掉演出(2026-08-31 审查)。
	 */
	describe("完成徽章的减动效档", () => {
		async function graduate() {
			const anchorEl = document.createElement("div");
			anchorEl.setAttribute("data-tour", "bili-login");
			document.body.appendChild(anchorEl);
			await mount({
				subs: [{ id: "s1" }],
				adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
				targets: [{ id: "t1", enabled: true, testStatus: { ok: true } }],
				route: "/system",
			});
			await screen.findByText("扫码登录 B 站");
			act(() => {
				useAuthStore.setState({ snapshot: { status: BiliLoginStatus.LOGGED_IN, msg: "" } });
			});
			return screen.findByTestId("tour-done-badge");
		}

		it("开了减动效 → 挂静态档,不跑那段缩放上飘,并靠计时自卸", async () => {
			// jsdom 这套没实现 matchMedia(所以实现里写的是 `window.matchMedia?.(…)`),
			// spyOn 无从下手 —— 直接装一个进去,用完拆掉
			Object.defineProperty(window, "matchMedia", {
				configurable: true,
				value: (q: string) => ({ matches: q.includes("reduce"), media: q }),
			});
			try {
				const badge = await graduate();
				expect(badge.classList.contains("bn-tour-done-static")).toBe(true);
				expect(badge.classList.contains("bn-tour-done")).toBe(false);
				// 静态档没有动画,animationend 一次都不会来 —— 卸载只能靠计时
				await waitFor(() => expect(screen.queryByTestId("tour-done-badge")).toBeNull(), {
					timeout: 3000,
				});
			} finally {
				Reflect.deleteProperty(window, "matchMedia");
			}
		});

		it("常规档也有兜底自卸 —— 动画事件一次没来也不会永远挂在页面上", async () => {
			const badge = await graduate();
			expect(badge.classList.contains("bn-tour-done")).toBe(true);
			await waitFor(() => expect(screen.queryByTestId("tour-done-badge")).toBeNull(), {
				timeout: 4000,
			});
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

	/**
	 * 拦截块是「视口减洞集」的补集,视口尺寸必须**跟着测**。曾经只在渲染时读
	 * `window.innerWidth/innerHeight`,而重渲染只由锚点 rect 的变化驱动 ——
	 * 锚在顶栏页签(矩形与窗口尺寸无关)时把窗口拖大,rect 纹丝不动 → 不重渲染 →
	 * 挡板还是旧尺寸。新露出来的那条边被暗幕(width=100%)涂黑了、却点得动:
	 * 看着锁着,其实是开的(2026-08-31 审查)。
	 */
	it("窗口变大 → 引导锁跟着铺满新视口(锚点纹丝不动也要重算)", async () => {
		const original = window.innerWidth;
		try {
			const anchorEl = document.createElement("div");
			anchorEl.setAttribute("data-tour", "bili-login");
			anchorEl.getBoundingClientRect = () => new DOMRect(100, 60, 80, 40);
			document.body.appendChild(anchorEl);
			await mount({ route: "/system" });
			await screen.findByText("扫码登录 B 站");
			const rightEdge = () => {
				const blocks = [...screen.getByTestId("tour-blocker").children] as HTMLElement[];
				return Math.max(
					...blocks.map((b) => Number.parseFloat(b.style.left) + Number.parseFloat(b.style.width)),
				);
			};
			await waitFor(() => expect(rightEdge()).toBe(original));
			const wider = original + 400;
			act(() => {
				Object.defineProperty(window, "innerWidth", { value: wider, configurable: true });
				window.dispatchEvent(new Event("resize"));
			});
			await waitFor(() => expect(rightEdge()).toBe(wider));
		} finally {
			Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
		}
	});

	/**
	 * 滚动是**刻意不拦**的(拦截块只吃指针操作),而首次滚入视口按 selector 只做一次
	 * (lastScrolledRef)。于是用户自己往下翻页时,洞跟着目标滑出视口 → subtractRects
	 * 把它夹没 → 整个视口成了一整块拦截层,而没有任何东西会把目标滚回来。除了小卡
	 * 「收起」,页面上每一次点击都被吃掉(2026-08-31 审查)。
	 *
	 * 不变式:**视口里一个洞都看不见时,灯与锁一起不铺**。用户滚回去灯自己就回来
	 * (rAF 一直在测),不用跟他抢滚动条。
	 */
	it("目标滚出视口 → 灯与引导锁一起收起,别把人锁在一块没有出口的暗幕里", async () => {
		const anchorEl = document.createElement("div");
		anchorEl.setAttribute("data-tour", "bili-login");
		anchorEl.getBoundingClientRect = () => new DOMRect(100, 60, 80, 40);
		document.body.appendChild(anchorEl);
		await mount({ route: "/system" });
		await screen.findByText("扫码登录 B 站");
		await waitFor(() => expect(screen.getByTestId("tour-blocker")).toBeTruthy());
		// 用户往下翻了一大截,目标整个跑到视口上方
		anchorEl.getBoundingClientRect = () => new DOMRect(100, -500, 80, 40);
		await waitFor(() => expect(screen.queryByTestId("tour-blocker")).toBeNull());
		expect(screen.queryByTestId("tour-spotlight")).toBeNull();
		// 滚回去灯自己回来
		anchorEl.getBoundingClientRect = () => new DOMRect(100, 60, 80, 40);
		await waitFor(() => expect(screen.getByTestId("tour-blocker")).toBeTruthy());
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

	/**
	 * 子步层的判据回退(2026-08-30 真机反馈)。主步 activeKey 的前进回退早有
	 * (reconcileTourPos),但子步曾只进不退:删掉适配器后 activeKey 仍是 adapter,
	 * 手动位停在「测试连通」—— 聚光灯靠链回落指对了「+ 新建」,小卡文案却还在讲
	 * 测试。规则:只盯**从真变假的转变沿** —— 当前位之前有带 doneWhen 的子步判据
	 * 被破坏 → 退回那一子步。「为假就退」会把手动「下一步」的提前预读当场按回去
	 * (下一条「子步只向前翻页」测试钉着那半);纯说明步无 doneWhen,不做回退目标。
	 */
	it("子步判据回退:删掉适配器 → 小卡从「测试连通」退回「新建」", async () => {
		const s: Scenario = {
			loggedIn: true,
			adapters: [{ id: "a1", enabled: true }],
			route: "/targets",
		};
		const { qc } = await mount(s);
		// hasAdapter=true → 「新建」子步的 doneWhen 已满足,自动翻到「测试连通」
		await screen.findByText("测试适配器连通");
		s.adapters = [];
		await act(async () => {
			await qc.invalidateQueries({ queryKey: ["adapters"] });
		});
		await screen.findByText("新建推送适配器");
	});

	/**
	 * 测试失败兜底(2026-08-30 真机反馈)。成功会推进子步、换链重置聚光灯;失败
	 * 既不开弹窗也不换链 —— 按下退散的灯永远回不来,报错只在页面 toast 闪 2 秒,
	 * 导览死在原地还不讲原因。三件套:卡上讲原因、锁不放开但该做的都在洞内、灯重亮。
	 */
	describe("测试失败兜底", () => {
		const failScenario = (at: string): Scenario => ({
			loggedIn: true,
			adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
			targets: [
				{ id: "t1", enabled: true, testStatus: { ok: false, err: "发送超时", lastCheckedAt: at } },
			],
			route: "/targets",
		});

		it("test 步失败 → 小卡显示失败原因与重试指点", async () => {
			await mount(failScenario("t1"));
			await screen.findByText("发送测试推送");
			const note = await screen.findByRole("alert");
			expect(note.textContent).toContain("发送超时");
			expect(note.textContent).toContain("测试");
		});

		it("失败悬着时「配置」与「测试」同亮 —— 改配置或(外部原因修好后)直接重测都在洞内", async () => {
			const cfg = document.createElement("div");
			cfg.setAttribute("data-tour", "target-config");
			cfg.getBoundingClientRect = () => new DOMRect(300, 40, 50, 20);
			document.body.appendChild(cfg);
			const test = document.createElement("div");
			test.setAttribute("data-tour", "target-test");
			test.getBoundingClientRect = () => new DOMRect(100, 40, 50, 20);
			document.body.appendChild(test);
			await mount(failScenario("t1"));
			await waitFor(() => {
				const xs = screen.getAllByTestId("tour-spot-frame").map((f) => f.getAttribute("x"));
				expect(xs.toSorted()).toEqual([String(100 - 6), String(300 - 6)].toSorted());
			});
		});

		it("失败悬着时引导锁照锁 —— 该做的两个动作都在洞内,洞外照旧拦住", async () => {
			const cfg = document.createElement("div");
			cfg.setAttribute("data-tour", "target-config");
			document.body.appendChild(cfg);
			const test = document.createElement("div");
			test.setAttribute("data-tour", "target-test");
			document.body.appendChild(test);
			await mount(failScenario("t1"));
			await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
			expect(screen.getByTestId("tour-blocker")).toBeTruthy();
		});

		it("点「配置」进弹窗再取消 → 灯回来(过弹窗即复原,失败链也得带表单锚点)", async () => {
			const cfg = document.createElement("div");
			cfg.setAttribute("data-tour", "target-config");
			document.body.appendChild(cfg);
			await mount(failScenario("t1"));
			await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
			// 点「配置」:按下即退散
			fireEvent.pointerDown(cfg);
			await waitFor(() => expect(screen.queryByTestId("tour-spotlight")).toBeNull());
			// 配置弹窗开了(表单挂点在弹窗里)—— 链解析进 modal,退散该被清零
			const modal = document.createElement("div");
			modal.setAttribute("data-bn", "modal");
			const form = document.createElement("div");
			form.setAttribute("data-tour", "target-form");
			modal.appendChild(form);
			document.body.appendChild(modal);
			await new Promise((r) => setTimeout(r, 80));
			// 点「取消」关弹窗 → 灯要落回页面上的「配置」,不能就此失踪
			modal.remove();
			await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
		});

		it("按下退散后再次失败(同因不同时间戳)→ 灯重新点亮", async () => {
			const anchorEl = document.createElement("div");
			anchorEl.setAttribute("data-tour", "target-test");
			document.body.appendChild(anchorEl);
			const s = failScenario("t1");
			const { qc } = await mount(s);
			await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
			fireEvent.pointerDown(anchorEl);
			await waitFor(() => expect(screen.queryByTestId("tour-spotlight")).toBeNull());
			s.targets = [
				{
					id: "t1",
					enabled: true,
					testStatus: { ok: false, err: "发送超时", lastCheckedAt: "t2" },
				},
			];
			await act(async () => {
				await qc.invalidateQueries({ queryKey: ["targets"] });
			});
			await waitFor(() => expect(screen.getByTestId("tour-spotlight")).toBeTruthy());
		});
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

	/**
	 * 教程阅读区(/about)三易其稿(2026-08-30 主人定案):亮灯带锁 → 亮灯不锁
	 * (暗幕压得没法读)→ 只留描边呼吸框(还是打扰)→ **聚光灯整个不渲染**,
	 * 回去的路挪到小卡上:「选型指引」在阅读区让位给「回去继续」(跳回该步路由)。
	 */
	it("教程阅读区(/about):聚光灯整个不渲染,「回去继续」跳回原步", async () => {
		mountNavAnchor("/system");
		await mount({ route: "/about/guide" });
		await screen.findByText("扫码登录 B 站");
		// 给 rAF 解析留几拍 —— 不渲染是持续判定,不是初始态碰巧没画
		await new Promise((r) => setTimeout(r, 80));
		expect(screen.queryByTestId("tour-spotlight")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "回去继续" }));
		// 跳回 /system(login 步的路由)→ 不在阅读区了,按钮退场
		await waitFor(() => expect(screen.queryByRole("button", { name: "回去继续" })).toBeNull());
	});

	it("阅读区里「选型指引」让位给「回去继续」—— 人已经在教程里,再指过来没意义", async () => {
		await mount({ loggedIn: true, route: "/about/guide" });
		await screen.findByText("先选一条接入路线");
		expect(screen.queryByRole("button", { name: "选型指引" })).toBeNull();
		expect(screen.getByRole("button", { name: "回去继续" })).toBeTruthy();
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
		// 两处入口给真实的、相离的矩形 —— jsdom 默认 0×0 会让两洞完全重合,
		// 被「相交洞合并」(mergeIntersecting)并成一个,测的就不再是多实例了
		const railBtn = document.createElement("div");
		railBtn.setAttribute("data-tour", "adapter-add");
		railBtn.getBoundingClientRect = () => new DOMRect(20, 100, 80, 24);
		document.body.appendChild(railBtn);
		const cta = document.createElement("div");
		cta.setAttribute("data-tour", "adapter-add");
		cta.getBoundingClientRect = () => new DOMRect(400, 300, 120, 60);
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

	/**
	 * 选中的适配器是 webhook 时,`target-add` **一处都不渲染** —— 右上「+ 新建推送
	 * 目标」被 platform 判断掐掉,空态 AddCard 走的是另一条分支。链只有
	 * `["target-form", "target-add"]` 的话解析不到任何元素:灯不亮、锁不铺,小卡却
	 * 还在说「点高亮的『+ 新建』」;而人已经在 /targets 上,连「点亮起的页签前往」
	 * 那条降级提示都被抑制,导览彻底死在这儿(2026-08-31 审查)。
	 */
	it("target 步:「+ 新建」这个挂点整个不存在(webhook)时,灯回落到目标区,不留死胡同", async () => {
		const list = document.createElement("div");
		list.setAttribute("data-tour", "target-list");
		document.body.appendChild(list);
		await mount({
			loggedIn: true,
			adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
			targets: [{ id: "t1", enabled: false }],
			route: "/targets",
		});
		await screen.findByText("添加推送目标");
		await waitFor(() =>
			expect(screen.getByTestId("tour-spotlight").getAttribute("data-target")).toBe(
				'[data-tour="target-list"]',
			),
		);
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

	it("引导中全绿:🎉 卡列未开启尾巴,自动写 true,点「收起」谢幕", async () => {
		const s: Scenario = {
			loggedIn: true,
			subs: [{ id: "s1" }],
			adapters: [{ id: "a1", enabled: true, testStatus: { ok: true } }],
			targets: [{ id: "t1", enabled: true, testStatus: { ok: true } }],
		};
		apiPatch.mockImplementation(async (_p: string, body?: unknown) => {
			s.skipped = (body as { onboarding: { skipped: boolean } }).onboarding.skipped;
			return {};
		});
		await mount(s);
		expect(await screen.findByText(/全部配置完成/)).toBeTruthy();
		// 尾巴链接指向关于页里的教程章节(五轮定稿:/guide 独立路由已撤)
		const tail = screen.getByRole("link", { name: /图片渲染/ });
		expect(tail.getAttribute("href")).toBe("/about/guide/render");
		// 毕业自动关导览(三态语义:true = 整个不渲染),🎉 卡靠活口站到收起为止
		await waitFor(() =>
			expect(apiPatch).toHaveBeenCalledWith("/api/globals", { onboarding: { skipped: true } }),
		);
		fireEvent.click(screen.getByRole("button", { name: "收起" }));
		await waitFor(() => expect(document.querySelector('aside[aria-label="新手导览"]')).toBeNull());
		expect(screen.queryByRole("button", { name: "展开新手导览" })).toBeNull();
	});
	describe("判据轮询的启停", () => {
		/** `/api/subs` 被问了几次 —— 轮询每轮会 invalidate 它。 */
		const subsCalls = () => apiGet.mock.calls.filter(([p]) => p === "/api/subs").length;
		const healthCalls = () => apiGet.mock.calls.filter(([p]) => p === "/api/health").length;

		/**
		 * health 带的 `modules` 快照喂着毕业卡上的「锦上添花」两条尾巴(图片渲染 / AI)。
		 * 它曾不在失效名单里 —— 靠 HEALTH_QUERY_OPTIONS 自带的 5s refetchInterval 兜着,
		 * 那边一改选项这里就静静地退回不刷新(2026-08-31 审查)。3.5s 内 5s 那条还没到,
		 * 所以这条计数只可能来自轮询自己。
		 */
		it("轮询把 health 也带上 —— 尾巴的开关状态只从它来", async () => {
			vi.useFakeTimers();
			try {
				await mount({ route: "/system" });
				await vi.advanceTimersByTimeAsync(0);
				const before = healthCalls();
				await vi.advanceTimersByTimeAsync(3_500);
				expect(healthCalls()).toBeGreaterThan(before);
			} finally {
				vi.useRealTimers();
			}
		});

		it("小卡展开着 → 每 3s 复查一轮判据(页面外动作没有前端事件,只能靠问)", async () => {
			vi.useFakeTimers();
			try {
				await mount({ route: "/system" });
				await vi.advanceTimersByTimeAsync(0);
				const before = subsCalls();
				await vi.advanceTimersByTimeAsync(3_500);
				expect(subsCalls()).toBeGreaterThan(before);
			} finally {
				vi.useRealTimers();
			}
		});

		it("导览已关闭(skipped=true)→ 不轮询", async () => {
			vi.useFakeTimers();
			try {
				await mount({ route: "/system", skipped: true });
				await vi.advanceTimersByTimeAsync(0);
				const before = subsCalls();
				await vi.advanceTimersByTimeAsync(10_000);
				// 这是全站唯一一处长期定时请求,不关就是 4 条 query × 20 次/分钟
				// 一路跑到标签页关掉
				expect(subsCalls()).toBe(before);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
