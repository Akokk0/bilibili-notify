// @vitest-environment jsdom
/**
 * 聊天页的「深度思考」开关 —— 不离开对话就能开思考、调档位。
 *
 * 它是**同一份配置的另一个入口**:读写的就是智能女仆页那套
 * `ai.providers.<id>.enableThinking / thinkingLevel`,不另起一份状态 ——
 * 两处各存一份的话,聊天页开了、设置页看着还是关的,迟早对不上。
 *
 * 写路径走 PATCH /api/globals。只动这两个字段不会触发 AI 探活
 * (`shouldRunAiEnableCheck` 只认 key/baseUrl/model/换家/首次启用),所以
 * 开关是即点即生效的,不用白等一次探活请求。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const G = vi.hoisted(() => ({
	ai: {} as Record<string, unknown>,
	// 显式标注两参:不标的话 vi.fn 推出空参元组,读 calls[0][1] 会触发 TS2493。
	patch: vi.fn(async (_path: string, _body?: unknown) => ({})),
}));

vi.mock("../../../services/api", () => ({
	api: {
		get: vi.fn(async () => ({ defaults: { ai: G.ai } })),
		patch: G.patch,
	},
}));

import { ThinkingControl } from "../thinking-control";

function wrap(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
	G.patch.mockClear();
	G.ai = {
		enabled: true,
		provider: "deepseek",
		providers: { deepseek: { model: "deepseek-chat", enableThinking: false } },
	};
});
afterEach(cleanup);

const toggle = () => screen.getByRole("button", { name: "深度思考" });

describe("ThinkingControl — 开关", () => {
	it("关着时按钮未按下,点一下 → PATCH 当前服务商桶的 enableThinking", async () => {
		render(wrap(<ThinkingControl />));
		await waitFor(() => expect(toggle().getAttribute("aria-pressed")).toBe("false"));

		fireEvent.click(toggle());

		await waitFor(() => expect(G.patch).toHaveBeenCalledTimes(1));
		expect(G.patch.mock.calls[0]?.[0]).toBe("/api/globals");
		expect(G.patch.mock.calls[0]?.[1]).toEqual({
			defaults: { ai: { providers: { deepseek: { enableThinking: true } } } },
		});
	});

	it("开着时再点 → 关掉", async () => {
		G.ai = {
			enabled: true,
			provider: "deepseek",
			providers: { deepseek: { model: "m", enableThinking: true } },
		};
		render(wrap(<ThinkingControl />));
		await waitFor(() => expect(toggle().getAttribute("aria-pressed")).toBe("true"));

		fireEvent.click(toggle());

		await waitFor(() => expect(G.patch).toHaveBeenCalled());
		expect(G.patch.mock.calls[0]?.[1]).toEqual({
			defaults: { ai: { providers: { deepseek: { enableThinking: false } } } },
		});
	});
});

describe("ThinkingControl — 档位", () => {
	it("开着才显示三档,当前档标为按下", async () => {
		G.ai = {
			enabled: true,
			provider: "deepseek",
			providers: { deepseek: { model: "m", enableThinking: true, thinkingLevel: "high" } },
		};
		render(wrap(<ThinkingControl />));
		await waitFor(() => expect(screen.getByRole("button", { name: "高" })).toBeTruthy());
		expect(screen.getByRole("button", { name: "高" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "低" }).getAttribute("aria-pressed")).toBe("false");
	});

	it("关着时不显示档位 —— 灰着一排点不动的按钮只会让人怀疑坏了", async () => {
		render(wrap(<ThinkingControl />));
		await waitFor(() => expect(toggle()).toBeTruthy());
		expect(screen.queryByRole("button", { name: "高" })).toBeNull();
	});

	it("点别的档 → PATCH thinkingLevel", async () => {
		G.ai = {
			enabled: true,
			provider: "deepseek",
			providers: { deepseek: { model: "m", enableThinking: true, thinkingLevel: "medium" } },
		};
		render(wrap(<ThinkingControl />));
		fireEvent.click(await screen.findByRole("button", { name: "高" }));

		await waitFor(() => expect(G.patch).toHaveBeenCalled());
		expect(G.patch.mock.calls[0]?.[1]).toEqual({
			defaults: { ai: { providers: { deepseek: { thinkingLevel: "high" } } } },
		});
	});

	it("切档不闪 —— 保存在途中开关不禁用、亮着不跌,档位当场就换", async () => {
		// 主人报的:点完深度思考再切档,开关胶囊会闪一下。病根是保存期间整个控件
		// 被 isPending 连坐禁用,disabled:opacity-40 一来一回就是那一下。改成乐观
		// 更新之后,界面**立刻**是终态,网络往返与观感无关。
		G.ai = {
			enabled: true,
			provider: "deepseek",
			providers: { deepseek: { model: "m", enableThinking: true, thinkingLevel: "medium" } },
		};
		// 保存永远在途 —— 把「在途中」这一拍放大到无限长,闪的实现在这里会一直暗着。
		G.patch.mockImplementationOnce(() => new Promise(() => {}));
		render(wrap(<ThinkingControl />));

		fireEvent.click(await screen.findByRole("button", { name: "高" }));

		// 开关不掉状态、不被禁用。
		expect((toggle() as HTMLButtonElement).disabled).toBe(false);
		expect(toggle().getAttribute("aria-pressed")).toBe("true");
		// 档位高亮当场切过去,不等服务端回话。
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "高" }).getAttribute("aria-pressed")).toBe("true"),
		);
	});

	it("保存失败 → 档位弹回原样,不留一个骗人的高亮", async () => {
		G.ai = {
			enabled: true,
			provider: "deepseek",
			providers: { deepseek: { model: "m", enableThinking: true, thinkingLevel: "medium" } },
		};
		G.patch.mockRejectedValueOnce(new Error("500"));
		render(wrap(<ThinkingControl />));

		fireEvent.click(await screen.findByRole("button", { name: "高" }));

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "中" }).getAttribute("aria-pressed")).toBe("true"),
		);
		expect(screen.getByRole("button", { name: "高" }).getAttribute("aria-pressed")).toBe("false");
	});
});

describe("ThinkingControl — 不支持思考的服务商", () => {
	it("自定义:按钮灰着,并指路去额外请求参数 —— 方言未知,开关帮不上忙", async () => {
		G.ai = { enabled: true, provider: "custom", providers: { custom: { model: "m" } } };
		render(wrap(<ThinkingControl />));
		await waitFor(() => expect(toggle()).toBeTruthy());
		expect((toggle() as HTMLButtonElement).disabled).toBe(true);
		expect(toggle().getAttribute("title")).toContain("额外请求参数");
		// 灰按钮点了不该发请求。
		fireEvent.click(toggle());
		expect(G.patch).not.toHaveBeenCalled();
	});
});
