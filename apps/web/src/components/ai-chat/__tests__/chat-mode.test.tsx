// @vitest-environment jsdom
/**
 * 聊天页的**面孔**:模式(日常聊天 / 皮肤工坊)与人格开关。
 *
 * 主人拍板改成**开局锁定**:面孔在会话诞生那一刻定死,整场不再改。落到界面上是
 * 三件事 —— 聊天框里不再有模式 picker、模式改由侧栏那两个入口决定、人格那一档
 * 只在还没开口的空态里选一次。
 *
 * 为什么锁死而不是随手切:做皮肤那把**写工具**只在皮肤工坊里存在,日常聊天那个
 * 窗口(上下文里混着 B 站动态正文、图片里的字这些外部可控文本)保持只读。让每条
 * 消息决定模式,等于把开那道口子的钥匙交给每一条消息。服务端那一侧的同款契约在
 * apps/server/src/routes/__tests__/ai-chat-skin-tool.test.ts。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const H = vi.hoisted(() => ({
	/** 最后一次发送带的 flags。 */
	lastFlags: null as Record<string, unknown> | null,
	/** 最后一次建会话时定下的面孔。 */
	lastInit: undefined as Record<string, unknown> | undefined,
	/** 当前会话读回来的样子 —— 用例按需改它来摆出「这是一场工坊会话」。 */
	conv: { mode: "chat", persona: true, messages: [] } as Record<string, unknown>,
}));

vi.mock("../../../services/aiChat", async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const AT = "2026-08-19T00:00:00.000Z";
	const msg = (role: string, content: string) => ({ id: `${role}1`, role, content, ts: AT });
	return {
		...actual,
		listConversations: vi.fn(async () => ({ conversations: [] })),
		getConversation: vi.fn(async (id: string) => ({
			id,
			title: "t",
			createdAt: AT,
			updatedAt: AT,
			messageCount: 0,
			...H.conv,
		})),
		createConversation: vi.fn(async (init?: Record<string, unknown>) => {
			H.lastInit = init;
			return {
				id: "c1",
				title: "新对话",
				createdAt: AT,
				updatedAt: AT,
				messageCount: 0,
				messages: [],
				mode: init?.mode ?? "chat",
				persona: init?.persona ?? true,
			};
		}),
		retitleConversation: vi.fn(async (id: string) => ({
			id,
			title: "做皮肤",
			createdAt: AT,
			updatedAt: AT,
			messageCount: 2,
		})),
		sendChatMessage: vi.fn(
			async (
				_id: string,
				message: string,
				h: { onDelta: (t: string) => void },
				_images?: readonly string[],
				flags?: Record<string, unknown>,
			) => {
				H.lastFlags = flags ?? null;
				h.onDelta("好的");
				return {
					user: msg("user", message),
					reply: msg("assistant", "好的"),
					conversation: {
						id: "c1",
						title: message,
						createdAt: AT,
						updatedAt: AT,
						messageCount: 2,
					},
				};
			},
		),
	};
});

vi.mock("../../../services/api", () => ({
	api: {
		get: vi.fn(async () => ({
			defaults: {
				ai: {
					activeProfile: "deepseek",
					providers: { deepseek: { model: "gpt-test" } },
					persona: { name: "小绫", addressSelf: "小绫", addressUser: "主人" },
					// 搜索后端配好了,那颗胶囊才画得出来 —— 没有它 SearchControl
					// 自己就返回 null,断言「它还在」会假绿。
					search: { backend: "bocha", keys: { bocha: "sk-x" } },
				},
			},
		})),
	},
}));

import { useAiChatStore } from "../../../store/aiChat";
import { ChatPage } from "../index";
import { AI_SKILLS } from "../skills";

function wrap(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/chat"]}>{node}</MemoryRouter>
		</QueryClientProvider>
	);
}

/** 空态 = 还没开口的新对话,面孔这时才选得动。 */
function mountFresh() {
	useAiChatStore.setState({ rail: true, activeId: null });
	render(wrap(<ChatPage />));
}

/** 已经聊过的会话 —— 面孔已锁。 */
function mountOngoing(conv: Record<string, unknown> = {}) {
	H.conv = {
		mode: "chat",
		persona: true,
		messages: [{ id: "u0", role: "user", content: "在吗", ts: "2026-08-19T00:00:00.000Z" }],
		...conv,
	};
	useAiChatStore.setState({ rail: true, activeId: "c1" });
	render(wrap(<ChatPage />));
}

async function send(text: string) {
	const ta = await screen.findByLabelText("聊天输入");
	fireEvent.change(ta, { target: { value: text } });
	fireEvent.keyDown(ta, { key: "Enter" });
}

const tab = (name: string) => screen.queryByRole("tab", { name });

beforeEach(() => {
	H.lastFlags = null;
	H.lastInit = undefined;
	H.conv = { mode: "chat", persona: true, messages: [] };
});
afterEach(cleanup);

describe("聊天框里不再有模式 picker", () => {
	it("空态没有", async () => {
		mountFresh();
		await screen.findByLabelText("聊天输入");
		expect(tab("皮肤工坊")).toBeNull();
		expect(tab("聊天")).toBeNull();
	});

	it("聊到一半更没有 —— 锁定的意思就是这场改不了", async () => {
		mountOngoing();
		await screen.findByLabelText("聊天输入");
		expect(tab("皮肤工坊")).toBeNull();
	});

	it("这一问不再驮 mode —— 模式归会话所有,请求体说了不算", async () => {
		mountFresh();
		await send("在吗");

		await waitFor(() => expect(H.lastFlags).not.toBeNull());
		expect(H.lastFlags).not.toHaveProperty("mode");
	});
});

