// @vitest-environment jsdom
/**
 * 聊天里做完一套皮肤 → 界面立刻跟上。
 *
 * `create_skin` 是女仆手上唯一会**改到界面本身**的工具:她可能顺手就替主人换上了。
 * 而 SkinRoot 只在登录状态变化时拉一次 active 槽 —— 不在这儿补一拍,主人会看到
 * 女仆说「已经换上啦」而屏幕纹丝不动,直到手动刷新。
 *
 * 补的这一拍必须**认工具、认成败**:别的工具跑完、或者这一套压根没做成,都不该
 * 白拉一趟接口。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const H = vi.hoisted(() => ({
	/** 这一轮要吐的工具事件(在正文之前),与真实顺序一致。 */
	toolEvents: [] as Array<Record<string, unknown>>,
	/** api.get 收到过的路径。 */
	gets: [] as string[],
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
			title: "做套皮肤",
			createdAt: "2026-08-17T00:00:00.000Z",
			updatedAt: "2026-08-17T00:00:00.000Z",
			messageCount: 2,
		})),
		sendChatMessage: vi.fn(
			async (
				_id: string,
				message: string,
				h: { onDelta: (t: string) => void; onTool?: (ev: Record<string, unknown>) => void },
			) => {
				for (const ev of H.toolEvents) h.onTool?.(ev);
				h.onDelta("做好啦");
				return {
					user: msg("user", message),
					reply: msg("assistant", "做好啦"),
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

const ACTIVE = {
	light: null,
	dark: { id: "s1", manifest: { schemaVersion: 1, name: "夜航灯", modes: { dark: {} } } },
};

vi.mock("../../../services/api", () => ({
	api: {
		get: vi.fn(async (path: string) => {
			H.gets.push(path);
			if (path === "/api/skins/active") return { active: ACTIVE };
			return {
				defaults: {
					ai: {
						activeProfile: "deepseek",
						providers: { deepseek: { model: "gpt-test" } },
						persona: { name: "小绫", addressSelf: "小绫", addressUser: "主人" },
					},
				},
			};
		}),
	},
}));

import { useAiChatStore } from "../../../store/aiChat";
import { EMPTY_SLOTS, useSkinStore } from "../../../store/skin";
import { ChatPage } from "../index";

function wrap(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/chat"]}>{node}</MemoryRouter>
		</QueryClientProvider>
	);
}

async function typeAndSend(text: string) {
	useAiChatStore.setState({ rail: true, activeId: "c1" });
	render(wrap(<ChatPage />));
	const ta = await screen.findByLabelText("聊天输入");
	fireEvent.change(ta, { target: { value: text } });
	fireEvent.keyDown(ta, { key: "Enter" });
}

const skinGets = () => H.gets.filter((p) => p === "/api/skins/active");

beforeEach(() => {
	H.toolEvents = [];
	H.gets = [];
	useSkinStore.setState({ active: EMPTY_SLOTS, preview: null });
});
afterEach(cleanup);

describe("create_skin 跑完 → 皮肤状态回灌", () => {
	it("做成了 → 重新拉一次 active 槽,store 跟着换装", async () => {
		H.toolEvents = [
			{ phase: "start", id: "t1", name: "create_skin", args: { brief: "赛博朋克" } },
			{ phase: "end", id: "t1", ok: true },
		];
		await typeAndSend("给我做套皮肤");

		await waitFor(() => expect(skinGets()).toHaveLength(1));
		await waitFor(() => expect(useSkinStore.getState().active.dark?.id).toBe("s1"));
	});

	it("这一套没做成 → 不白拉一趟", async () => {
		H.toolEvents = [
			{ phase: "start", id: "t1", name: "create_skin", args: { brief: "赛博朋克" } },
			{ phase: "end", id: "t1", ok: false },
		];
		await typeAndSend("给我做套皮肤");

		await screen.findByText("做好啦");
		expect(skinGets()).toHaveLength(0);
	});

	it("别的工具跑完 → 不碰皮肤", async () => {
		H.toolEvents = [
			{ phase: "start", id: "t1", name: "web_search", args: { query: "皮肤" } },
			{ phase: "end", id: "t1", ok: true },
		];
		await typeAndSend("搜一下");

		await screen.findByText("做好啦");
		expect(skinGets()).toHaveLength(0);
	});
});
