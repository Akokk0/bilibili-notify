// @vitest-environment jsdom
/**
 * 聊天页(/chat)的开合与两种主视图。
 *
 * 聊天是一条**路由**,不是盖在当前页上的 overlay:胶囊把主人送到 /chat,
 * 「返回控制台」回来路。重点钉四件在页面上不容易反复验的事:
 *   - 不在聊天页时**不发任何请求**(会话列表不该在后台被拉起来)
 *   - 开合走路由:直接落在 /chat(书签)也能进、也回得去
 *   - 四色预设已砍:chat 根不再挂 data-chat-theme,默认主题定义在 styles.css
 *     的 :root 上,换观感一律走皮肤包
 *   - 有消息 / 没消息切两种版式(空态问候页 vs 消息流)
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
	/** 工具调用的两拍剧本,在正文分片**之前**逐个吐,与真实顺序一致。 */
	toolEvents: [] as Array<Record<string, unknown>>,
	/** 落盘后那条回复上带的工具痕迹 —— 交接与刷新之后靠它显示。 */
	replyTools: null as Array<Record<string, unknown>> | null,
	/** 思考分片,在工具与正文**之前**逐个吐 —— 先想后说,真实顺序就是这样。 */
	reasoningChunks: [] as string[],
	/** 落盘后那条回复上带的完整思考 —— 交接与刷新之后靠它显示。 */
	replyReasoning: null as string | null,
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
		retitleConversation: vi.fn(async (id: string) => ({
			id,
			title: "本周勤奋榜",
			createdAt: "2026-07-25T00:00:00.000Z",
			updatedAt: "2026-07-25T00:00:01.000Z",
			messageCount: 2,
		})),
		/**
		 * 每一片都**等测试放行**才吐。
		 *
		 * 不用 `setTimeout(0)` 之类的延时:那样整轮在一个 tick 内就跑完了,
		 * waitFor 下一次轮询时中间态早已消失,断言只能看到最终结果 —— 而这里要
		 * 验的恰恰是「发出去的瞬间」「只吐了一半的瞬间」。靠时长去凑更糟,那是
		 * 在把断言押在机器快慢上。
		 */
		sendChatMessage: vi.fn(
			async (
				_id: string,
				message: string,
				h: {
					onDelta: (t: string) => void;
					onTool?: (ev: Record<string, unknown>) => void;
					onReasoning?: (t: string) => void;
				},
			) => {
				// 思考先于一切 —— 她是想完才决定查什么、说什么的。
				for (const t of H.reasoningChunks) {
					await new Promise<void>((r) => H.gate.push(r));
					h.onReasoning?.(t);
				}
				// 工具轮排在正文之前 —— 她是查完才开口的。
				for (const ev of H.toolEvents) {
					await new Promise<void>((r) => H.gate.push(r));
					h.onTool?.(ev);
				}
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
					...(H.replyTools ? { tools: H.replyTools } : {}),
					...(H.replyReasoning ? { reasoning: H.replyReasoning } : {}),
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
		// 模型名住在当前生效的那个服务商桶里(各家一套配置)。
		activeProfile: "deepseek",
		providers: { deepseek: { model: "gpt-test" } },
		persona: { name: "小绫", addressSelf: "小绫", addressUser: "主人" },
	} as Record<string, unknown>,
}));

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(async () => ({ defaults: { ai: G.ai } })) },
}));

import { createConversation, retitleConversation, sendChatMessage } from "../../../services/aiChat";
import { DEFAULT_GLASS_OPACITY, useAiChatStore } from "../../../store/aiChat";
import { useAuthStore } from "../../../store/auth";
import { BiliLoginStatus } from "../../../types/auth";
import { AiChatDock, ChatPage } from "../index";

/** ChatPage 用 useNavigate / useLocation,得裹在 Router 里;单渲染聊天页时来路无所谓。 */
function wrap(node: ReactNode, initialPath = "/chat") {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[initialPath]}>{node}</MemoryRouter>
		</QueryClientProvider>
	);
}

/**
 * 完整的开合链路:胶囊 + 两条路由。验「点胶囊进得去、返回出得来」必须两页都在 ——
 * 只渲染 ChatPage 的话,导航发生了也看不见任何变化。
 */
