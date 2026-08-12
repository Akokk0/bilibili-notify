// @vitest-environment jsdom
/**
 * 发图这一跳 —— 附件 id 必须真的跟着请求走。
 *
 * 回归背景:图能选、能上传、能在输入框上方显示,发出去之后也照常挂在自己那条消息
 * 上(那份是 `onMutate` 里另存的本地副本) —— 唯独**服务端一张也没收到**。日志里
 * `[api] ... images=0`,女仆于是一本正经地说「小绫暂时还看不到图片呢」。
 *
 * 根因是 react-query 的一段时序:`onMutate` 里 `setAttachments([])` 把待发送列表
 * 清空,而 `mutationFn` 是**在那之后**才被调用的(`onMutate` 的返回值被 await,
 * 那一让步足够 React 把重渲染 flush 掉)。于是 `mutationFn` 拿到的已经是清空后那
 * 一次渲染的闭包,从里面读 `attachments` 只能读到空数组 —— 快照取晚了一拍。
 *
 * 所以 id 必须在**调用点**就算好、随 variables 一起递进去,而不是让 `mutationFn`
 * 回头去读组件状态。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/aiChat", async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	return {
		...actual,
		listConversations: vi.fn(async () => ({ conversations: [] })),
		getConversation: vi.fn(async (id: string) => ({
			id,
			title: "t",
			createdAt: "2026-07-24T00:00:00.000Z",
			updatedAt: "2026-07-24T00:00:00.000Z",
			messageCount: 0,
			messages: [],
		})),
		createConversation: vi.fn(async () => ({
			id: "c1",
			title: "新对话",
			createdAt: "2026-07-24T00:00:00.000Z",
			updatedAt: "2026-07-24T00:00:00.000Z",
			messageCount: 0,
			messages: [],
		})),
		retitleConversation: vi.fn(async (id: string) => ({
			id,
			title: "t",
			createdAt: "2026-07-24T00:00:00.000Z",
			updatedAt: "2026-07-24T00:00:00.000Z",
			messageCount: 2,
		})),
		uploadChatImage: vi.fn(async () => "aabbccddeeff00112233445566778899.png"),
		sendChatMessage: vi.fn(async (_id: string, message: string) => {
			const user = { id: "u1", role: "user", content: message, ts: "2026-07-25T00:00:00.000Z" };
			const reply = { id: "a1", role: "assistant", content: "好", ts: "2026-07-25T00:00:01.000Z" };
			return {
				user,
				reply,
				conversation: {
					id: "c1",
					title: message,
					createdAt: "2026-07-25T00:00:00.000Z",
					updatedAt: "2026-07-25T00:00:01.000Z",
					messageCount: 2,
					autoTitled: true,
				},
			};
		}),
	};
});

vi.mock("../../../services/api", () => ({
	api: {
		get: vi.fn(async () => ({
			defaults: {
				ai: {
					provider: "deepseek",
					providers: { deepseek: { model: "deepseek-v4-flash" } },
					persona: { name: "小绫", addressSelf: "小绫", addressUser: "主人" },
				},
			},
		})),
	},
}));

import { sendChatMessage, uploadChatImage } from "../../../services/aiChat";
import { DEFAULT_GLASS_OPACITY, useAiChatStore } from "../../../store/aiChat";
import { ChatPage } from "../index";

const ASSET_ID = "aabbccddeeff00112233445566778899.png";

/** ChatPage 用 useNavigate / useLocation,得裹在 Router 里;这份测试不关心来路。 */
function wrap(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<MemoryRouter>{node}</MemoryRouter>
		</QueryClientProvider>
	);
}

/** 选一张图并等它传完(传完才会出现「移除图片」那颗按钮)。 */
async function attachOne(container: HTMLElement) {
	const input = container.querySelector<HTMLInputElement>('input[type="file"]');
	if (!input) throw new Error("找不到文件选择框");
	fireEvent.change(input, {
		target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
	});
	await waitFor(() => expect(vi.mocked(uploadChatImage)).toHaveBeenCalled());
	await screen.findByLabelText("移除图片");
}

