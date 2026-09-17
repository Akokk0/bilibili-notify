// @vitest-environment jsdom
/**
 * 消息流的「贴底」—— **只在主人本来就停在底部时**跟着新内容往下走。
 *
 * 2026-09-17 真机反馈:工坊里思考很长,主人往上翻着读,下一片思考一到就被拽回底部,
 * 「内容一直在向下扯」。原来那条 effect 每来一片就无条件 `scrollTop = scrollHeight`。
 *
 * jsdom 不排版:容器的 `scrollHeight` / `clientHeight` 由这里伪造,`scrollTop` 是真的
 * 可读写。思考分片由测试逐片放行,才看得到「翻上去之后又来了一片」那一刻。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const H = vi.hoisted(() => ({
	/** 容器内容总高,由测试在每片到来之前设好。 */
	height: 1000,
	/** 逐片放行的闸门。 */
	gate: [] as Array<() => void>,
}));

const AT = "2026-09-17T00:00:00.000Z";

vi.mock("../../../services/aiChat", async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	const msg = (id: string, role: string, content: string) => ({ id, role, content, ts: AT });
	const wait = () => new Promise<void>((r) => H.gate.push(r));
	return {
		...actual,
		listConversations: vi.fn(async () => ({
			conversations: ["一号", "二号"].map((title, i) => ({
				id: `c${i + 1}`,
				title,
				createdAt: AT,
				updatedAt: AT,
				messageCount: 1,
				mode: "chat",
				persona: true,
				skinTarget: "dashboard",
			})),
		})),
		getConversation: vi.fn(async (id: string) => ({
			id,
			title: "t",
			createdAt: AT,
			updatedAt: AT,
			messageCount: 1,
			mode: "chat",
			persona: true,
			skinTarget: "dashboard",
			messages: [msg("u0", "user", "在吗")],
		})),
		retitleConversation: vi.fn(async (id: string) => ({
			id,
			title: "t",
			createdAt: AT,
			updatedAt: AT,
			messageCount: 3,
		})),
		sendChatMessage: vi.fn(
			async (
				_id: string,
				message: string,
				h: { onDelta: (t: string) => void; onReasoning?: (t: string) => void },
			) => {
				await wait();
				h.onReasoning?.("第一段思考");
				await wait();
				h.onReasoning?.("第二段思考");
				await wait();
				h.onDelta("好的");
				await wait();
				return {
					user: msg("u1", "user", message),
					reply: msg("a1", "assistant", "好的"),
					conversation: { id: "c1", title: "t", createdAt: AT, updatedAt: AT, messageCount: 3 },
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
				},
			},
		})),
	},
}));

import { useAiChatStore } from "../../../store/aiChat";
import { ChatPage } from "../index";

const VIEW = 400;

/**
 * 伪造几何量挂在**原型**上、只认包着消息流的那个容器:换会话时界面会先回到空态,
 * 容器卸掉又重新挂上,挂在旧节点身上的伪造就跟着丢了。
 */
const isScroller = (el: Element): boolean =>
	el.firstElementChild?.getAttribute("data-testid") === "chat-messages";
beforeAll(() => {
	Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
		configurable: true,
		get(this: HTMLDivElement) {
			return isScroller(this) ? H.height : 0;
		},
	});
	Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
		configurable: true,
		get(this: HTMLDivElement) {
			return isScroller(this) ? VIEW : 0;
		},
	});
});
afterAll(() => {
	Reflect.deleteProperty(HTMLDivElement.prototype, "scrollHeight");
	Reflect.deleteProperty(HTMLDivElement.prototype, "clientHeight");
});

/** 消息流的滚动容器(当下挂着的那个)。 */
async function scroller(): Promise<HTMLElement> {
	return (await screen.findByTestId("chat-messages")).parentElement as HTMLElement;
}

/** 放行下一片,并让它落到界面上。 */
async function release(height: number): Promise<void> {
	H.height = height;
	await waitFor(() => expect(H.gate.length).toBeGreaterThan(0));
	await act(async () => {
		H.gate.shift()?.();
		await Promise.resolve();
	});
}

/** 主人用滚轮把视图停在某处。 */
function scrollTo(el: HTMLElement, top: number): void {
	el.scrollTop = top;
	fireEvent.scroll(el);
}

async function mountC1(): Promise<HTMLElement> {
	useAiChatStore.setState({ rail: true, activeId: "c1" });
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/chat"]}>
				<ChatPage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	await screen.findByText("在吗");
	return scroller();
}

async function send(text = "做一套卡片皮肤"): Promise<void> {
	const ta = await screen.findByLabelText("聊天输入");
	fireEvent.change(ta, { target: { value: text } });
	fireEvent.keyDown(ta, { key: "Enter" });
}

async function sendOne(): Promise<HTMLElement> {
	const el = await mountC1();
	await send();
	return el;
}

beforeEach(() => {
	H.height = 1000;
	H.gate = [];
});
afterEach(cleanup);

describe("消息流贴底", () => {
	it("停在底部时,思考往外长 → 跟着贴底", async () => {
		const el = await sendOne();
		await release(1500);
		await waitFor(() => expect(el.scrollTop).toBe(1500));
		await release(2000);
		await waitFor(() => expect(el.scrollTop).toBe(2000));
	});

	it("主人往上翻了 → 再来的思考不把他拽回底部", async () => {
		const el = await sendOne();
		await release(1500);
		await waitFor(() => expect(el.scrollTop).toBe(1500));

		scrollTo(el, 300);
		await release(2600);
		await screen.findByText(/第二段思考/);
		expect(el.scrollTop).toBe(300);
	});

	it("翻回底部 → 重新跟上", async () => {
		const el = await sendOne();
		await release(1500);
		scrollTo(el, 300);
		await release(2600);
		await screen.findByText(/第二段思考/);

		scrollTo(el, 2600 - VIEW);
		await release(3000);
		await waitFor(() => expect(el.scrollTop).toBe(3000));
	});

	it("翻上去之后又发了一句 → 回到底部看回复", async () => {
		const el = await sendOne();
		for (const h of [1500, 1600, 1700, 1800]) await release(h);
		await screen.findByText("好的");
		scrollTo(el, 100);

		await send("再改改");
		await release(2400);
		await waitFor(() => expect(el.scrollTop).toBe(2400));
	});

	it("翻上去之后换了一场对话 → 从底部看起", async () => {
		const el = await mountC1();
		scrollTo(el, 100);
		H.height = 1800;
		fireEvent.click(await screen.findByText("二号"));
		await waitFor(async () => expect((await scroller()).scrollTop).toBe(1800));
	});
});
