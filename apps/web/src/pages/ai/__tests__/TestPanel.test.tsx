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

/** 非 2xx 的请求失败:面板读 `message`,有 `issues` 就接在后面(与真 ApiError 同形)。 */
class FakeApiError extends Error {
	constructor(
		message: string,
		readonly issues?: Array<{ path?: (string | number)[]; message: string }>,
	) {
		super(message);
	}
}

const TARGETS = [
	{ id: "11111111-1111-4111-8111-111111111111", name: "我的私聊", platform: "onebot" },
	{ id: "22222222-2222-4222-8222-222222222222", name: "订阅群", platform: "onebot" },
];

const DRAFT = {
	enabled: true,
	apiKey: "__BN_REDACTED__",
	baseUrl: "https://api.example.com/v1",
	model: "test-model",
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
		// 耗时只在送达那一支上,面板照着它说「已送达」。
		expect(screen.getByText(/已送达 · 42ms/)).toBeTruthy();
	});

	async function sendOnce() {
		renderPanel();
		await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(TARGETS.length));
		fireEvent.change(screen.getByRole("combobox"), { target: { value: TARGETS[0]?.id } });
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "在吗?" } });
		fireEvent.click(screen.getByRole("button", { name: /试一句/ }));
	}

	it("女仆没答上来(200 + 失败的 Result)→ 就地显示 message 里对端给的错因,不装作成功", async () => {
		vi.mocked(api.get).mockResolvedValue(TARGETS);
		vi.mocked(api.post).mockResolvedValue({
			ok: false,
			code: "unavailable",
			message: "女仆那边没答上来：401 Incorrect API key provided",
		});

		await sendOnce();

		expect(await screen.findByText(/401 Incorrect API key/)).toBeTruthy();
		// 失败那一支没有耗时,面板不能凭空摆出「已送达」。
		expect(screen.queryByText(/已送达/)).toBeNull();
	});

	it("请求本身不对(非 2xx 的 ApiError)→ 一样显示原因,逐条原因接在后面", async () => {
		vi.mocked(api.get).mockResolvedValue(TARGETS);
		vi.mocked(api.post).mockRejectedValue(
			new FakeApiError("试一句的请求格式不对", [{ path: ["message"], message: "太长" }]),
		);

		await sendOnce();

		expect(await screen.findByText(/试一句的请求格式不对：message：太长/)).toBeTruthy();
	});

	it("引擎还没起(非 2xx,没有逐条原因)→ 只显示 message", async () => {
		vi.mocked(api.get).mockResolvedValue(TARGETS);
		vi.mocked(api.post).mockRejectedValue(new FakeApiError("服务还没准备好，请稍后重试"));

		await sendOnce();

		expect(await screen.findByText("服务还没准备好，请稍后重试")).toBeTruthy();
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