function shell() {
	return (
		<>
			<AiChatDock />
			<Routes>
				<Route path="/" element={<div data-testid="console-page" />} />
				<Route path="/chat" element={<ChatPage />} />
			</Routes>
		</>
	);
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
	H.toolEvents = [];
	H.replyTools = null;
	H.reasoningChunks = [];
	H.replyReasoning = null;
	vi.mocked(createConversation).mockClear();
	vi.mocked(retitleConversation).mockClear();
	G.ai = {
		// 模型名住在当前生效的那个服务商桶里(各家一套配置)。
		activeProfile: "deepseek",
		providers: { deepseek: { model: "gpt-test" } },
		persona: { name: "小绫", addressSelf: "小绫", addressUser: "主人" },
	};
	useAiChatStore.setState({
		rail: true,
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

describe("AiChatDock — 不在聊天页时", () => {
	it("只显示右下角那颗胶囊", () => {
		render(wrap(shell(), "/"));
		expect(screen.getByTitle("打开女仆 AI 聊天")).toBeTruthy();
		expect(screen.queryByRole("region")).toBeNull();
	});

	it("一个请求都不发 —— 不在后台悄悄拉会话列表", async () => {
		// 这颗胶囊在每一页都挂着,顺手起个轮询就是全站常驻的无谓流量。
		render(wrap(shell(), "/"));
		await new Promise((r) => setTimeout(r, 20));
		expect(H.listCalls).toBe(0);
	});

	it("胶囊自己带 fixed 定位类,不靠 .bn-ai-fab 里的 position", () => {
		// 踩过的坑:.bn-ai-fab 当初写了 position:relative,而它是**无层** CSS,
		// 恒压过 @layer utilities 里的 .fixed —— 按钮回到常规流,再叠上 display:flex
		// 就摊成了一整条横幅。样式表那边已改成 @layer components;这里守住调用处
		// 确实挂了定位类(jsdom 没有 layout,量不出实际位置,只能查类名)。
		render(wrap(shell(), "/"));
		const fab = screen.getByTitle("打开女仆 AI 聊天");
		expect(fab.className).toContain("fixed");
		expect(fab.className).toContain("right-5");
	});
});

describe("聊天页 — 路由开合", () => {
	it("点胶囊 → 去 /chat,整页聊天出现", async () => {
		render(wrap(shell(), "/"));
		screen.getByTitle("打开女仆 AI 聊天").click();
		await waitFor(() => expect(screen.getByRole("region", { name: "女仆 AI 聊天" })).toBeTruthy());
	});

	it("聊天页上胶囊不再显示 —— 自己叠在自己的入口上没有意义", async () => {
		render(wrap(shell(), "/chat"));
		await screen.findByRole("region", { name: "女仆 AI 聊天" });
		expect(screen.queryByTitle("打开女仆 AI 聊天")).toBeNull();
	});

	it("「返回控制台」回来路,胶囊回来", async () => {
		render(wrap(shell(), "/"));
		screen.getByTitle("打开女仆 AI 聊天").click();
		await screen.findByRole("region", { name: "女仆 AI 聊天" });

		screen.getByText("返回控制台").click();
		await waitFor(() => expect(screen.getByTestId("console-page")).toBeTruthy());
		expect(screen.queryByRole("region")).toBeNull();
		expect(screen.getByTitle("打开女仆 AI 聊天")).toBeTruthy();
	});

	it("直接落在 /chat(书签 / 手输网址)→ 「返回控制台」回首页,不是退出站点", async () => {
		// 历史里没有上一页,navigate(-1) 无处可退 —— 这时必须显式回 /。
		render(wrap(shell(), "/chat"));
		(await screen.findByText("返回控制台")).click();
		await waitFor(() => expect(screen.getByTestId("console-page")).toBeTruthy());
	});

	it("没有消息 → 空态问候页,带技能胶囊", async () => {
		render(wrap(<ChatPage />));
		await waitFor(() => expect(screen.getByText(/今天想让小绫帮主人做点什么呢/)).toBeTruthy());
		expect(screen.getByText("评选鸽王与勤奋 UP,毒舌锐评")).toBeTruthy();
	});

	it("有消息 → 切成消息流,不再显示问候页", async () => {
		H.messages = [
			{ id: "m1", role: "user", content: "本周谁最勤奋", ts: "2026-07-24T00:00:00.000Z" },
			{ id: "m2", role: "assistant", content: "小铃看了一下～", ts: "2026-07-24T00:00:01.000Z" },
		];
		useAiChatStore.setState({ activeId: "c1" });
		render(wrap(<ChatPage />));

		await waitFor(() => expect(screen.getByText("本周谁最勤奋")).toBeTruthy());
		expect(screen.getByText("小铃看了一下～")).toBeTruthy();
		expect(screen.queryByText(/今天想让小铃帮主人做点什么呢/)).toBeNull();
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

	/**
	 * 某段回复所在的「这一轮」最外层 —— 入场动画类挂在那儿。
	 *
	 * 不用 `.parentElement` 数层数:正文经 Markdown 渲染后要往里套两层,层数一变,
	 * `not.toContain` 就成了无条件通过的假绿断言。这里顺带断言真找到了。
	 */
	function turnOf(text: string): HTMLElement {
		const turn = inChat().getByText(text).closest('[data-testid="assistant-turn"]');
		if (!turn) throw new Error(`没找到「${text}」所在的 assistant-turn`);
		return turn as HTMLElement;
	}

	async function typeAndSend(text: string) {
		useAiChatStore.setState({ activeId: "c1" });
		render(wrap(<ChatPage />));
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
			expect(turnOf("主人晚上好").className).not.toContain("bn-anim-msg-in");
			// 用户那条的动画类挂在气泡外层。
			expect(inChat().getByText("在吗").parentElement?.className).not.toContain("bn-anim-msg-in");
		});

		it("第二轮结束时,上一轮那两条也不能重播 —— 主人看到的正是「上一条闪了一下」", async () => {
			// 只记住最近一轮的话,第二轮把 settled 换掉,上一轮那两条就**重新**被加上
			// 入场动画类 —— CSS 动画于是又演一遍。已经在屏幕上待着的消息,任何时候
			// 都不该再演入场。
			await typeAndSend("第一问");
			await releaseChunk();
			await releaseChunk();
			await waitFor(() => expect(inChat().getByText("主人晚上好")).toBeTruthy());

			// 第二轮换一组 id,模拟服务端新落盘的两条。
			vi.mocked(sendChatMessage).mockImplementationOnce(async (_id, message, h) => {
				h.onDelta("好的");
				const user = {
					id: "u2",
					role: "user" as const,
					content: message,
					ts: "2026-07-25T00:00:02.000Z",
				};
				const reply = {
					id: "a2",
					role: "assistant" as const,
					content: "好的",
					ts: "2026-07-25T00:00:03.000Z",
				};
				H.messages = [...H.messages, user, reply];
				return {
					user,
					reply,
					conversation: {
						id: "c1",
						title: "t",
						createdAt: "2026-07-25T00:00:00.000Z",
						updatedAt: "2026-07-25T00:00:03.000Z",
						messageCount: 4,
					},
				};
			});
			const ta = composer();
			fireEvent.change(ta, { target: { value: "第二问" } });
			fireEvent.keyDown(ta, { key: "Enter" });

			await waitFor(() => expect(inChat().getByText("好的")).toBeTruthy());
			// 第一轮那两条仍然不带动画类。
			expect(turnOf("主人晚上好").className).not.toContain("bn-anim-msg-in");
			expect(inChat().getByText("第一问").parentElement?.className).not.toContain("bn-anim-msg-in");
		});

		it("但换个会话再回来时照常播 —— 那时整个列表本来就是新挂载的", async () => {
			await typeAndSend("在吗");
			await releaseChunk();
			await releaseChunk();
			await waitFor(() => expect(inChat().getByText("主人晚上好")).toBeTruthy());
			act(() => useAiChatStore.setState({ activeId: "other" }));
			act(() => useAiChatStore.setState({ activeId: "c1" }));
			await waitFor(() => expect(turnOf("主人晚上好").className).toContain("bn-anim-msg-in"));
		});
	});

	it("发出去之后立刻离开空态问候页", async () => {
		render(wrap(<ChatPage />));
		const ta = await screen.findByLabelText("聊天输入");
		fireEvent.change(ta, { target: { value: "在吗" } });
		fireEvent.keyDown(ta, { key: "Enter" });
		await waitFor(() => expect(screen.queryByText(/今天想让/)).toBeNull());
	});
});

/**
 * 工具轮**不产生正文**,所以那几秒里界面上只有三个跳动的点 —— 跟「模型卡住了」
 * 长得一模一样。主人报的就是这个:她明明在查订阅,页面上却什么都没说。
 */
/**
 * Markdown 一进消息流,就多了一条容易悄悄破掉的不变量:**在途那份和落盘那份必须
 * 渲染成同一个东西**。两边现在都走 AssistantTurn → ChatMarkdown,所以是由构造保证的;
 * 这里钉住它,免得日后有人为了「流式期间省点开销」把在途那份改回纯文本 —— 那会
 * 让交接那一刻整块重排,正是主人报过的「回复吐完闪一下」。
 */
describe("AiChatDock — Markdown 渲染", () => {
	const inChat = () => within(screen.getByTestId("chat-messages"));

	async function typeAndSend(text: string) {
		useAiChatStore.setState({ activeId: "c1" });
		render(wrap(<ChatPage />));
		const ta = await screen.findByLabelText("聊天输入");
		fireEvent.change(ta, { target: { value: text } });
		fireEvent.keyDown(ta, { key: "Enter" });
	}

	async function release() {
		await waitFor(() => expect(H.gate.length).toBeGreaterThan(0));
		const open = H.gate.shift();
		await act(async () => {
			open?.();
		});
	}

	it("落盘的回复按 Markdown 渲染", async () => {
		H.messages = [
			{ id: "m1", role: "user", content: "列一下", ts: "2026-07-24T00:00:00.000Z" },
			{
				id: "m2",
				role: "assistant",
				content: "**重点**是这些:\n- 甲\n- 乙",
				ts: "2026-07-24T00:00:01.000Z",
			},
		];
		useAiChatStore.setState({ activeId: "c1" });
		render(wrap(<ChatPage />));
		await waitFor(() => expect(inChat().getByText("重点")).toBeTruthy());
		expect(inChat().getByText("重点").tagName).toBe("STRONG");
		expect(screen.getByTestId("chat-messages").querySelectorAll("li")).toHaveLength(2);
	});

	it("流式期间就在渲染 —— 不是等 done 之后才切", async () => {
		// 等 done 再切的话,交接那一刻整块重排。这条就是拦住那种实现的。
		H.chunks = ["**重点**", "是这些"];
		await typeAndSend("列一下");
		await release();
		await waitFor(() => expect(inChat().getByText("重点").tagName).toBe("STRONG"));
	});

	it("同一段文字,在途与落盘渲染出的结构完全一致", async () => {
		H.chunks = ["**粗**\n- 甲\n- 乙"];
		await typeAndSend("列一下");
		await release();
		// 在途:draft 已经全到,但 done 还没落。
		await waitFor(() => expect(inChat().getByText("粗")).toBeTruthy());
		const streaming = normalize(screen.getByTestId("chat-messages").innerHTML);

		// 放行到 done,真身接手。
		await waitFor(() => expect(inChat().getByText("甲")).toBeTruthy());
		const settled = normalize(screen.getByTestId("chat-messages").innerHTML);
		expect(settled).toBe(streaming);
	});

	/** 抹掉只与「在途」有关的差异:光标类、消息 id 带来的 key。 */
	function normalize(html: string): string {
		return html.replace(/\s*bn-chat-md-caret\s*/g, " ").replace(/\s+/g, " ");
	}

	it("主人自己那句**不**渲染 Markdown —— 打的 * 就是 *", async () => {
		H.chunks = ["好"];
		await typeAndSend("这里有 *星号* 和 **双星**");
		await waitFor(() => expect(inChat().getByText(/这里有 \*星号\* 和 \*\*双星\*\*/)).toBeTruthy());
		// 用户气泡里不该冒出 em / strong。
		const bubble = inChat().getByText(/这里有/);
		expect(bubble.querySelectorAll("em,strong")).toHaveLength(0);
	});
});

describe("AiChatDock — 工具调用小条", () => {
	const composer = () => screen.getByLabelText("聊天输入") as HTMLTextAreaElement;
	const inChat = () => within(screen.getByTestId("chat-messages"));
	const chips = () => inChat().queryAllByTestId("tool-trace");

	async function typeAndSend(text: string) {
		useAiChatStore.setState({ activeId: "c1" });
		render(wrap(<ChatPage />));
		const ta = await screen.findByLabelText("聊天输入");
		fireEvent.change(ta, { target: { value: text } });
		fireEvent.keyDown(ta, { key: "Enter" });
	}

	/** 放行下一步(一拍工具事件或一片正文),并等它渲染完。 */
	async function release() {
		await waitFor(() => expect(H.gate.length).toBeGreaterThan(0));
		const open = H.gate.shift();
		await act(async () => {
			open?.();
		});
	}

	const start = (id: string, name: string, args: Record<string, string> = {}) => ({
		phase: "start",
		id,
		name,
		args,
	});
	const end = (id: string, ok: boolean) => ({ phase: "end", id, ok });

	it("工具一开跑就冒出一条小条,正文一个字都还没到", async () => {
		H.toolEvents = [start("0-0", "list_subscriptions")];
		await typeAndSend("我订了谁");
		await release();

		await waitFor(() => expect(chips()).toHaveLength(1));
		expect(chips()[0]?.textContent).toContain("查看订阅列表");
		// 正文确实还没开始 —— 小条不是等回复出来才补上的。
		expect(inChat().queryByText(/晚上好/)).toBeNull();
	});

	it("跑着的时候是「进行中」,收尾之后翻成「完成」", async () => {
		H.toolEvents = [start("0-0", "list_subscriptions"), end("0-0", true)];
		await typeAndSend("我订了谁");
		await release();
		await waitFor(() => expect(chips()[0]?.dataset.state).toBe("running"));
		await release();
		await waitFor(() => expect(chips()[0]?.dataset.state).toBe("ok"));
	});

	it("失败的那次留在原地并标成失败 —— 「查了没查到」和「压根没查」不一样", async () => {
		H.toolEvents = [start("0-0", "get_live_status"), end("0-0", false)];
		await typeAndSend("谁在播");
		await release();
		await release();
		await waitFor(() => expect(chips()[0]?.dataset.state).toBe("failed"));
		expect(chips()[0]?.textContent).toContain("查看直播状态");
	});

	it("入参带进小条 —— 「搜了什么」比「搜过」有用得多", async () => {
		H.toolEvents = [start("0-0", "search_user", { keyword: "咩栗" })];
		await typeAndSend("帮我找找咩栗");
		await release();
		await waitFor(() => expect(chips()[0]?.textContent).toContain("咩栗"));
	});

	it("几个工具各占一条,按开始顺序排", async () => {
		H.toolEvents = [
			start("0-0", "search_user", { keyword: "咩栗" }),
			start("0-1", "get_user_info", { uid: "123" }),
		];
		await typeAndSend("查一下");
		await release();
		await release();
		await waitFor(() => expect(chips()).toHaveLength(2));
		expect(chips()[0]?.textContent).toContain("搜索 UP 主");
		expect(chips()[1]?.textContent).toContain("查看 UP 主资料");
	});

	it("回复落盘、真身接手之后小条还在 —— 不能在最后一刻凭空消失", async () => {
		// 只在流里显示的话,`done` 一到、真身把在途副本换下来的那一刻,几条小条就
		// 没了。跟「回复吐完闪一下」是同一类观感事故。
		H.toolEvents = [start("0-0", "list_subscriptions"), end("0-0", true)];
		H.replyTools = [{ name: "list_subscriptions", args: {}, ok: true }];
		await typeAndSend("我订了谁");
		await release();
		await release();
		await release();
		await release();
		await waitFor(() => expect(inChat().getByText("主人晚上好")).toBeTruthy());
		expect(chips()).toHaveLength(1);
		expect(chips()[0]?.dataset.state).toBe("ok");
	});

	it("重开一个老会话也看得到她当时查过什么", async () => {
		H.messages = [
			{ id: "m1", role: "user", content: "我订了谁", ts: "2026-07-24T00:00:00.000Z" },
			{
				id: "m2",
				role: "assistant",
				content: "一共 3 位",
				ts: "2026-07-24T00:00:01.000Z",
				tools: [{ name: "list_subscriptions", args: {}, ok: true }],
			},
		];
		useAiChatStore.setState({ activeId: "c1" });
		render(wrap(<ChatPage />));
		await waitFor(() => expect(inChat().getByText("一共 3 位")).toBeTruthy());
		expect(chips()).toHaveLength(1);
		expect(chips()[0]?.textContent).toContain("查看订阅列表");
	});

	it("没调工具就一条都不画", async () => {
		await typeAndSend("在吗");
		await release();
		await waitFor(() => expect(inChat().getByText("主人")).toBeTruthy());
		expect(chips()).toHaveLength(0);
	});

	it("换个会话就把在途的小条清掉 —— 那几条属于上一个会话", async () => {
		H.toolEvents = [start("0-0", "list_subscriptions")];
		await typeAndSend("我订了谁");
		await release();
		await waitFor(() => expect(chips()).toHaveLength(1));
		fireEvent.click(screen.getByText("开启新对话"));
		await waitFor(() => expect(screen.queryByTestId("chat-messages")).toBeNull());
		// 输入框回到空的新对话,上一轮的痕迹不跟过来。
		expect(composer().value).toBe("");
	});
});

/**
 * 思考预览(DeepSeek 式)—— 思考模型「先想后说」的那段草稿,实时streaming、
 * 折叠可看。它跟工具小条解决同一类问题:回答到来之前那十几秒不能是一片死寂,
 * 而思考恰恰是那段时间里唯一真实发生着的事。
 */
describe("AiChatDock — 思考预览", () => {
	const inChat = () => within(screen.getByTestId("chat-messages"));
	const block = () => inChat().queryByTestId("thinking-block");

	async function typeAndSend(text: string) {
		useAiChatStore.setState({ activeId: "c1" });
		render(wrap(<ChatPage />));
		const ta = await screen.findByLabelText("聊天输入");
		fireEvent.change(ta, { target: { value: text } });
		fireEvent.keyDown(ta, { key: "Enter" });
	}

	async function release() {
		await waitFor(() => expect(H.gate.length).toBeGreaterThan(0));
		const open = H.gate.shift();
		await act(async () => {
			open?.();
		});
	}

	it("思考分片实时上屏 —— 正文一个字都没到,也看得见她在想什么", async () => {
		H.reasoningChunks = ["主人在问", "天气"];
		await typeAndSend("明天天气如何");
		await release();
		await waitFor(() => expect(block()?.textContent).toContain("主人在问"));
		// 还在想:标头是进行时。
		expect(block()?.textContent).toContain("思考中");
		// 正文区确实还没开口。
		expect(inChat().queryByText(/晚上好/)).toBeNull();
		await release();
		await waitFor(() => expect(block()?.textContent).toContain("主人在问天气"));
	});

	it("正文一开口,标头翻成「已深度思考」", async () => {
		H.reasoningChunks = ["想想"];
		await typeAndSend("在吗");
		await release(); // 思考
		await release(); // 第一片正文
		await waitFor(() => expect(inChat().getByText("主人")).toBeTruthy());
		expect(block()?.textContent).toContain("已深度思考");
		expect(block()?.textContent).not.toContain("思考中");
	});

	it("落盘交接后思考还在,而且保持展开 —— 不能在最后一刻塌下去", async () => {
		H.reasoningChunks = ["想想"];
		H.replyReasoning = "想想";
		await typeAndSend("在吗");
		await release();
		await release();
		await release();
		await waitFor(() => expect(inChat().getByText("主人晚上好")).toBeTruthy());
		// 真身接手之后草稿还挂在原地、开着。
		expect(block()?.textContent).toContain("想想");
	});

	it("点标头折叠,再点展开 —— 长思考不能占着整屏赶不走", async () => {
		H.reasoningChunks = ["一大段思考"];
		await typeAndSend("在吗");
		await release();
		await waitFor(() => expect(block()?.textContent).toContain("一大段思考"));

		fireEvent.click(within(block() as HTMLElement).getByRole("button"));
		expect(block()?.textContent).not.toContain("一大段思考");

		fireEvent.click(within(block() as HTMLElement).getByRole("button"));
		expect(block()?.textContent).toContain("一大段思考");
	});

	it("重开老会话:默认折叠成一行「已深度思考」,点开才看全文", async () => {
		H.messages = [
			{ id: "m1", role: "user", content: "在吗", ts: "2026-07-24T00:00:00.000Z" },
			{
				id: "m2",
				role: "assistant",
				content: "在的",
				ts: "2026-07-24T00:00:01.000Z",
				reasoning: "主人在确认我在不在",
			},
		];
		useAiChatStore.setState({ activeId: "c1" });
		render(wrap(<ChatPage />));
		await waitFor(() => expect(inChat().getByText("在的")).toBeTruthy());
		// 折叠态:标头在,正文不在。
		expect(block()?.textContent).toContain("已深度思考");
		expect(block()?.textContent).not.toContain("主人在确认我在不在");

		fireEvent.click(within(block() as HTMLElement).getByRole("button"));
		expect(block()?.textContent).toContain("主人在确认我在不在");
	});

	it("没思考的回复不画这个块 —— 非思考模型的对话不该多一行摆设", async () => {
		await typeAndSend("在吗");
		await release();
		await release();
		await waitFor(() => expect(inChat().getByText("主人晚上好")).toBeTruthy());
		expect(block()).toBeNull();
	});
});

describe("AiChatDock — 玻璃质感设置落到 DOM", () => {
	/**
	 * jsdom 没有布局也不算 calc,所以这里只验**交界**:设置有没有送到 CSS 手上。
	 * 送到之后长什么样(alpha 缩放、磨砂去没去掉)是 CSS 的事,只能真机看。
	 */
	const glassVars = async () => {
		const dialog = await screen.findByRole("region");
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
		useAiChatStore.setState({ glassOpacity: 0 });
		render(wrap(<ChatPage />));
		expect((await glassVars()).saturate).toBe("1");
	});

	it("完全透明同理 —— 三个值一起退到「这块玻璃不存在」", async () => {
		useAiChatStore.setState({ glassClear: true });
		render(wrap(<ChatPage />));
		expect(await glassVars()).toEqual({ glass: "0", blur: "0", saturate: "1" });
	});

	it("透明度直接就是 alpha,原样送到 CSS 手上", async () => {
		useAiChatStore.setState({ glassOpacity: 0.4 });
		render(wrap(<ChatPage />));
		// 饱和度跟着走:1(不加料)→ 1.8(满档质感)之间线性。
		expect(await glassVars()).toEqual({ glass: "0.4", blur: "1", saturate: "1.4" });
	});

	it("默认那一档也照常送出去", async () => {
		render(wrap(<ChatPage />));
		expect((await glassVars()).glass).toBe(String(DEFAULT_GLASS_OPACITY));
	});

	it("完全透明压过滑块 —— 拉过的值留着,但这会儿不算数", async () => {
		useAiChatStore.setState({ glassOpacity: 0.5, glassClear: true });
		render(wrap(<ChatPage />));
		expect((await glassVars()).glass).toBe("0");
		// store 里那一档没被抹掉,关掉完全透明就回得去。
		expect(useAiChatStore.getState().glassOpacity).toBe(0.5);
	});
});

describe("AiChatDock — 开启新对话", () => {
	/**
	 * 主人报的:点完「开启新对话」,左侧立刻多出一条记录,而自己一个字都还没发。
	 *
	 * 空会话不该占位。发送那条路本来就有 `activeId ?? createConversation()`,
	 * 真到要落盘的时候自然会建 —— 这颗按钮只需要把界面退回空态。
	 */
	it("只回到空态,不去服务端建一个空会话", async () => {
		H.messages = [{ id: "m1", role: "user", content: "你好", ts: "2026-07-25T00:00:00.000Z" }];
		useAiChatStore.setState({ activeId: "c1" });
		render(wrap(<ChatPage />));
		await waitFor(() => expect(screen.getByTestId("chat-messages")).toBeTruthy());

		fireEvent.click(screen.getByText("开启新对话"));

		await waitFor(() => expect(screen.getByText(/今天想让/)).toBeTruthy());
		expect(vi.mocked(createConversation)).not.toHaveBeenCalled();
	});

	it("退回空态后再发一句,这时才建会话", async () => {
		useAiChatStore.setState({ activeId: "c1" });
		render(wrap(<ChatPage />));
		fireEvent.click(await screen.findByText("开启新对话"));
		expect(vi.mocked(createConversation)).not.toHaveBeenCalled();

		const ta = await screen.findByLabelText("聊天输入");
		fireEvent.change(ta, { target: { value: "本周谁最勤奋" } });
		fireEvent.keyDown(ta, { key: "Enter" });

		await waitFor(() => expect(vi.mocked(createConversation)).toHaveBeenCalledTimes(1));
	});
});

describe("AiChatDock — AI 起标题", () => {
	/**
	 * 主人报的:每个会话都叫「你好」。首问截断只是兜底 —— 主人每次都这么开场,
	 * 那一列就全是同一个词。聊完第一轮让女仆看一眼,起个概括主题的名字。
	 */
	async function sendOnce(text: string) {
		render(wrap(<ChatPage />));
		const ta = await screen.findByLabelText("聊天输入");
		fireEvent.change(ta, { target: { value: text } });
		fireEvent.keyDown(ta, { key: "Enter" });
		for (const _ of H.chunks) {
			await waitFor(() => expect(H.gate.length).toBeGreaterThan(0));
			const open = H.gate.shift();
			await act(async () => {
				open?.();
			});
		}
	}

	it("第一轮聊完 → 去要一个标题", async () => {
		useAiChatStore.setState({ activeId: "c1" });
		await sendOnce("你好");
		await waitFor(() => expect(vi.mocked(retitleConversation)).toHaveBeenCalled());
		// react-query 会往 mutationFn 里多塞一个 context 参数,只看第一个实参。
		expect(vi.mocked(retitleConversation).mock.calls[0]?.[0]).toBe("c1");
	});

	it("聊过好几轮的老会话照样会去要 —— 主人那一屋子「你好」正是这种", async () => {
		// 这些会话是功能上线前建的:里面早有好几条消息,也从没被 AI 起过名。
		// 用「刚聊完第一轮」当判据的话,它们一个都轮不上,请求压根不发出去 ——
		// 主人查日志也查不到任何痕迹,因为服务端根本没被碰到。
		vi.mocked(sendChatMessage).mockImplementationOnce(async (_id, message, h) => {
			h.onDelta("好的");
			return {
				user: { id: "u9", role: "user" as const, content: message, ts: "2026-07-25T00:00:02.000Z" },
				reply: {
					id: "a9",
					role: "assistant" as const,
					content: "好的",
					ts: "2026-07-25T00:00:03.000Z",
				},
				conversation: {
					id: "c1",
					title: "你好",
					createdAt: "2026-07-20T00:00:00.000Z",
					updatedAt: "2026-07-25T00:00:03.000Z",
					messageCount: 8,
					// 老文件里没有这个字段。
				},
			};
		});
		useAiChatStore.setState({ activeId: "c1" });
		render(wrap(<ChatPage />));
		const ta = await screen.findByLabelText("聊天输入");
		fireEvent.change(ta, { target: { value: "再问一句" } });
		fireEvent.keyDown(ta, { key: "Enter" });

		await waitFor(() => expect(vi.mocked(retitleConversation)).toHaveBeenCalled());
	});

	it("已经起过名字的会话不再要 —— 路标不该被反复挪", async () => {
		useAiChatStore.setState({ activeId: "c1" });
		await sendOnce("你好");
		await waitFor(() => expect(vi.mocked(retitleConversation)).toHaveBeenCalledTimes(1));

		// 第二轮:服务端回的 messageCount 已经不是 2 了。
		vi.mocked(sendChatMessage).mockImplementationOnce(async (_id, message) => ({
			user: { id: "u2", role: "user", content: message, ts: "2026-07-25T00:00:02.000Z" },
			reply: { id: "a2", role: "assistant", content: "好", ts: "2026-07-25T00:00:03.000Z" },
			conversation: {
				id: "c1",
				title: "本周勤奋榜",
				createdAt: "2026-07-25T00:00:00.000Z",
				updatedAt: "2026-07-25T00:00:03.000Z",
				messageCount: 4,
				// 第一轮已经起过名字了,服务端在这里回 true。
				autoTitled: true,
			},
		}));
		const ta = screen.getByLabelText("聊天输入");
		fireEvent.change(ta, { target: { value: "再问一句" } });
		fireEvent.keyDown(ta, { key: "Enter" });

		await waitFor(() => expect(screen.queryByLabelText(/正在思考/)).toBeNull());
		expect(vi.mocked(retitleConversation)).toHaveBeenCalledTimes(1);
	});

	it("起名失败不打扰主人 —— 刚聊完的界面上不该冒红字", async () => {
		vi.mocked(retitleConversation).mockRejectedValueOnce(new Error("402 余额不足"));
		useAiChatStore.setState({ activeId: "c1" });
		await sendOnce("你好");
		await waitFor(() => expect(vi.mocked(retitleConversation)).toHaveBeenCalled());
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("AiChatDock — 设置弹层里的玻璃质感两项", () => {
	async function openSettings() {
		render(wrap(<ChatPage />));
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
		activeProfile: "deepseek",
		providers: { deepseek: { model: "gpt-test" } },
		persona: { name: "凛子", addressSelf: "本小姐", addressUser: "笨蛋" },
	};

	it("侧栏标题用配置里的名字,不是设计稿的「小铃」", async () => {
		render(wrap(<ChatPage />));
		await waitFor(() => expect(screen.getByText(/女仆AI · 小绫/)).toBeTruthy());
		expect(screen.queryByText(/小铃/)).toBeNull();
	});

	it("输入框 placeholder 也用配置里的名字", async () => {
		G.ai = RINKO;
		render(wrap(<ChatPage />));
		await waitFor(() =>
			expect(screen.getByLabelText("聊天输入").getAttribute("placeholder")).toContain(
				"给凛子发消息",
			),
		);
	});

	it("空态那句问候用「自称 + 对主人的称呼」,两处都跟着人格变", async () => {
		G.ai = RINKO;
		render(wrap(<ChatPage />));
		await waitFor(() => expect(screen.getByText(/今天想让本小姐帮笨蛋做点什么呢/)).toBeTruthy());
	});

	it("没登录时问候语里的称呼回落到人格的 addressUser,不硬写「主人」", async () => {
		G.ai = RINKO;
		useAuthStore.setState({ snapshot: null } as never);
		render(wrap(<ChatPage />));
		// getAll:问候语和侧栏底部各显示一次称呼,两处都该跟着人格走。
		await waitFor(() => expect(screen.getAllByText("笨蛋").length).toBeGreaterThanOrEqual(2));
		expect(screen.queryByText("主人")).toBeNull();
	});

	/**
	 * 名字得跟着**指针**走,不是跟着 `ai.persona` 走。
	 *
	 * `ai.persona` 自人格指针上线就没有界面入口了,永远冻在老值上。直读它的话,
	 * 主人在「智能女仆」页换成谁,聊天窗抬头都还写着原来那位 —— 而她开口自称的
	 * 又是新那位(那一侧走的是后端 resolve),两边对不上。
	 */
	it("换了人格 → 抬头跟着指针指的那份走,不是冻着的 ai.persona", async () => {
		G.ai = {
			activeProfile: "deepseek",
			providers: { deepseek: { model: "gpt-test" } },
			persona: { name: "小绫", addressSelf: "小绫", addressUser: "主人" },
			activePreset: "tsundere",
			presets: [
				{ id: "gentle-maid", label: "温柔女仆", persona: { name: "小绫" } },
				{
					id: "tsundere",
					label: "傲娇毒舌",
					persona: { name: "凛子", addressSelf: "本小姐", addressUser: "笨蛋" },
				},
			],
		};
		render(wrap(<ChatPage />));
		await waitFor(() => expect(screen.getByText(/女仆AI · 凛子/)).toBeTruthy());
	});

	it("人格里名字被清空 → 回落成「女仆」,不显示空白", async () => {
		G.ai = {
			activeProfile: "deepseek",
			providers: { deepseek: { model: "gpt-test" } },
			persona: { name: "", addressSelf: "", addressUser: "" },
		};
		render(wrap(<ChatPage />));
		await waitFor(() => expect(screen.getByText(/女仆AI · 女仆/)).toBeTruthy());
	});

	it("底部显示配置里的模型名", async () => {
		render(wrap(<ChatPage />));
		await waitFor(() => expect(screen.getByText("gpt-test")).toBeTruthy());
	});
});

describe("AiChatDock — 侧栏与主题", () => {
	it("收起侧栏后换成展开按钮", async () => {
		render(wrap(<ChatPage />));
		screen.getByLabelText("收起侧栏").click();
		await waitFor(() => expect(screen.getByLabelText("打开侧栏")).toBeTruthy());
		expect(screen.queryByLabelText("收起侧栏")).toBeNull();
	});

	it("四色预设已砍:chat 根不再有 data-chat-theme,设置弹层里也没有主题色节", async () => {
		render(wrap(<ChatPage />));
		const dialog = screen.getByRole("region", { name: "女仆 AI 聊天" });
		expect(dialog.getAttribute("data-chat-theme")).toBeNull();

		screen.getByLabelText("聊天设置").click();
		await waitFor(() => expect(screen.getByText("玻璃质感")).toBeTruthy());
		expect(screen.queryByText("主题色")).toBeNull();
	});

	it("一次都没聊过时侧栏给一句引导,不是空白", async () => {
		render(wrap(<ChatPage />));
		await waitFor(() => expect(screen.getByText(/还没有聊过天呢/)).toBeTruthy());
	});

	it("有真头像就显示头像,并带 no-referrer(B 站图床按 Referer 防盗链)", async () => {
		useAuthStore.setState({
			snapshot: {
				status: BiliLoginStatus.LOGGED_IN,
				data: { card: { name: "晨风UP主", face: "https://i0.hdslb.com/face.jpg" } },
			},
		} as never);
		render(wrap(<ChatPage />));

		const img = await screen.findByAltText("晨风UP主");
		expect(img.getAttribute("src")).toBe("https://i0.hdslb.com/face.jpg");
		// 不带这条,B 站会回一张 403 占位图,头像位置变成裂图。
		expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
	});

	it("取不到头像 → 回落成首字色块,不留一个空洞", async () => {
		useAuthStore.setState({
			snapshot: { status: BiliLoginStatus.LOGGED_IN, data: { card: { name: "晨风UP主" } } },
		} as never);
		render(wrap(<ChatPage />));

		await waitFor(() => expect(screen.getAllByText("晨").length).toBeGreaterThan(0));
		expect(screen.queryByAltText("晨风UP主")).toBeNull();
	});

	it("有会话时按今天 / 昨天分组列出来", async () => {
		const today = new Date().toISOString();
		H.conversations = [
			{ id: "c1", title: "本周谁最勤奋", createdAt: today, updatedAt: today, messageCount: 2 },
		];
		render(wrap(<ChatPage />));
		await waitFor(() => expect(screen.getByText("本周谁最勤奋")).toBeTruthy());
		expect(screen.getByText("今天")).toBeTruthy();
	});
});