/** 最后一次发送带上的图片 id 列表。 */
function sentImageIds(): readonly string[] | undefined {
	const call = vi.mocked(sendChatMessage).mock.calls.at(-1);
	return call?.[3];
}

beforeEach(() => {
	vi.mocked(sendChatMessage).mockClear();
	vi.mocked(uploadChatImage).mockClear();
	useAiChatStore.setState({
		rail: true,
		theme: "lime",
		activeId: null,
		glassOpacity: DEFAULT_GLASS_OPACITY,
		glassClear: false,
	});
});

afterEach(cleanup);

describe("AiChatDock — 发图", () => {
	it("附件 id 跟着请求一起走 —— 不跟着走的话服务端一张也收不到", async () => {
		const { container } = render(wrap(<ChatPage />));
		await attachOne(container);

		fireEvent.change(await screen.findByLabelText("聊天输入"), {
			target: { value: "这张图是什么" },
		});
		fireEvent.click(screen.getByLabelText("发送"));

		await waitFor(() => expect(vi.mocked(sendChatMessage)).toHaveBeenCalledTimes(1));
		expect(sentImageIds()).toEqual([ASSET_ID]);
	});

	it("一个字没打、只有图也发得出去 —— 图本身就是问题", async () => {
		const { container } = render(wrap(<ChatPage />));
		await attachOne(container);

		fireEvent.click(screen.getByLabelText("发送"));

		await waitFor(() => expect(vi.mocked(sendChatMessage)).toHaveBeenCalledTimes(1));
		expect(sentImageIds()).toEqual([ASSET_ID]);
	});

	it("没挑图时不带 images 字段 —— 纯文字那一问不该平白多一个空数组", async () => {
		render(wrap(<ChatPage />));

		fireEvent.change(await screen.findByLabelText("聊天输入"), { target: { value: "在吗" } });
		fireEvent.click(screen.getByLabelText("发送"));

		await waitFor(() => expect(vi.mocked(sendChatMessage)).toHaveBeenCalledTimes(1));
		expect(sentImageIds() ?? []).toHaveLength(0);
	});

	it("发送失败 → 图退回待发送列表,不用重挑一遍", async () => {
		// 发图最常见的失败就是「这家没配看图能力」,服务端当场 400 并指路 ——
		// 那是去设置页点一下就能好的事,却要主人回来重挑一遍图,纯属白丢。
		vi.mocked(sendChatMessage).mockRejectedValueOnce(new Error("女仆还看不见图片"));
		const { container } = render(wrap(<ChatPage />));
		await attachOne(container);

		fireEvent.change(await screen.findByLabelText("聊天输入"), { target: { value: "这张图" } });
		fireEvent.click(screen.getByLabelText("发送"));

		// 报错是拼进一整句话里的(「呜…小绫出错了:…」),所以按片段找。
		await waitFor(() => expect(screen.getAllByText(/女仆还看不见图片/).length).toBeGreaterThan(0));
		expect(await screen.findByLabelText("移除图片")).toBeTruthy();
		// 正文也照旧退回输入框 —— 按个回车就能重试。
		const box = (await screen.findByLabelText("聊天输入")) as HTMLTextAreaElement;
		expect(box.value).toBe("这张图");
	});

	it("发完之后待发送列表清空 —— 下一问不该把上一问的图再带一遍", async () => {
		const { container } = render(wrap(<ChatPage />));
		await attachOne(container);

		fireEvent.change(await screen.findByLabelText("聊天输入"), { target: { value: "第一问" } });
		fireEvent.click(screen.getByLabelText("发送"));
		await waitFor(() => expect(vi.mocked(sendChatMessage)).toHaveBeenCalledTimes(1));

		fireEvent.change(await screen.findByLabelText("聊天输入"), { target: { value: "第二问" } });
		fireEvent.click(screen.getByLabelText("发送"));
		await waitFor(() => expect(vi.mocked(sendChatMessage)).toHaveBeenCalledTimes(2));
		expect(sentImageIds() ?? []).toHaveLength(0);
	});
});
