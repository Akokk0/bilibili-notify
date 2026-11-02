// @vitest-environment jsdom
/**
 * `web_search` 痕迹的呈现 —— 「搜索中」状态与来源折叠列表。
 *
 * 搜索那几秒复用工具小条的三态(转圈 / 勾 / 叉),文案走 describeTool:
 * 「联网搜索『关键词』」—— 搜了什么比搜过更有用。搜完的**来源**(标题 + 链接)
 * 单独一块折叠列表:主人要能点开核对女仆的说法,但不点开时不占地方。
 * 落盘与在途两条路都要有 —— 重开会话时来源不该消失。
 */

import type { AiChatMessageDTO } from "@bilibili-notify/contract";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MessageList } from "../messages";
import { describeTool } from "../tools";

// Markdown chunk 是懒加载的,这里不测它 —— 换成同步纯文本渲染器。
// (useChatMarkdown 是 messages.tsx 自己的 hook,mock 的是它 import 的懒 chunk。)
vi.mock("../markdown", () => ({
	ChatMarkdown: ({ text }: { text: string }) => <span>{text}</span>,
}));

afterEach(cleanup);

const SOURCES = [
	{ title: "B 站财报解读", url: "https://example.com/a", siteName: "示例站" },
	{ title: "第二条", url: "https://example.com/b" },
];

function msg(over: Partial<AiChatMessageDTO> = {}): AiChatMessageDTO {
	return {
		id: "m1",
		role: "assistant",
		content: "查完了,主人。",
		ts: "2026-08-13T00:00:00.000Z",
		...over,
	} as AiChatMessageDTO;
}

function mountList(props: Partial<Parameters<typeof MessageList>[0]> = {}) {
	return render(<MessageList messages={[]} pending={null} busy={false} aiSelf="小绫" {...props} />);
}

describe("describeTool × web_search", () => {
	it("服务端下发的「联网搜索」标签带上搜索词", () => {
		expect(describeTool({ name: "web_search", label: "联网搜索", argText: "b站 新闻" }).label).toBe(
			"联网搜索「b站 新闻」",
		);
	});
});

describe("来源折叠列表", () => {
	it("落盘消息的 web_search 痕迹带 sources → 显示「来源 · N」,点开是可点的链接", () => {
		mountList({
			messages: [
				msg({
					tools: [{ name: "web_search", args: { query: "q" }, ok: true, sources: SOURCES }],
				}),
			],
		});
		const summary = screen.getByText(/来源 · 2/);
		fireEvent.click(summary);
		const link = screen.getByRole("link", { name: /B 站财报解读/ });
		expect(link.getAttribute("href")).toBe("https://example.com/a");
		// 新窗口打开 —— 点个来源不该把整个对话顶掉。
		expect(link.getAttribute("target")).toBe("_blank");
	});

	it("在途那份同样渲染来源 —— 搜完立刻能看,不等落盘", () => {
		mountList({
			pending: {
				ask: "搜搜",
				draft: "正在写",
				think: "",
				tools: [{ name: "web_search", args: { query: "q" }, ok: true, sources: SOURCES }],
			},
		});
		expect(screen.getByText(/来源 · 2/)).toBeTruthy();
	});

	it("没有 sources 的痕迹(普通工具 / 没搜成)不渲染来源块", () => {
		mountList({
			messages: [msg({ tools: [{ name: "web_search", args: { query: "q" }, ok: false }] })],
		});
		expect(screen.queryByText(/来源/)).toBeNull();
	});
});

describe("工具失败原因", () => {
	it.each(["pending", "saved"])("%s 痕迹直接显示失败原话", (stage) => {
		const tool = {
			name: "web_search",
			label: "联网搜索",
			args: {},
			ok: false,
			message: "服务暂时不可用，请稍后再试。",
		};
		mountList(
			stage === "pending"
				? {
						pending: { ask: "搜索", draft: "", think: "", tools: [tool] },
					}
				: { messages: [msg({ tools: [tool] })] },
		);
		expect(screen.getByText(tool.message)).toBeTruthy();
	});
});

it.each([true, undefined])("未失败工具（ok=%s）不显示错误消息", (ok) => {
	mountList({
		pending: {
			ask: "搜索",
			draft: "",
			think: "",
			tools: [{ name: "web_search", args: {}, ok, message: "不该显示的错误" }],
		},
	});
	expect(screen.queryByText("不该显示的错误")).toBeNull();
});
