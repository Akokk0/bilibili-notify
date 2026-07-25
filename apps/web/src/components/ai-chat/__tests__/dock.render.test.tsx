// @vitest-environment jsdom
/**
 * AiChatDock 的开合与两种主视图。
 *
 * 重点钉三件在页面上不容易反复验的事:
 *   - 关着时**不发任何请求**(会话列表不该在后台被拉起来)
 *   - 主题色切换会落到 DOM 的 data-chat-theme 上 —— 整页配色全靠这个属性驱动,
 *     CSS 变量在 jsdom 里量不出来,但属性变没变量得出来
 *   - 有消息 / 没消息切两种版式(空态问候页 vs 消息流)
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const H = vi.hoisted(() => ({
	conversations: [] as Array<Record<string, unknown>>,
	messages: [] as Array<Record<string, unknown>>,
	listCalls: 0,
	/** 流式回复的分片。 */
	chunks: ["主人", "晚上好"] as string[],
	/** 置上就让这一轮在吐完分片之后失败。 */
	sendError: null as string | null,
	/** 等待放行的分片闸门 —— 由测试逐个开闸,见 sendChatMessage 的注释。 */
	gate: [] as Array<() => void>,
	/** 置上就让 getConversation 一直挂着不回,用来放大「真身还在路上」那段窗口。 */
	holdConv: false,
	convGate: [] as Array<() => void>,
}));

vi.mock("../../../services/aiChat", async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	return {
		...actual,
		listConversations: vi.fn(async () => {
			H.listCalls++;
			return { conversations: H.conversations };
		}),
		getConversation: vi.fn(async (id: string) => {
			if (H.holdConv) await new Promise<void>((r) => H.convGate.push(r));
			return {
				id,
				title: "t",
				createdAt: "2026-07-24T00:00:00.000Z",
				updatedAt: "2026-07-24T00:00:00.000Z",
				messageCount: H.messages.length,
				messages: H.messages,
			};
		}),
		createConversation: vi.fn(async () => ({
			id: "new-id",
			title: "新对话",
			createdAt: "2026-07-24T00:00:00.000Z",
			updatedAt: "2026-07-24T00:00:00.000Z",
			messageCount: 0,
			messages: [],
		})),
		deleteConversation: vi.fn(async () => ({ ok: true })),
		/**
		 * 每一片都**等测试放行**才吐。
		 *
		 * 不用 `setTimeout(0)` 之类的延时:那样整轮在一个 tick 内就跑完了,
		 * waitFor 下一次轮询时中间态早已消失,断言只能看到最终结果 —— 而这里要
		 * 验的恰恰是「发出去的瞬间」「只吐了一半的瞬间」。靠时长去凑更糟,那是
		 * 在把断言押在机器快慢上。
		 */
		sendChatMessage: vi.fn(
			async (_id: string, message: string, h: { onDelta: (t: string) => void }) => {
				for (const c of H.chunks) {
					await new Promise<void>((r) => H.gate.push(r));
					h.onDelta(c);
				}
				if (H.sendError) throw new Error(H.sendError);
				const reply = {
					id: "a1",
					role: "assistant",
					content: H.chunks.join(""),
					ts: "2026-07-25T00:00:01.000Z",
				};
				const user = {
					id: "u1",
					role: "user",
					content: message,
					ts: "2026-07-25T00:00:00.000Z",
				};
				// 落盘之后再取会话就该看到这两条 —— 否则成功一瞬间界面会退回空态,
				// 与真实后端的行为对不上。
				H.messages = [user, reply];
				return {
					user,
					reply,
					conversation: {
						id: "c1",
						title: message,
						createdAt: "2026-07-25T00:00:00.000Z",
						updatedAt: "2026-07-25T00:00:01.000Z",
						messageCount: 2,
					},
				};
			},
		),
	};
});

const G = vi.hoisted(() => ({
	ai: {
		model: "gpt-test",
		persona: { name: "小绫", addressSelf: "小绫", addressUser: "主人" },
	} as Record<string, unknown>,
}));

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(async () => ({ defaults: { ai: G.ai } })) },
}));

import { DEFAULT_GLASS_OPACITY, useAiChatStore } from "../../../store/aiChat";
import { useAuthStore } from "../../../store/auth";
import { BiliLoginStatus } from "../../../types/auth";
import { AiChatDock } from "../index";

