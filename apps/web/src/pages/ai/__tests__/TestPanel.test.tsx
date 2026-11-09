// @vitest-environment jsdom
import { chooseSelect, selectOptionsOf } from "../../../__tests__/select-controls";

/**
 * 智能女仆「试一句」面板。
 *
 * 用户在 AI 页调完人格(还没保存),挑一个推送目标,递一句话 → 女仆用**当前草稿**的
 * 人格回一句 → 回复真实推到那个目标,同时就地显示在页面上。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import type { AiSettingsDraft } from "../../../types/globals";
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
	// 下发的遮挡(没动过的 key):送出去前要拿掉,带着它是 400。
	apiKey: { masked: "••••••••" },
	vision: { apiKey: { masked: "••••••••" }, baseUrl: "", model: "" },
	baseUrl: "https://api.example.com/v1",
	model: "test-model",
	persona: { name: "恶魔兔", traits: "调皮，会整活" },
	presets: [],
} as unknown as AiSettingsDraft;

function renderPanel() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<AiTestPanel draft={DRAFT} />
		</QueryClientProvider>,
	);
}

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

it.each([
	[
		"ja",
		"ひと言試してみますね",
		"ご主人様、未保存の変更も含む現在の性格設定で応答を試せますよ。応答は選んだ送信先に実際に送ります。",
		"考えていますよ…",
		"お届けしましたよ · 42 ms",
		"（何もお返事できませんでした）",
	],
	[
		"zh-TW",
		"試說一句吧",
		"主人，可以用目前的性格試問女僕一句，尚未儲存的變更也會套用；回覆會實際傳送到選取的目標喔。",
		"女僕思考中…",
		"女僕送到了喔 · 42 ms",
		"（女僕沒有回話）",
	],
] as const)(
	"%s maid test-push status preserves the question and sends only once",
	async (locale, title, subtitle, thinking, delivered, silent) => {
		vi.mocked(api.get).mockResolvedValue(TARGETS);
		let finish = () => {};
		vi.mocked(api.post).mockImplementation(
			async () =>
				new Promise((resolve) => {
					finish = () => resolve({ ok: true, reply: "", latencyMs: 42 });
				}),
		);
		renderPanel();
		await waitFor(() => expect(selectOptionsOf(screen.getByRole("combobox"))).toHaveLength(2));
		chooseSelect(screen.getByRole("combobox"), "订阅群");
		const target = screen.getByRole("combobox");
		const message = screen.getByPlaceholderText("今天过得怎么样？");
		fireEvent.change(message, { target: { value: "Original question 原文 {name}" } });
		act(() => i18n.set({ locale, voice: "maid" }));
		expect(screen.getByText(subtitle)).toBeTruthy();
		expect(screen.getByDisplayValue("Original question 原文 {name}")).toBe(message);
		fireEvent.click(screen.getByRole("button", { name: title }));
		await screen.findByRole("button", { name: thinking });
		await act(async () => finish());
		await screen.findByText(delivered);
		expect(screen.getByText(silent)).toBeTruthy();
		for (const voice of ["plain", "maid"] as const) {
			act(() => i18n.set({ voice }));
			expect(screen.getByDisplayValue("Original question 原文 {name}")).toBe(message);
			expect(screen.getByRole("combobox")).toBe(target);
			expect(target.textContent).toContain("订阅群");
			expect(api.post).toHaveBeenCalledExactlyOnceWith(
				"/api/ai/test",
				expect.objectContaining({
					targetId: TARGETS[1]?.id,
					message: "Original question 原文 {name}",
				}),
			);
		}
	},
);

it.each(["", "原始回复 {not-a-key}"])(
	"test reply labels follow locale while target, message and raw reply remain unchanged: %s",
	async (reply) => {
		i18n.set({ locale: "en", voice: "plain" });
		vi.mocked(api.get).mockResolvedValue(TARGETS);
		vi.mocked(api.post).mockResolvedValue({ ok: true, reply, latencyMs: 42 });
		renderPanel();
		await waitFor(() => expect(selectOptionsOf(screen.getByRole("combobox"))).toHaveLength(2));
		chooseSelect(screen.getByRole("combobox"), "订阅群");
		const message = screen.getByPlaceholderText("How was your day?");
		fireEvent.change(message, { target: { value: "原始问题" } });
		expect(api.post).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Try a message" }));
		await screen.findByText("Delivered · 42 ms");
		for (const [locale, title, delivered, silent] of [
			["ja", "ひと言試す", "送信済み · 42 ms", "（テキストが返されませんでした）"],
			["zh-TW", "試說一句", "已送達 · 42 ms", "（未傳回文字）"],
			["en", "Try a message", "Delivered · 42 ms", "(No text returned)"],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(screen.getByRole("button", { name: title })).toBeTruthy();
			expect(screen.getByText(delivered)).toBeTruthy();
			expect(screen.getByText(reply || silent)).toBeTruthy();
			expect(screen.getByDisplayValue("原始问题")).toBe(message);
			expect(screen.getByRole("combobox").textContent).toContain("订阅群");
		}
		expect(api.post).toHaveBeenCalledExactlyOnceWith(
			"/api/ai/test",
			expect.objectContaining({ targetId: TARGETS[1]?.id, message: "原始问题" }),
		);
	},
);

describe("AI 试一句面板", () => {
	it("选目标 + 递一句话 → 带着草稿人格打 /api/ai/test,并就地显示回复", async () => {
		vi.mocked(api.get).mockResolvedValue(TARGETS);
		vi.mocked(api.post).mockResolvedValue({
			ok: true,
			latencyMs: 42,
			reply: "在的主人~已经帮您盯着啦 (*´ω`*)",
		});

		renderPanel();
		await waitFor(() =>
			expect(selectOptionsOf(screen.getByRole("combobox"))).toHaveLength(TARGETS.length),
		);

		chooseSelect(screen.getByRole("combobox"), "订阅群");
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "今天过得怎么样?" } });
		fireEvent.click(screen.getByRole("button", { name: /试一句/ }));

		await waitFor(() => {
			expect(api.post).toHaveBeenCalledWith("/api/ai/test", {
				targetId: TARGETS[1]?.id,
				message: "今天过得怎么样?",
				// 草稿送上 —— 未保存的人格也要生效;没动过的密钥格(遮挡)不带,后端就用已存的真 key。
				ai: {
					enabled: true,
					baseUrl: "https://api.example.com/v1",
					model: "test-model",
					persona: { name: "恶魔兔", traits: "调皮，会整活" },
					presets: [],
					vision: { baseUrl: "", model: "" },
				},
			});
		});

		// 回复就地显示,不必跑去 QQ 里翻。
		expect(await screen.findByText(/在的主人~已经帮您盯着啦/)).toBeTruthy();
		// 耗时只在送达那一支上,面板照着它说「已送达」。
		expect(screen.getByText(/已送达 · 42ms/)).toBeTruthy();
	});

	async function sendOnce() {
		renderPanel();
		await waitFor(() =>
			expect(selectOptionsOf(screen.getByRole("combobox"))).toHaveLength(TARGETS.length),
		);
		chooseSelect(screen.getByRole("combobox"), "我的私聊");
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
		await waitFor(() =>
			expect(selectOptionsOf(screen.getByRole("combobox"))).toHaveLength(TARGETS.length),
		);

		// 目标默认选了第一个,但话是空的 → 仍然不能发。
		const btn = screen.getByRole("button", { name: /试一句/ }) as HTMLButtonElement;
		expect(btn.disabled).toBe(true);

		fireEvent.click(btn);
		expect(api.post).not.toHaveBeenCalled();
	});
});

it("同名目标显示连接名，选择备用连接只提交对应目标", async () => {
	vi.mocked(api.get).mockImplementation(async (path) =>
		path === "/api/connections"
			? [
					{ id: "main", name: "Main", platform: "relay" },
					{ id: "backup", name: "Backup", platform: "relay" },
				]
			: [
					{ id: "first", name: "Family", connectionId: "main" },
					{ id: "second", name: "Family", connectionId: "backup" },
				],
	);
	vi.mocked(api.post).mockResolvedValue({ ok: true, reply: "ok", latencyMs: 1 });
	renderPanel();
	await waitFor(() => expect(screen.getByRole("combobox").textContent).toContain("Main"));
	chooseSelect(screen.getByRole("combobox"), "Family · Backup");
	fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });
	fireEvent.click(screen.getByRole("button", { name: "试一句" }));
	await waitFor(() =>
		expect(api.post).toHaveBeenCalledWith(
			"/api/ai/test",
			expect.objectContaining({ targetId: "second" }),
		),
	);
});
