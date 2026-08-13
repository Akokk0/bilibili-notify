// @vitest-environment jsdom

/**
 * AI 页「接口风味」—— 实例桶的 `apiFlavor`(chat completions | responses)。
 *
 * 守四件事:
 * 1. 确认支持的家(deepseek/百炼/openrouter/custom)才摆这一格 —— 摆给硅基/火山
 *    等于递给主人一个必然 404 的组合;
 * 2. 默认 chat,拨到 responses 会让灵动岛 dirty(否则保存条不亮,主人一走就丢);
 * 3. responses 风味下,额外参数旁边要说清楚「请求体形状不同」—— 那个框的示例
 *    全是按 chat 写的,不提醒的话照抄必错;
 * 4. custom + responses 解禁深度思考:那套协议里思考是标准字段(reasoning.effort),
 *    不再是「方言未知不敢发」。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import Ai from "../Ai";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

type ProviderId = "deepseek" | "siliconflow" | "custom";

function globals(provider: ProviderId, flavor: "chat" | "responses" = "chat") {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.enabled = true;
	g.defaults.ai.activeProfile = "p1";
	g.defaults.ai.providers = {
		p1: {
			provider,
			label: "",
			apiKey: "sk-x",
			baseUrl: "https://x/v1",
			model: "m",
			apiFlavor: flavor,
			temperature: 0.7,
			enableThinking: false,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			vision: { baseUrl: "", apiKey: "", model: "" },
		},
	};
	return JSON.parse(JSON.stringify(g));
}

function mount(provider: ProviderId, flavor: "chat" | "responses" = "chat") {
	const g = globals(provider, flavor);
	vi.mocked(api.get).mockImplementation(async (path: string) =>
		path === "/api/targets" ? [] : JSON.parse(JSON.stringify(g)),
	);
	vi.mocked(api.patch).mockImplementation(async () => JSON.parse(JSON.stringify(g)));
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Ai />
		</QueryClientProvider>,
	);
}

async function gotoModel() {
	fireEvent.click(await screen.findByRole("tab", { name: /模型配置/ }));
}

function fieldAt(code: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-code="${code}"]`);
}

beforeEach(() => {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("AI 页 · 全局配置的「AI 聊天」块", () => {
	// 谓词曾在三处各手抄一份,这块漏了 responses 解锁:custom+responses 下聊天
	// 胶囊点得亮、服务端真在发 reasoning.effort,这里却藏起档位还谎称
	// 「女仆不会自作主张发思考参数」—— 文案是假的,档位卡死在 medium 调不了。
	it("custom+responses → 思考等级照摆,不再谎称「不会发思考参数」", async () => {
		mount("custom", "responses");
		await waitFor(() => expect(fieldAt("ai.chat.thinkingLevel")).toBeTruthy());
		expect(screen.queryByText(/不会自作主张发思考参数/)).toBeNull();
	});

	it("custom+chat → 维持灰话术,指路额外请求参数", async () => {
		mount("custom", "chat");
		await waitFor(() => expect(screen.getByText(/不会自作主张发思考参数/)).toBeTruthy());
		expect(fieldAt("ai.chat.thinkingLevel")).toBeNull();
	});
});

describe("AI 页 · 接口风味", () => {
	it("deepseek 档案摆出风味格,两个选项在场,默认停在 chat completions", async () => {
		mount("deepseek");
		await gotoModel();
		expect(fieldAt("ai.providers.p1.apiFlavor")).toBeTruthy();
		const chat = screen.getByRole("button", { name: /chat completions/i });
		const responses = screen.getByRole("button", { name: /responses/i });
		expect(chat.getAttribute("aria-pressed")).toBe("true");
		expect(responses.getAttribute("aria-pressed")).toBe("false");
	});

	it("硅基流动未确认支持 → 整格不摆(摆了就是递一个必然 404 的组合)", async () => {
		mount("siliconflow");
		await gotoModel();
		await screen.findByText("模型连接");
		expect(fieldAt("ai.providers.p1.apiFlavor")).toBeNull();
	});

	it("拨到 responses → 灵动岛 dirty,额外参数旁出现「形状不同」的提醒", async () => {
		mount("deepseek");
		await gotoModel();
		fireEvent.click(screen.getByRole("button", { name: /responses/i }));
		await waitFor(() => {
			expect(useDraftStore.getState().current?.diff.length ?? 0).toBeGreaterThan(0);
		});
		// 精确到 <strong> 原文 —— 泛匹配会撞上 extraParams 的 hint(#80 之后任意
		// 桶 id 也渲染继承的 label/hint 了,那是修复的正向副作用)。
		expect(screen.getByText("字段名与 chat completions 不同")).toBeTruthy();
	});

	it("custom + responses 解禁深度思考(标准 reasoning.effort,不再是方言)", async () => {
		mount("custom", "responses");
		await gotoModel();
		await screen.findByText("生成参数");
		expect(fieldAt("ai.providers.p1.enableThinking")).toBeTruthy();
	});

	it("custom + chat 维持原样:没有思考开关,只有「写到额外参数」的指路", async () => {
		mount("custom", "chat");
		await gotoModel();
		await screen.findByText("生成参数");
		expect(fieldAt("ai.providers.p1.enableThinking")).toBeNull();
		expect(screen.getByText(/把那家的写法填到/)).toBeTruthy();
	});
});
