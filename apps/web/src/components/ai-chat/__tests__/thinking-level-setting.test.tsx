// @vitest-environment jsdom
/**
 * 侧栏设置弹层里的「思考深度」—— `ai.chat.thinkingLevel` 的编辑口。
 *
 * 它原来住在「智能女仆 → 全局配置」页:调聊天的思考深度得离开聊天、跨半个
 * 控制台再找到那一小块。深度只有聊天在用,编辑口就该跟着聊天走(主人定的)。
 * 落盘语义不变:还是 PATCH `/api/globals` 写 `ai.chat.thinkingLevel`。守四件事:
 *
 * 1. 显示值走 resolveChatThinkingLevel:chat 段没写就跟随当前实例的等级;
 * 2. 点档位 → 立即 PATCH,载荷只带 `ai.chat.thinkingLevel` 这一片;
 * 3. custom + chat 藏档位、给「额外请求参数」的指路(与 ✦ 胶囊同一套能力位);
 * 4. custom + responses 解禁 —— 那套协议里思考是标准字段。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ThinkingLevelSetting } from "../thinking-level-setting";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

function globalsWith(provider: "deepseek" | "custom", flavor: "chat" | "responses" = "chat") {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.activeProfile = "p1";
	g.defaults.ai.providers = {
		p1: {
			provider,
			label: "",
			apiKey: "k",
			baseUrl: "https://x",
			model: "m",
			apiFlavor: flavor,
			temperature: 0.7,
			enableThinking: false,
			thinkingLevel: "high",
			extraParams: "",
			enableVision: false,
			vision: { baseUrl: "", apiKey: "", model: "" },
		},
	};
	return g;
}

function mount(g: ReturnType<typeof globalsWith>) {
	vi.mocked(api.get).mockResolvedValue(JSON.parse(JSON.stringify(g)));
	vi.mocked(api.patch).mockResolvedValue(JSON.parse(JSON.stringify(g)));
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<ThinkingLevelSetting />
		</QueryClientProvider>,
	);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ThinkingLevelSetting — 侧栏里的思考深度", () => {
	it("chat 段没写 → 跟随当前实例的等级(实例 high,「高」点亮)", async () => {
		mount(globalsWith("deepseek"));
		const high = await screen.findByRole("button", { name: "高" });
		expect(high.getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "低" }).getAttribute("aria-pressed")).toBe("false");
	});

	it("调过就写实:chat 段的值压过实例", async () => {
		const g = globalsWith("deepseek");
		g.defaults.ai.chat = { thinkingLevel: "low" };
		mount(g);
		const low = await screen.findByRole("button", { name: "低" });
		expect(low.getAttribute("aria-pressed")).toBe("true");
	});

	it("点档位 → 立即 PATCH,载荷只带 ai.chat.thinkingLevel 一片", async () => {
		mount(globalsWith("deepseek"));
		fireEvent.click(await screen.findByRole("button", { name: "低" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(api.patch).toHaveBeenCalledWith("/api/globals", {
			defaults: { ai: { chat: { thinkingLevel: "low" } } },
		});
	});

	it("这里没有思考**开关** —— 它曾经落盘(ai.chat.enableThinking),改会话级后再摆一颗只会让人以为它还落盘", async () => {
		mount(globalsWith("deepseek"));
		await screen.findByRole("button", { name: "中" });
		expect(screen.queryByRole("button", { name: "聊天深度思考" })).toBeNull();
	});

	it("custom + chat → 藏档位,指路「额外请求参数」", async () => {
		mount(globalsWith("custom"));
		await waitFor(() => expect(screen.getByText(/额外请求参数/)).toBeTruthy());
		for (const label of ["低", "中", "高"]) {
			expect(screen.queryByRole("button", { name: label })).toBeNull();
		}
	});

	it("custom + responses → 解禁:思考在那套协议里是标准字段", async () => {
		mount(globalsWith("custom", "responses"));
		expect(await screen.findByRole("button", { name: "中" })).toBeTruthy();
	});
});