describe("人格那一档:空态选一次", () => {
	it("空态摆着两段,默认停在有人格", async () => {
		mountFresh();
		await screen.findByLabelText("聊天输入");

		expect(tab("有人格")?.getAttribute("aria-selected")).toBe("true");
		expect(tab("无人格")?.getAttribute("aria-selected")).toBe("false");
	});

	it("选了无人格 → 会话就以那一档建起来", async () => {
		mountFresh();
		await screen.findByLabelText("聊天输入");
		fireEvent.click(tab("无人格") as HTMLElement);
		await send("查一下咩栗");

		await waitFor(() => expect(H.lastInit).toBeDefined());
		expect(H.lastInit).toMatchObject({ mode: "chat", persona: false });
	});

	it("聊过之后不再出现 —— 开局那一次就是全部机会", async () => {
		mountOngoing();
		// 等历史消息真的上屏:会话详情还在路上时页面仍是空态,这时断言等于什么都没测。
		await screen.findByText("在吗");
		expect(tab("有人格")).toBeNull();
		expect(tab("无人格")).toBeNull();
	});
});

describe("侧栏那两个入口决定模式", () => {
	it("点「新建皮肤工坊」→ 空态换成工坊的样子,人格那一档不再摆(那条路本来就没有人格)", async () => {
		mountFresh();
		await screen.findByLabelText("聊天输入");
		fireEvent.click(screen.getByRole("button", { name: /新建皮肤工坊/ }));

		// 空态副标题换成工坊那句。别拿「界面皮肤」当锚 —— `/皮肤` 那枚技能胶囊上
		// 也有这四个字,查出来是两个元素。
		await waitFor(() => expect(screen.queryByText(/想要什么样的界面皮肤/)).not.toBeNull());
		expect(tab("有人格")).toBeNull();
	});

	it("工坊空态发出的第一句 → 会话以 skin 建起来", async () => {
		mountFresh();
		await screen.findByLabelText("聊天输入");
		fireEvent.click(screen.getByRole("button", { name: /新建皮肤工坊/ }));
		await send("做套暗色的");

		await waitFor(() => expect(H.lastInit).toBeDefined());
		expect(H.lastInit).toMatchObject({ mode: "skin" });
	});
});

describe("聊天空态那排胶囊", () => {
	it("不摆「做皮肤」那条 —— 它在这里点了做不到", async () => {
		// 胶囊发的是技能的 `prompt`(一整段自然语言),而认技能靠的是「整条输入
		// 恰好等于 cmd」。于是 `mode: "skin"` 在这条路上根本传不出去:点下去就是
		// 在只读的聊天窗口里说了句「帮我做套皮肤」,女仆答应下来然后什么也做不出来。
		// 进工坊的正经入口在侧栏那颗「新建皮肤工坊」。
		mountFresh();
		await screen.findByLabelText("聊天输入");
		expect(screen.queryByRole("button", { name: /做一套界面皮肤/ })).toBeNull();
		// 别的胶囊照旧在 —— 这不是把整排收掉。
		expect(screen.queryByRole("button", { name: /鸽王/ })).not.toBeNull();
	});

	it("规矩按「要换面孔」来定,不是按名字点名", async () => {
		// 将来再加一条带 mode 的技能,它同样传不出面孔 —— 判据写在字段上,
		// 加人的时候不必再想起这件事。
		mountFresh();
		await screen.findByLabelText("聊天输入");
		for (const s of AI_SKILLS.filter((x) => x.mode)) {
			expect(screen.queryByRole("button", { name: new RegExp(s.desc) })).toBeNull();
		}
	});
});

describe("/皮肤 技能", () => {
	it("在聊天会话里用 → 另开一场工坊会话,而不是在只读窗口里空转", async () => {
		// 做皮肤那把工具只在工坊里挂着。以前它靠切模式解决,现在模式锁死 ——
		// 那就得另开一场,否则女仆会答应下来然后什么也做不出来。
		mountOngoing();
		// 先等这场对话真的上屏 —— 详情还在路上时页面是空态,那时的面孔是「待建」
		// 那一份,测的就不是「在已锁定的聊天会话里用技能」了。
		await screen.findByText("在吗");
		const ta = await screen.findByLabelText("聊天输入");
		fireEvent.change(ta, { target: { value: "/皮肤" } });
		// 打斜杠命令时菜单是展开的:第一下回车**选中技能**,第二下才是发送。
		fireEvent.keyDown(ta, { key: "Enter" });
		fireEvent.keyDown(await screen.findByLabelText("聊天输入"), { key: "Enter" });

		await waitFor(() => expect(H.lastInit).toBeDefined());
		expect(H.lastInit).toMatchObject({ mode: "skin" });
	});
});

describe("两颗胶囊照旧", () => {
	it("工坊里也有联网搜索 —— 做二次元皮肤得先查得到那部作品的配色", async () => {
		mountOngoing({ mode: "skin" });
		expect(await screen.findByLabelText("联网搜索")).toBeTruthy();
	});

	it("开了搜索,这一问就带 search: true", async () => {
		mountOngoing({ mode: "skin" });
		fireEvent.click(await screen.findByLabelText("联网搜索"));
		await send("做套初音未来风格的");

		await waitFor(() => expect(H.lastFlags).not.toBeNull());
		expect(H.lastFlags?.search).toBe(true);
	});
});
