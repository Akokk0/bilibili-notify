// @vitest-environment jsdom
/**
 * 聊天页的模式切换 —— 日常聊天 / 皮肤工坊。
 *
 * 隔离是主人拍板的:做皮肤那把写工具只在皮肤工坊里存在,日常聊天那个窗口(上下文
 * 里混着 B 站动态正文、图片里的字这些外部可控文本)保持只读。界面这一侧要守住的是
 * 三件事:**默认在聊天模式**、切过去之后**这一问真的带上 mode**、以及**换会话回到
 * 默认** —— 模式和思考 / 搜索两颗胶囊一样不落盘,悄悄留在皮肤模式里会让主人下一次
 * 打开聊天时对着一个不认识 B 站数据的女仆发问。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const H = vi.hoisted(() => ({
	/** 最后一次发送带的 flags。 */
	lastFlags: null as Record<string, unknown> | null,
}));

vi.mock("../../../services/aiChat", async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const msg = (role: string, content: string) => ({
		id: `${role}1`,
		role,
		content,
		ts: "2026-08-17T00:00:00.000Z",
	});
	return {
		...actual,
		listConversations: vi.fn(async () => ({ conversations: [] })),
		getConversation: vi.fn(async (id: string) => ({
			id,
			title: "t",
			createdAt: "2026-08-17T00:00:00.000Z",
			updatedAt: "2026-08-17T00:00:00.000Z",
			messageCount: 0,
			messages: [],
		})),
		createConversation: vi.fn(async () => ({
			id: "c1",
			title: "新对话",
			createdAt: "2026-08-17T00:00:00.000Z",
			updatedAt: "2026-08-17T00:00:00.000Z",
			messageCount: 0,
			messages: [],
		})),
		retitleConversation: vi.fn(async (id: string) => ({
			id,
			title: "做皮肤",
			createdAt: "2026-08-17T00:00:00.000Z",
			updatedAt: "2026-08-17T00:00:00.000Z",
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
						createdAt: "2026-08-17T00:00:00.000Z",
						updatedAt: "2026-08-17T00:00:01.000Z",
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
					// 搜索后端配好了,聊天模式下那颗胶囊才画得出来 —— 没有它
					// SearchControl 自己就返回 null,断言「皮肤模式下没有」会假绿。
					search: { backend: "bocha", keys: { bocha: "sk-x" } },
				},
			},
		})),
	},
}));

import { useAiChatStore } from "../../../store/aiChat";
import { ChatPage } from "../index";

function wrap(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/chat"]}>{node}</MemoryRouter>
		</QueryClientProvider>
	);
}

function mount() {
	useAiChatStore.setState({ rail: true, activeId: "c1" });
	render(wrap(<ChatPage />));
}

async function send(text: string) {
	const ta = await screen.findByLabelText("聊天输入");
	fireEvent.change(ta, { target: { value: text } });
	fireEvent.keyDown(ta, { key: "Enter" });
}

const modeTab = (name: string) => screen.getByRole("tab", { name });

beforeEach(() => {
	H.lastFlags = null;
});
afterEach(cleanup);

describe("模式切换器", () => {
	it("两段都在,默认停在聊天", async () => {
		mount();
		await screen.findByLabelText("聊天输入");

		expect(modeTab("聊天").getAttribute("aria-selected")).toBe("true");
		expect(modeTab("皮肤工坊").getAttribute("aria-selected")).toBe("false");
	});

	it("默认发送就是聊天模式(请求体那一层的「不带 = 聊天」在 services 测试里钉)", async () => {
		mount();
		await send("在吗");

		await waitFor(() => expect(H.lastFlags).not.toBeNull());
		expect(H.lastFlags?.mode).toBe("chat");
	});

	it("切到皮肤工坊 → 这一问带 mode: skin", async () => {
		mount();
		await screen.findByLabelText("聊天输入");
		fireEvent.click(modeTab("皮肤工坊"));
		await send("做套暗色的");

		await waitFor(() => expect(H.lastFlags).not.toBeNull());
		expect(H.lastFlags?.mode).toBe("skin");
	});

	it("皮肤工坊里不显示联网搜索 —— 那个模式压根没挂搜索工具", async () => {
		mount();
		// 这颗胶囊要等 globals 到手才画得出来(没配后端时它自己返回 null)。
		await screen.findByLabelText("联网搜索");

		fireEvent.click(modeTab("皮肤工坊"));
		expect(screen.queryByLabelText("联网搜索")).toBeNull();
	});

	it("打 /皮肤 技能 → 自己切进皮肤工坊,这一问就带 skin", async () => {
		// 那条技能说的是「帮我做一套皮肤」,而聊天模式压根没挂做皮肤的工具 ——
		// 不跟着切模式的话,女仆会答应下来然后什么也做不出来。
		mount();
		const ta = await screen.findByLabelText("聊天输入");
		fireEvent.change(ta, { target: { value: "/皮肤" } });
		// 打斜杠命令时菜单是展开的:第一下回车**选中技能**(输入框变成「/皮肤 」),
		// 第二下才是发送。真实交互就是两下,少按一下这条测试会假红。
		fireEvent.keyDown(ta, { key: "Enter" });
		fireEvent.keyDown(await screen.findByLabelText("聊天输入"), { key: "Enter" });

		await waitFor(() => expect(H.lastFlags).not.toBeNull());
		expect(H.lastFlags?.mode).toBe("skin");
		expect(modeTab("皮肤工坊").getAttribute("aria-selected")).toBe("true");
	});

	it("换会话回到聊天模式 —— 模式不落盘,别把上一场的面孔带过来", async () => {
		mount();
		await screen.findByLabelText("聊天输入");
		fireEvent.click(modeTab("皮肤工坊"));
		expect(modeTab("皮肤工坊").getAttribute("aria-selected")).toBe("true");

		await act(async () => {
			useAiChatStore.setState({ activeId: "c2" });
		});
		await waitFor(() => expect(modeTab("聊天").getAttribute("aria-selected")).toBe("true"));
	});
});
