// @vitest-environment jsdom

/**
 * AI 页「生成参数」块 —— temperature 已整个退役,这里不许再有它的输入。
 *
 * 它一律不再发、走服务商默认:Claude Opus 4.7 起的模型与 OpenAI 推理模型收到它直接
 * 400,DeepSeek 开思考时静默忽略它。界面上留一格调不出任何效果的滑块,只会让主人以为
 * 设置没存上。真想调的主人从同一块里的「额外请求参数」写。
 *
 * 逐家逐开关地看:旧界面在「DeepSeek + 开思考」时收起滑块、改摆一条说明,其余时候摆
 * 滑块 —— 两种形态都要确认已经不在了。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import Ai from "../Ai";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

type ProviderId = "deepseek" | "siliconflow" | "custom";

function globals(provider: ProviderId, enableThinking: boolean) {
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
			apiFlavor: "chat",
			enableThinking,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			vision: { baseUrl: "", apiKey: "", model: "" },
		},
	};
	return JSON.parse(JSON.stringify(g));
}

function mount(provider: ProviderId, enableThinking: boolean) {
	const g = globals(provider, enableThinking);
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

describe("AI 页 · 生成参数:没有 temperature", () => {
	for (const [provider, enableThinking] of [
		["deepseek", false],
		["deepseek", true],
		["siliconflow", false],
		["custom", false],
	] as const) {
		it(`${provider} · 思考${enableThinking ? "开" : "关"} → 既没有输入格,也没有「忽略 temperature」的说明`, async () => {
			mount(provider, enableThinking);
			fireEvent.click(await screen.findByRole("tab", { name: /模型配置/ }));
			await screen.findByText("生成参数");
			// 同一块里的额外参数格在场,说明这一块确实渲染出来了,下面的「没有」才作数。
			expect(document.querySelector('[data-code="ai.providers.p1.extraParams"]')).toBeTruthy();
			expect(document.querySelector('[data-code$=".temperature"]')).toBeNull();
			expect(screen.queryByText(/忽略 temperature/)).toBeNull();
		});
	}
});
