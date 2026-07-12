// @vitest-environment jsdom

/**
 * 智能女仆「试一句」面板。
 *
 * 用户在 AI 页调完人格(还没保存),挑一个推送目标,递一句话 → 女仆用**当前草稿**的
 * 人格回一句 → 回复真实推到那个目标,同时就地显示在页面上。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AISettings } from "../../../types/globals";
import { AiTestPanel } from "../TestPanel";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

const TARGETS = [
	{ id: "11111111-1111-4111-8111-111111111111", name: "我的私聊", platform: "onebot" },
	{ id: "22222222-2222-4222-8222-222222222222", name: "订阅群", platform: "onebot" },
];

const DRAFT = {
	enabled: true,
	apiKey: "__BN_REDACTED__",
	baseUrl: "https://api.example.com/v1",
	model: "test-model",
	temperature: 0.7,
	persona: { name: "恶魔兔", traits: "调皮，会整活" },
	presets: [],
} as unknown as AISettings;

function renderPanel() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<AiTestPanel draft={DRAFT} />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("AI 试一句面板", () => {
	it("选目标 + 递一句话 → 带着草稿人格打 /api/ai/test-push,并就地显示回复", async () => {
		vi.mocked(api.get).mockResolvedValue(TARGETS);
		vi.mocked(api.post).mockResolvedValue({
			ok: true,
			latencyMs: 42,
			reply: "在的主人~已经帮您盯着啦 (*´ω`*)",
		});

		renderPanel();
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(TARGETS.length));

		fireEvent.change(screen.getByRole("combobox"), { target: { value: TARGETS[1]?.id } });
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "今天过得怎么样?" } });
		fireEvent.click(screen.getByRole("button", { name: /试一句/ }));

		await waitFor(() => {
			expect(api.post).toHaveBeenCalledWith("/api/ai/test-push", {
				targetId: TARGETS[1]?.id,
				message: "今天过得怎么样?",
				ai: DRAFT, // 草稿原样送上 —— 未保存的人格也要生效
			});
		});

		// 回复就地显示,不必跑去 QQ 里翻。
		expect(await screen.findByText(/在的主人~已经帮您盯着啦/)).toBeTruthy();
	});

	it("后端报错 → 就地显示错因,不装作成功", async () => {
		vi.mocked(api.get).mockResolvedValue(TARGETS);
		vi.mocked(api.post).mockResolvedValue({
			ok: false,
			latencyMs: 0,
			err: "401 Incorrect API key provided",
		});

		renderPanel();
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(TARGETS.length));

		fireEvent.change(screen.getByRole("combobox"), { target: { value: TARGETS[0]?.id } });
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "在吗?" } });
		fireEvent.click(screen.getByRole("button", { name: /试一句/ }));

		expect(await screen.findByText(/401 Incorrect API key/)).toBeTruthy();
	});

	it("没写话 / 没选目标 → 按钮禁用,不白打一次 AI", async () => {
		vi.mocked(api.get).mockResolvedValue(TARGETS);

		renderPanel();
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(TARGETS.length));

		// 目标默认选了第一个,但话是空的 → 仍然不能发。
		const btn = screen.getByRole("button", { name: /试一句/ }) as HTMLButtonElement;
		expect(btn.disabled).toBe(true);

		fireEvent.click(btn);
		expect(api.post).not.toHaveBeenCalled();
	});
});
