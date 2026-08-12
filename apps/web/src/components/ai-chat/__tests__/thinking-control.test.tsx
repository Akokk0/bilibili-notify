// @vitest-environment jsdom
/**
 * 「深度思考」胶囊 —— **会话级受控组件**(主人定的:默认关、手动开、不落盘)。
 *
 * 它曾经直接写配置(ai.chat.enableThinking),于是刷新 / 换设备后「上次开的思考」
 * 还阴魂不散地烧钱。改会话级后组件不再发任何写请求:状态由聊天页持有,点一下只是
 * 回调 onToggle,发消息时随请求体走。这里守三件事:
 *
 * 1. 纯受控:aria-pressed 跟 props 走,点击只回调、**绝不 PATCH**;
 * 2. 自定义服务商灰着并指路(方言未知,发了也没用);
 * 3. 等级不在这里调 —— 低/中/高属于设置页。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ThinkingControl } from "../thinking-control";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

function globalsWith(provider: "deepseek" | "custom") {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.activeProfile = "p1";
	g.defaults.ai.providers = {
		p1: {
			provider,
			label: "",
			apiKey: "k",
			baseUrl: "https://x",
			model: "m",
			temperature: 0.7,
			enableThinking: false,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			vision: { baseUrl: "", apiKey: "", model: "" },
		},
	};
	return g;
}

function mount(
	provider: "deepseek" | "custom",
	props: { on: boolean; onToggle: (v: boolean) => void },
) {
	vi.mocked(api.get).mockResolvedValue(JSON.parse(JSON.stringify(globalsWith(provider))));
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<ThinkingControl {...props} />
		</QueryClientProvider>,
	);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ThinkingControl — 会话级受控胶囊", () => {
	it("aria-pressed 跟 props 走:off 灭、on 亮", async () => {
		mount("deepseek", { on: false, onToggle: () => {} });
		const off = await screen.findByRole("button", { name: "深度思考" });
		expect(off.getAttribute("aria-pressed")).toBe("false");
		cleanup();

		mount("deepseek", { on: true, onToggle: () => {} });
		const lit = await screen.findByRole("button", { name: "深度思考" });
		expect(lit.getAttribute("aria-pressed")).toBe("true");
	});

	it("点一下只回调 onToggle,绝不写配置 —— 会话级就是不落盘", async () => {
		const onToggle = vi.fn();
		mount("deepseek", { on: false, onToggle });
		fireEvent.click(await screen.findByRole("button", { name: "深度思考" }));
		expect(onToggle).toHaveBeenCalledWith(true);
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("自定义服务商 → 灰着并指路「额外请求参数」", async () => {
		mount("custom", { on: false, onToggle: () => {} });
		const btn = (await screen.findByRole("button", { name: "深度思考" })) as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
		expect(btn.title).toContain("额外请求参数");
	});

	it("等级不在这里调 —— 聊天工具栏不摆低/中/高", async () => {
		mount("deepseek", { on: true, onToggle: () => {} });
		await screen.findByRole("button", { name: "深度思考" });
		for (const label of ["低", "中", "高"]) {
			expect(screen.queryByRole("button", { name: label })).toBeNull();
		}
	});
});