function wrap(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
	H.conversations = [];
	H.messages = [];
	H.listCalls = 0;
	H.chunks = ["主人", "晚上好"];
	H.sendError = null;
	H.gate = [];
	H.holdConv = false;
	H.convGate = [];
	G.ai = {
		model: "gpt-test",
		persona: { name: "小绫", addressSelf: "小绫", addressUser: "主人" },
	};
	useAiChatStore.setState({
		open: false,
		rail: true,
		theme: "lime",
		activeId: null,
		glassOpacity: DEFAULT_GLASS_OPACITY,
		glassClear: false,
	});
});
afterEach(() => {
	// 卸载前把还挂着的 getConversation 放掉,免得未 settle 的 promise 跨用例悬着。
	for (const open of H.convGate.splice(0)) open();
	cleanup();
});

describe("AiChatDock — 收起态", () => {
	it("只显示右下角那颗胶囊", () => {
		render(wrap(<AiChatDock />));
		expect(screen.getByTitle("打开女仆 AI 聊天")).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("关着时一个请求都不发 —— 不在后台悄悄拉会话列表", async () => {
		// 这颗胶囊在每一页都挂着,顺手起个轮询就是全站常驻的无谓流量。
		render(wrap(<AiChatDock />));
		await new Promise((r) => setTimeout(r, 20));
		expect(H.listCalls).toBe(0);
	});

	it("胶囊自己带 fixed 定位类,不靠 .bn-ai-fab 里的 position", () => {
		// 踩过的坑:.bn-ai-fab 当初写了 position:relative,而它是**无层** CSS,
		// 恒压过 @layer utilities 里的 .fixed —— 按钮回到常规流,再叠上 display:flex
		// 就摊成了一整条横幅。样式表那边已改成 @layer components;这里守住调用处
		// 确实挂了定位类(jsdom 没有 layout,量不出实际位置,只能查类名)。
		render(wrap(<AiChatDock />));
		const fab = screen.getByTitle("打开女仆 AI 聊天");
		expect(fab.className).toContain("fixed");
		expect(fab.className).toContain("right-5");
	});
});

describe("AiChatDock — 展开态", () => {
	it("点胶囊展开整页聊天", async () => {
		render(wrap(<AiChatDock />));
		screen.getByTitle("打开女仆 AI 聊天").click();
		await waitFor(() => expect(screen.getByRole("dialog", { name: "女仆 AI 聊天" })).toBeTruthy());
	});

	it("没有消息 → 空态问候页,带技能胶囊", async () => {
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		await waitFor(() => expect(screen.getByText(/今天想让小绫帮主人做点什么呢/)).toBeTruthy());
		expect(screen.getByText("评选鸽王与勤奋 UP,毒舌锐评")).toBeTruthy();
	});

	it("有消息 → 切成消息流,不再显示问候页", async () => {
		H.messages = [
			{ id: "m1", role: "user", content: "本周谁最勤奋", ts: "2026-07-24T00:00:00.000Z" },
			{ id: "m2", role: "assistant", content: "小铃看了一下～", ts: "2026-07-24T00:00:01.000Z" },
		];
		useAiChatStore.setState({ open: true, activeId: "c1" });
		render(wrap(<AiChatDock />));

		await waitFor(() => expect(screen.getByText("本周谁最勤奋")).toBeTruthy());
		expect(screen.getByText("小铃看了一下～")).toBeTruthy();
		expect(screen.queryByText(/今天想让小铃帮主人做点什么呢/)).toBeNull();
	});

	it("「返回控制台」收回胶囊态", async () => {
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		screen.getByText("返回控制台").click();
		await waitFor(() => expect(screen.getByTitle("打开女仆 AI 聊天")).toBeTruthy());
	});
});

describe("AiChatDock — 发送与流式渲染", () => {
	/**
	 * 每次都**重新查**输入框,不留引用:空态与对话态各挂一个 Composer 实例,
	 * 一发消息就从前者切到后者 —— 攥着旧引用读到的是一个已经脱离文档的节点,
	 * 它的 value 永远停在发送前那一刻。
	 */
	const composer = () => screen.getByLabelText("聊天输入") as HTMLTextAreaElement;
	/** 只在消息区里找 —— 见 messages.tsx 里 testid 的注释。 */
	const inChat = () => within(screen.getByTestId("chat-messages"));

	async function typeAndSend(text: string) {
		useAiChatStore.setState({ open: true, activeId: "c1" });
		render(wrap(<AiChatDock />));
		const ta = await screen.findByLabelText("聊天输入");
		fireEvent.change(ta, { target: { value: text } });
		fireEvent.keyDown(ta, { key: "Enter" });
	}

	/** 放行下一个分片,并等它渲染完。 */
	async function releaseChunk() {
		await waitFor(() => expect(H.gate.length).toBeGreaterThan(0));
		const open = H.gate.shift();
		await act(async () => {
			open?.();
		});
	}

	it("按下回车,自己那句立刻上屏 —— 不等回复回来才一起出现", async () => {
		// 这是主人报的第一个问题:消息停在输入框里,像石沉大海。
		await typeAndSend("本周谁最勤奋");
		// 一个分片都还没放行,女仆一个字都没说。
		await waitFor(() => expect(inChat().getByText("本周谁最勤奋")).toBeTruthy());
		expect(inChat().queryByText(/晚上好/)).toBeNull();
		// 输入框同时被清空 —— 消息「离开」输入框、出现在对话里。
		expect(composer().value).toBe("");
	});

	it("回复是逐字长出来的 —— 中途能看到只吐了一半的样子", async () => {
		await typeAndSend("在吗");
		await releaseChunk();
		await waitFor(() => expect(inChat().getByText("主人")).toBeTruthy());
		await releaseChunk();
		await waitFor(() => expect(inChat().getByText("主人晚上好")).toBeTruthy());
	});

	it("第一个字到达后打字点就退场,不跟光标同时在场", async () => {
		await typeAndSend("在吗");
		expect(await screen.findByLabelText(/正在思考/)).toBeTruthy();
		await releaseChunk();
		await waitFor(() => expect(screen.queryByLabelText(/正在思考/)).toBeNull());
	});

	it("失败 → 撤回这一轮,原文退回输入框好重试", async () => {
		// 服务端那一轮什么都没落盘,屏幕上也就不该留下一轮「刷新就消失」的问答。
		H.sendError = "401 Unauthorized";
		H.chunks = [];
		await typeAndSend("在吗");
		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		expect(screen.getByRole("alert").textContent).toContain("401");
		await waitFor(() => expect(composer().value).toBe("在吗"));
		expect(screen.queryByTestId("chat-messages")).toBeNull();
	});

	/**
	 * 最后一片吐完的那一刻,在途副本要**原地**换成落盘的真身。
	 *
	 * 这里是主人看到的那一下「闪」的两个来源,分开钉:
	 *   - 数据空窗:真身若要靠重新拉一次会话才拿到,中间隔着一整个网络往返,
	 *     那段时间副本已退场、真身还没到,整轮问答从屏幕上消失再出现。
	 *   - 动画重播:这两条已经在屏幕上待了一整轮了,真身接手时再演一遍入场
	 *     淡入上移,看着就是整段回复又闪了一下。
	 */
	describe("最后一片吐完 → 真身原地接手", () => {
		it("服务端那次 GET 一直不回,回复也得留在屏幕上 —— 不能先空一下", async () => {
			// 把「真身还在路上」那段窗口拉到无限长:靠重新拉一次才显示的实现,
			// 在这里会一路空到底,而不是一闪而过看不出来。
			H.holdConv = true;
			await typeAndSend("在吗");
			await releaseChunk();
			await releaseChunk();
			await waitFor(() => expect(inChat().getByText("主人晚上好")).toBeTruthy());
			// 自己那句也不能跟着消失。
			expect(inChat().getByText("在吗")).toBeTruthy();
		});

		it("接手时不重播入场动画", async () => {
			await typeAndSend("在吗");
			await releaseChunk();
			await releaseChunk();
			await waitFor(() => expect(inChat().getByText("主人晚上好")).toBeTruthy());
			expect(inChat().getByText("主人晚上好").className).not.toContain("bn-anim-msg-in");
			// 用户那条的动画类挂在气泡外层。
			expect(inChat().getByText("在吗").parentElement?.className).not.toContain("bn-anim-msg-in");
		});

		it("但换个会话再回来时照常播 —— 那时整个列表本来就是新挂载的", async () => {
			await typeAndSend("在吗");
			await releaseChunk();
			await releaseChunk();
			await waitFor(() => expect(inChat().getByText("主人晚上好")).toBeTruthy());
			act(() => useAiChatStore.setState({ activeId: "other" }));
			act(() => useAiChatStore.setState({ activeId: "c1" }));
			await waitFor(() =>
				expect(inChat().getByText("主人晚上好").className).toContain("bn-anim-msg-in"),
			);
		});
	});

	it("发出去之后立刻离开空态问候页", async () => {
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		const ta = await screen.findByLabelText("聊天输入");
		fireEvent.change(ta, { target: { value: "在吗" } });
		fireEvent.keyDown(ta, { key: "Enter" });
		await waitFor(() => expect(screen.queryByText(/今天想让/)).toBeNull());
	});
});

describe("AiChatDock — 玻璃质感设置落到 DOM", () => {
	/**
	 * jsdom 没有布局也不算 calc,所以这里只验**交界**:设置有没有送到 CSS 手上。
	 * 送到之后长什么样(alpha 缩放、磨砂去没去掉)是 CSS 的事,只能真机看。
	 */
	const glassVars = async () => {
		const dialog = await screen.findByRole("dialog");
		return {
			glass: dialog.style.getPropertyValue("--bn-chat-glass"),
			blur: dialog.style.getPropertyValue("--bn-chat-blur"),
			saturate: dialog.style.getPropertyValue("--bn-chat-saturate"),
		};
	};

	/**
	 * 主人报的:拉到最低时显出了背景色,却**比背景本身还鲜艳**。
	 *
	 * 元凶是 backdrop-filter 里的 saturate —— 它加工的是**背后**的像素。底色实的
	 * 时候被白层盖着看不出来,底色一透,它还在那儿把背后的主题辉光按倍数放大。
	 * 所以饱和度必须跟着透明度一起退场:玻璃都没了,就不该再给背景加料。
	 */
	it("拉到最低时饱和度回到 1 —— 玻璃没了就不该再给背景加料", async () => {
		useAiChatStore.setState({ open: true, glassOpacity: 0 });
		render(wrap(<AiChatDock />));
		expect((await glassVars()).saturate).toBe("1");
	});

	it("完全透明同理 —— 三个值一起退到「这块玻璃不存在」", async () => {
		useAiChatStore.setState({ open: true, glassClear: true });
		render(wrap(<AiChatDock />));
		expect(await glassVars()).toEqual({ glass: "0", blur: "0", saturate: "1" });
	});

	it("透明度直接就是 alpha,原样送到 CSS 手上", async () => {
		useAiChatStore.setState({ open: true, glassOpacity: 0.4 });
		render(wrap(<AiChatDock />));
		// 饱和度跟着走:1(不加料)→ 1.8(满档质感)之间线性。
		expect(await glassVars()).toEqual({ glass: "0.4", blur: "1", saturate: "1.4" });
	});

	it("默认那一档也照常送出去", async () => {
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		expect((await glassVars()).glass).toBe(String(DEFAULT_GLASS_OPACITY));
	});

	it("完全透明压过滑块 —— 拉过的值留着,但这会儿不算数", async () => {
		useAiChatStore.setState({ open: true, glassOpacity: 0.5, glassClear: true });
		render(wrap(<AiChatDock />));
		expect((await glassVars()).glass).toBe("0");
		// store 里那一档没被抹掉,关掉完全透明就回得去。
		expect(useAiChatStore.getState().glassOpacity).toBe(0.5);
	});
});

describe("AiChatDock — 设置弹层里的玻璃质感两项", () => {
	async function openSettings() {
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		fireEvent.click(await screen.findByLabelText("聊天设置"));
	}

	it("滑块拉一下,透明度跟着走", async () => {
		await openSettings();
		const slider = screen.getByLabelText("玻璃片透明度") as HTMLInputElement;
		expect(slider.value).toBe(String(DEFAULT_GLASS_OPACITY));
		fireEvent.change(slider, { target: { value: "0.3" } });
		expect(useAiChatStore.getState().glassOpacity).toBe(0.3);
	});

	it("完全透明开关翻一下就生效", async () => {
		await openSettings();
		fireEvent.click(screen.getByLabelText("完全透明(去磨砂模糊)"));
		expect(useAiChatStore.getState().glassClear).toBe(true);
	});

	it("开着完全透明时滑块禁用 —— 拉了也不生效,就别让人白拉", async () => {
		// 不是把滑块藏起来:藏掉的话主人看不见自己原来调的是哪一档,关掉完全透明
		// 之后会突然跳回一个记不得的值。留在原地、灰着,才看得出「等下就回来」。
		useAiChatStore.setState({ glassClear: true });
		await openSettings();
		expect((screen.getByLabelText("玻璃片透明度") as HTMLInputElement).disabled).toBe(true);
	});
});

describe("AiChatDock — 称呼跟人格走", () => {
	/**
	 * 设计稿里通篇写的是「小铃」,那只是画稿时的临时名字。真实名字在
	 * `globals.defaults.ai.persona`,主人换预设或改名之后,界面上每一处都得跟着变 ——
	 * 漏掉任何一处,表现都是「侧栏写着 A、她自己开口自称 B」。
	 */
	const RINKO = {
		model: "gpt-test",
		persona: { name: "凛子", addressSelf: "本小姐", addressUser: "笨蛋" },
	};

	it("侧栏标题用配置里的名字,不是设计稿的「小铃」", async () => {
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		await waitFor(() => expect(screen.getByText(/女仆AI · 小绫/)).toBeTruthy());
		expect(screen.queryByText(/小铃/)).toBeNull();
	});

	it("输入框 placeholder 也用配置里的名字", async () => {
		G.ai = RINKO;
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		await waitFor(() =>
			expect(screen.getByLabelText("聊天输入").getAttribute("placeholder")).toContain(
				"给凛子发消息",
			),
		);
	});

	it("空态那句问候用「自称 + 对主人的称呼」,两处都跟着人格变", async () => {
		G.ai = RINKO;
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		await waitFor(() => expect(screen.getByText(/今天想让本小姐帮笨蛋做点什么呢/)).toBeTruthy());
	});

	it("没登录时问候语里的称呼回落到人格的 addressUser,不硬写「主人」", async () => {
		G.ai = RINKO;
		useAuthStore.setState({ snapshot: null } as never);
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		// getAll:问候语和侧栏底部各显示一次称呼,两处都该跟着人格走。
		await waitFor(() => expect(screen.getAllByText("笨蛋").length).toBeGreaterThanOrEqual(2));
		expect(screen.queryByText("主人")).toBeNull();
	});

	it("人格里名字被清空 → 回落成「女仆」,不显示空白", async () => {
		G.ai = { model: "gpt-test", persona: { name: "", addressSelf: "", addressUser: "" } };
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		await waitFor(() => expect(screen.getByText(/女仆AI · 女仆/)).toBeTruthy());
	});

	it("底部显示配置里的模型名", async () => {
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		await waitFor(() => expect(screen.getByText("gpt-test")).toBeTruthy());
	});
});

describe("AiChatDock — 侧栏与主题", () => {
	it("收起侧栏后换成展开按钮", async () => {
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		screen.getByLabelText("收起侧栏").click();
		await waitFor(() => expect(screen.getByLabelText("打开侧栏")).toBeTruthy());
		expect(screen.queryByLabelText("收起侧栏")).toBeNull();
	});

	it("换主题色 → data-chat-theme 跟着变(整页配色全靠它驱动)", async () => {
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		const dialog = screen.getByRole("dialog", { name: "女仆 AI 聊天" });
		expect(dialog.getAttribute("data-chat-theme")).toBe("lime");

		screen.getByLabelText("聊天设置").click();
		await waitFor(() => expect(screen.getByTitle("蜜桃")).toBeTruthy());
		screen.getByTitle("蜜桃").click();
		await waitFor(() => expect(dialog.getAttribute("data-chat-theme")).toBe("peach"));
	});

	it("一次都没聊过时侧栏给一句引导,不是空白", async () => {
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		await waitFor(() => expect(screen.getByText(/还没有聊过天呢/)).toBeTruthy());
	});

	it("有真头像就显示头像,并带 no-referrer(B 站图床按 Referer 防盗链)", async () => {
		useAuthStore.setState({
			snapshot: {
				status: BiliLoginStatus.LOGGED_IN,
				data: { card: { name: "晨风UP主", face: "https://i0.hdslb.com/face.jpg" } },
			},
		} as never);
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));

		const img = await screen.findByAltText("晨风UP主");
		expect(img.getAttribute("src")).toBe("https://i0.hdslb.com/face.jpg");
		// 不带这条,B 站会回一张 403 占位图,头像位置变成裂图。
		expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
	});

	it("取不到头像 → 回落成首字色块,不留一个空洞", async () => {
		useAuthStore.setState({
			snapshot: { status: BiliLoginStatus.LOGGED_IN, data: { card: { name: "晨风UP主" } } },
		} as never);
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));

		await waitFor(() => expect(screen.getAllByText("晨").length).toBeGreaterThan(0));
		expect(screen.queryByAltText("晨风UP主")).toBeNull();
	});

	it("有会话时按今天 / 昨天分组列出来", async () => {
		const today = new Date().toISOString();
		H.conversations = [
			{ id: "c1", title: "本周谁最勤奋", createdAt: today, updatedAt: today, messageCount: 2 },
		];
		useAiChatStore.setState({ open: true });
		render(wrap(<AiChatDock />));
		await waitFor(() => expect(screen.getByText("本周谁最勤奋")).toBeTruthy());
		expect(screen.getByText("今天")).toBeTruthy();
	});
});
