// @vitest-environment jsdom
/**
 * 单元测试 —— Markdown chunk 的预热时机。
 *
 * 那个 chunk 约 153KB,懒加载出去之后就有了「什么时候把它取回来」的问题。
 *
 * 一开始只在胶囊 hover 时取,结果主人一点进聊天页就看见纯文本闪成排版好的 ——
 * hover 那点提前量根本不够,dev 服务器下尤其明显(那儿不是取一个打好包的 chunk,
 * 而是让 Vite 现场解析 react-markdown 整条依赖图,几十个模块逐个请求)。
 *
 * 所以策略改成**首屏空闲时就预取**。要守住的是首屏的**解析与执行**不变重 ——
 * 那才是卡交互的部分,不是那点带宽。空闲回调排在首次绘制之后,两头都占得住:
 * 关键路径干净,而主人真点进去时它早就在了。
 *
 * hover / 聚焦 / 按下仍然立刻取,不等空闲 —— 覆盖「页面刚加载完就直奔胶囊」那种。
 *
 * **但预取并不是那下闪的解**。改成空闲预取之后主人还是在「打开新会话」时看见了
 * 同样的闪 —— 真正的原因是 `React.lazy` 自己会先提交一帧 fallback,跟 chunk 在不在
 * 缓存里无关。那件事由 markdown-first-paint.test.tsx 盯着。预取管的只是「别等到
 * 用的时候才下载」,两回事,别把这个文件当成闪的防线。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const P = vi.hoisted(() => ({ preload: vi.fn() }));

// 只替换预热这一个导出,MessageList 等保持真实 —— 这里验的是「谁在什么时候调它」,
// 不是渲染。
vi.mock("../messages", async (orig) => ({
	...(await orig()),
	preloadChatMarkdown: P.preload,
}));

vi.mock("../../../services/aiChat", async (orig) => ({
	...(await orig()),
	listConversations: vi.fn(async () => ({ conversations: [] })),
	getConversation: vi.fn(async () => ({
		id: "c1",
		title: "t",
		createdAt: "2026-07-24T00:00:00.000Z",
		updatedAt: "2026-07-24T00:00:00.000Z",
		messageCount: 0,
		messages: [],
	})),
}));

vi.mock("../../../services/api", () => ({
	api: {
		get: vi.fn(async () => ({
			defaults: { ai: { model: "m", persona: { name: "小绫" } } },
		})),
	},
}));

import { useAiChatStore } from "../../../store/aiChat";
import { AiChatDock } from "../index";

function wrap(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
	vi.useFakeTimers();
	P.preload.mockClear();
	useAiChatStore.setState({ open: false, rail: true, activeId: null });
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const fab = () => screen.getByTitle("打开女仆 AI 聊天");
/** 放行空闲回调(jsdom 没有 requestIdleCallback,实现会退回定时器)。 */
const runIdle = () => act(() => vi.runAllTimers());

describe("Markdown chunk 的预热时机", () => {
	it("挂载的那一刻**不**取 —— 不跟首屏渲染抢解析与执行", () => {
		// 要守的是关键路径,不是带宽:同步地跟着首屏一起加载才是真的白拆。
		render(wrap(<AiChatDock />));
		expect(P.preload).not.toHaveBeenCalled();
	});

	it("首屏空闲下来就去取 —— 主人真点进去时它早就在了", () => {
		render(wrap(<AiChatDock />));
		runIdle();
		expect(P.preload).toHaveBeenCalled();
	});

	it("鼠标挪到胶囊上立刻取,不等空闲 —— 覆盖「刚加载完就直奔胶囊」", () => {
		render(wrap(<AiChatDock />));
		fireEvent.pointerEnter(fab());
		expect(P.preload).toHaveBeenCalled();
	});

	it("键盘聚焦到胶囊同样开始取 —— 不能只照顾鼠标", () => {
		render(wrap(<AiChatDock />));
		fireEvent.focus(fab());
		expect(P.preload).toHaveBeenCalled();
	});

	it("碰一下胶囊(触屏没有 hover)也开始取", () => {
		render(wrap(<AiChatDock />));
		fireEvent.pointerDown(fab());
		expect(P.preload).toHaveBeenCalled();
	});

	it("预热不会顺手把聊天打开 —— 挪过去而已,别弹一整页", () => {
		render(wrap(<AiChatDock />));
		fireEvent.pointerEnter(fab());
		fireEvent.focus(fab());
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(useAiChatStore.getState().open).toBe(false);
	});

	it("直接点开(没经过 hover)也还有一道兜底 —— 面板挂载时再取一次", () => {
		render(wrap(<AiChatDock />));
		act(() => {
			fireEvent.click(fab());
		});
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(P.preload).toHaveBeenCalled();
	});

	it("离开页面时把没跑的空闲回调撤掉 —— 不留一个指着已卸载组件的定时器", () => {
		const { unmount } = render(wrap(<AiChatDock />));
		unmount();
		runIdle();
		expect(P.preload).not.toHaveBeenCalled();
	});
});

