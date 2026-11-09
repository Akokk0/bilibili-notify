// @vitest-environment jsdom
/**
 * 侧栏里的「面孔」—— 两个新建入口 + 每一行的 label。
 *
 * 模式由主人拍板改成**开局锁定**:选定之后整场不再改,聊天框里那个 picker 撤掉。
 * 那么选的动作就得挪到「新建」这一刻 —— 侧栏拆成两个入口,一个开日常聊天、一个
 * 开皮肤工坊。列表那一行跟着标出来:一屋子会话摆在一起,认不出哪场是工坊的话,
 * 主人只能挨个点进去看。
 *
 * label 刻意**只标非默认的那一档**:默认(聊天 + 有人格)不挂牌,否则一列全是标签,
 * 真正特殊的那几行反而淹了。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import type { AiConversationMetaView } from "../../../services/aiChat";
import { ChatSidebar } from "../sidebar";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(async () => ({ ai: {} })), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

const AT = "2026-08-19T00:00:00.000Z";
function conv(over: Partial<AiConversationMetaView>): AiConversationMetaView {
	return {
		id: "x",
		title: "会话",
		createdAt: AT,
		updatedAt: AT,
		messageCount: 2,
		mode: "chat",
		skinTarget: "dashboard",
		persona: true,
		...over,
	};
}

function mount(props: {
	conversations?: AiConversationMetaView[];
	onNew?: (m: "chat" | "skin") => void;
	onSelect?: (id: string) => void;
	onDelete?: (id: string) => void;
}) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<ChatSidebar
				conversations={props.conversations ?? []}
				activeId={null}
				onSelect={props.onSelect ?? (() => {})}
				onNew={props.onNew ?? (() => {})}
				onDelete={props.onDelete ?? (() => {})}
				onCollapse={() => {}}
				userName="主人"
				aiName="伦伦"
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
afterEach(cleanup);

it("sidebar actions and workshop labels translate while conversation titles and IDs stay original", () => {
	i18n.set({ locale: "en", voice: "plain" });
	const onSelect = vi.fn(),
		onDelete = vi.fn(),
		onNew = vi.fn();
	mount({
		conversations: [
			conv({ id: "original-id", title: "原始会话", mode: "skin", skinTarget: "card" }),
		],
		onSelect,
		onDelete,
		onNew,
	});
	const title = screen.getByText("原始会话");
	const row = title.closest("button");
	if (!row) throw new Error("conversation has no selection button");
	row.focus();
	for (const [locale, label, start, remove] of [
		["en", "Card workshop", "New chat", "Delete conversation “原始会话”"],
		["ja", "カード工房", "新しいチャット", "会話「原始会话」を削除"],
		["zh-TW", "卡片工坊", "開啟新對話", "刪除對話「原始会话」"],
		["en", "Card workshop", "New chat", "Delete conversation “原始会话”"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByText(label)).toBeTruthy();
		expect(screen.getByRole("button", { name: start })).toBeTruthy();
		expect(screen.getByRole("button", { name: remove })).toBeTruthy();
		expect(document.activeElement).toBe(row);
		expect(screen.getByText("原始会话")).toBe(title);
		expect(onSelect).not.toHaveBeenCalled();
		expect(onDelete).not.toHaveBeenCalled();
		expect(onNew).not.toHaveBeenCalled();
	}
	fireEvent.click(title);
	fireEvent.click(screen.getByRole("button", { name: "Delete conversation “原始会话”" }));
	fireEvent.click(screen.getByRole("button", { name: "New skin workshop" }));
	expect(onSelect).toHaveBeenCalledExactlyOnceWith("original-id");
	expect(onDelete).toHaveBeenCalledExactlyOnceWith("original-id");
	expect(onNew).toHaveBeenCalledExactlyOnceWith("skin");
});

describe("两个新建入口", () => {
	it("日常聊天与皮肤工坊各有一颗按钮", () => {
		mount({});
		expect(screen.getByRole("button", { name: /开启新对话/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /皮肤工坊/ })).toBeTruthy();
	});

	it("点哪颗就开哪种面孔的会话 —— 模式在这一刻定死", () => {
		const onNew = vi.fn();
		mount({ onNew });

		fireEvent.click(screen.getByRole("button", { name: /开启新对话/ }));
		expect(onNew).toHaveBeenLastCalledWith("chat");

		fireEvent.click(screen.getByRole("button", { name: /皮肤工坊/ }));
		expect(onNew).toHaveBeenLastCalledWith("skin");
	});
});

describe("会话行的 label", () => {
	it("皮肤工坊的会话标出来", () => {
		mount({ conversations: [conv({ id: "s", title: "做套雷姆皮肤", mode: "skin" })] });
		expect(screen.getByText("工坊")).toBeTruthy();
	});

	it("卡片工坊的会话标成「卡片工坊」,与界面皮肤那种分得开", () => {
		mount({
			conversations: [
				conv({ id: "c", title: "樱花粉卡片", mode: "skin", skinTarget: "card" }),
				conv({ id: "d", title: "暗色面板", mode: "skin", skinTarget: "dashboard" }),
			],
		});
		const label = (title: string) =>
			(screen.getByText(title).closest("div") as HTMLElement).querySelector("[data-conv-label]")
				?.textContent;
		expect(label("樱花粉卡片")).toBe("卡片工坊");
		expect(label("暗色面板")).toBe("工坊");
	});

	it("无人格的聊天会话也标出来", () => {
		mount({ conversations: [conv({ id: "p", title: "正经问事", persona: false })] });
		expect(screen.getByText("无人格")).toBeTruthy();
	});

	it("默认那一档(聊天 + 有人格)不挂牌 —— 全挂上等于全没挂", () => {
		const { container } = mount({
			conversations: [conv({ id: "n", title: "闲聊", mode: "chat", persona: true })],
		});
		expect(container.querySelector("[data-conv-label]")).toBeNull();
	});

	it("老会话(两个字段都没有)按默认算,同样不挂牌", () => {
		const { container } = mount({ conversations: [conv({ id: "old", title: "老会话" })] });
		expect(container.querySelector("[data-conv-label]")).toBeNull();
	});

	it("工坊会话只挂一块牌 —— 那条路本来就没有人格,再标一次是废话", () => {
		mount({ conversations: [conv({ id: "s", title: "做皮肤", mode: "skin", persona: false })] });
		const row = screen.getByText("做皮肤").closest("div");
		expect(within(row as HTMLElement).getAllByText(/工坊|无人格/)).toHaveLength(1);
	});
});
