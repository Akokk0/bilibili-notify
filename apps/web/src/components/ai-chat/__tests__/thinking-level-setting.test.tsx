// @vitest-environment jsdom
/**
 * 侧栏设置弹层里的「思考深度」—— `ai.chat.thinkingLevel` 的编辑口。
 *
 * 它原来住在「智能女仆 → 全局配置」页:调聊天的思考深度得离开聊天、跨半个
 * 控制台再找到那一小块。深度只有聊天在用,编辑口就该跟着聊天走(主人定的)。
 * 落盘语义不变:还是 PATCH `/api/settings` 写 `ai.chat.thinkingLevel`。守四件事:
 *
 * 1. 显示值走 resolveChatThinkingLevel:chat 段没写就跟随当前实例的等级;
 * 2. 点档位 → 立即 PATCH,载荷只带 `ai.chat.thinkingLevel` 这一片;
 * 3. custom + chat 藏档位、给「额外请求参数」的指路(与 ✦ 胶囊同一套能力位);
 * 4. custom + responses 解禁 —— 那套协议里思考是标准字段。
 */

import { makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { ThinkingLevelSetting } from "../thinking-level-setting";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

function globalsWith(provider: "deepseek" | "custom", flavor: "chat" | "responses" = "chat") {
	const g = makeDefaultGlobalSettings();
	g.ai.activeProfile = "p1";
	g.ai.providers = {
		p1: {
			provider,
			label: "",
			apiKey: "k",
			baseUrl: "https://x",
			model: "m",
			apiFlavor: flavor,
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
	vi.mocked(api.get).mockResolvedValue({ core: JSON.parse(JSON.stringify(g)) });
	vi.mocked(api.patch).mockResolvedValue({ core: JSON.parse(JSON.stringify(g)) });
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<ThinkingLevelSetting />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	i18n.set({ locale: "zh-CN", voice: "plain" });
});
afterEach(cleanup);

it("thinking level translations preserve the selected effort and save only on an explicit choice", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	mount(globalsWith("deepseek"));
	const high = await screen.findByRole("button", { name: "High" });
	for (const [locale, title, highLabel] of [
		["en", "Thinking depth", "High"],
		["ja", "思考の深さ", "高"],
		["zh-TW", "思考深度", "高"],
		["en", "Thinking depth", "High"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByText(title)).toBeTruthy();
		expect(screen.getByRole("button", { name: highLabel })).toBe(high);
		expect(high.getAttribute("aria-pressed")).toBe("true");
		expect(api.patch).not.toHaveBeenCalled();
		expect(api.post).not.toHaveBeenCalled();
	}
	fireEvent.click(screen.getByRole("button", { name: "Low" }));
	await waitFor(() =>
		expect(api.patch).toHaveBeenCalledExactlyOnceWith("/api/settings", {
			core: { ai: { chat: { thinkingLevel: "low" } } },
		}),
	);
});

describe("ThinkingLevelSetting — 侧栏里的思考深度", () => {
	it("chat 段没写 → 跟随当前实例的等级(实例 high,「高」点亮)", async () => {
		mount(globalsWith("deepseek"));
		const high = await screen.findByRole("button", { name: "高" });
		expect(high.getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "低" }).getAttribute("aria-pressed")).toBe("false");
	});

	it("调过就写实:chat 段的值压过实例", async () => {
		const g = globalsWith("deepseek");
		g.ai.chat = { thinkingLevel: "low" };
		mount(g);
		const low = await screen.findByRole("button", { name: "低" });
		expect(low.getAttribute("aria-pressed")).toBe("true");
	});

	it("点档位 → 立即 PATCH,载荷只带 ai.chat.thinkingLevel 一片", async () => {
		mount(globalsWith("deepseek"));
		fireEvent.click(await screen.findByRole("button", { name: "低" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(api.patch).toHaveBeenCalledWith("/api/settings", {
			core: {
				ai: { chat: { thinkingLevel: "low" } },
			},
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

it.each([
	[
		"ja",
		"ご主人様、現在のインスタンスはカスタムプロバイダーなので、メイドが勝手に専用の思考パラメーターを送ることはありません。必要なら、そのインスタンスの「追加リクエストパラメーター」に入力してくださいね。",
	],
	[
		"zh-TW",
		"主人，目前實例使用自訂服務商，女僕不會擅自傳送專屬思考參數喔。需要的話，請填進該實例的「額外請求參數」。",
	],
] as const)("%s 女仆设置说明不显示或保存不支持的思考档位", async (locale, hint) => {
	mount(globalsWith("custom"));
	await screen.findByText(/额外请求参数/);
	act(() => i18n.set({ locale, voice: "maid" }));
	expect(screen.getByText(hint)).toBeTruthy();
	for (const label of ["低", "中", "高"])
		expect(screen.queryByRole("button", { name: label })).toBeNull();
	expect(api.patch).not.toHaveBeenCalled();
	expect(api.post).not.toHaveBeenCalled();
});