/**
 * 上面那一组跑的是**退化分支** —— jsdom 没有 `requestIdleCallback`(实测:真假计时器
 * 下都是 undefined),所以实现落在 setTimeout 那条路上。
 *
 * 而浏览器里走的是 rIC 那条,它一行都没被执行过。所以这里把 API 补上再跑一遍同样的
 * 断言:否则「浏览器里到底预取了没、卸载时撤了没」是完全没有覆盖的,而那正是主人
 * 实际用到的那条路。
 */
describe("Markdown chunk 的预热时机 — 有 requestIdleCallback 的浏览器", () => {
	let scheduled: Array<{ fn: () => void; cancelled: boolean }>;

	beforeEach(() => {
		// 这一组不需要假计时器(空闲回调由 flushIdle 手动放行),而外层装的假计时器
		// 会接管 / 锁住这两个全局,让 stubGlobal 打不进去。先撤掉。
		vi.useRealTimers();
		scheduled = [];
		vi.stubGlobal("requestIdleCallback", (fn: () => void) => {
			scheduled.push({ fn, cancelled: false });
			return scheduled.length; // 句柄从 1 起,0 是个容易误判的假值
		});
		vi.stubGlobal("cancelIdleCallback", (id: number) => {
			const slot = scheduled[id - 1];
			if (slot) slot.cancelled = true;
		});
	});
	afterEach(() => {
		// **先卸载,再撤桩。**反过来的话:桩一撤,cancelIdleCallback 就没了,而紧接着
		// 卸载组件时 onIdle 的清理函数正要调它 → ReferenceError。真实浏览器里这两个
		// API 总是成对出现,所以那是测试自己造出来的不可能状态,不是实现的毛病。
		cleanup();
		vi.unstubAllGlobals();
	});

	/** 放行所有没被撤销的空闲回调。 */
	const flushIdle = () =>
		act(() => {
			for (const s of scheduled) if (!s.cancelled) s.fn();
		});

	it("走的确实是 rIC 那条,不是定时器", () => {
		render(wrap(<AiChatDock />));
		expect(scheduled).toHaveLength(1);
	});

	it("排上的空闲回调跑起来就预取", () => {
		render(wrap(<AiChatDock />));
		expect(P.preload).not.toHaveBeenCalled();
		flushIdle();
		expect(P.preload).toHaveBeenCalled();
	});

	it("卸载时用 cancelIdleCallback 撤掉", () => {
		const { unmount } = render(wrap(<AiChatDock />));
		unmount();
		expect(scheduled[0]?.cancelled).toBe(true);
		flushIdle();
		expect(P.preload).not.toHaveBeenCalled();
	});

	it("带上 timeout —— 页面一直忙也不能永远排不上", () => {
		// 显式标注两个参数:不标的话 vi.fn 推出空参元组,读 calls[0][1] 会触发 TS2493。
		const ric = vi.fn((_fn: () => void, _opts?: { timeout?: number }) => 1);
		vi.stubGlobal("requestIdleCallback", ric);
		render(wrap(<AiChatDock />));
		expect(ric.mock.calls[0]?.[1]).toMatchObject({ timeout: expect.any(Number) });
	});
});
