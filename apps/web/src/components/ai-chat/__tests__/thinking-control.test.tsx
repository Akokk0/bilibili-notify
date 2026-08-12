// @vitest-environment jsdom
/**
 * 聊天页的「深度思考」图标开关。
 *
 * 读写的是 `ai.chat.enableThinking` —— 聊天页自己的思考设置,与实例桶里那两格
 * (引擎的:点评 / 总结 / 锐评)**分了家**。曾经它直接改实例桶,于是在对话里拨
 * 一下开关,整个女仆的点评行为跟着变。
 *
 * 继承语义:chat 段没写 = 跟随当前实例(初始默认值从女仆读取);拨过一次就写实
 * 分叉。思考**等级**不在聊天页调 —— 去「智能女仆 → 全局配置」。
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

function aiWith(over: Record<string, unknown> = {}) {
	return {
		enabled: true,
		activeProfile: "deepseek",
		providers: {
			deepseek: { provider: "deepseek", model: "m", enableThinking: false },
		},
		chat: {},
		...over,
	};
}

beforeEach(() => {
	G.patch.mockClear();
	G.ai = aiWith();
});
afterEach(cleanup);

const toggle = () => screen.getByRole("button", { name: "深度思考" });

describe("ThinkingControl — 图标开关,写的是 ai.chat", () => {
	it("点一下 → PATCH ai.chat.enableThinking,**不碰**实例桶", async () => {
		render(wrap(<ThinkingControl />));
		await waitFor(() => expect(toggle().getAttribute("aria-pressed")).toBe("false"));

		fireEvent.click(toggle());

		await waitFor(() => expect(G.patch).toHaveBeenCalledTimes(1));
		expect(G.patch.mock.calls[0]?.[0]).toBe("/api/globals");
		expect(G.patch.mock.calls[0]?.[1]).toEqual({
			defaults: { ai: { chat: { enableThinking: true } } },
		});
	});

	it("chat 段没写 → 跟随当前实例的开关(初始默认值从女仆读取)", async () => {
		G.ai = aiWith({
			providers: { deepseek: { provider: "deepseek", model: "m", enableThinking: true } },
		});
		render(wrap(<ThinkingControl />));
		await waitFor(() => expect(toggle().getAttribute("aria-pressed")).toBe("true"));
	});

	it("chat 写过就压过实例 —— 引擎开着思考,聊天自己关了", async () => {
		G.ai = aiWith({
			providers: { deepseek: { provider: "deepseek", model: "m", enableThinking: true } },
			chat: { enableThinking: false },
		});
		render(wrap(<ThinkingControl />));
		await waitFor(() => expect(toggle().getAttribute("aria-pressed")).toBe("false"));

		fireEvent.click(toggle());

		await waitFor(() => expect(G.patch).toHaveBeenCalled());
		expect(G.patch.mock.calls[0]?.[1]).toEqual({
			defaults: { ai: { chat: { enableThinking: true } } },
		});
	});

	it("聊天页没有档位按钮 —— 思考等级只在设置里调", async () => {
		G.ai = aiWith({ chat: { enableThinking: true } });
		render(wrap(<ThinkingControl />));
		await waitFor(() => expect(toggle().getAttribute("aria-pressed")).toBe("true"));
		for (const name of ["低", "中", "高"]) {
			expect(screen.queryByRole("button", { name })).toBeNull();
		}
	});

	it("连点不闪 —— 保存在途中开关不禁用,乐观态当场翻转", async () => {
		// 主人报过的闪:保存期间整个控件被 isPending 连坐禁用,opacity 一来一回。
		// 用一个永远不 resolve 的 PATCH 把「在途中」放大到无限长,闪的实现藏不住。
		G.patch.mockImplementationOnce(() => new Promise(() => {}));
		render(wrap(<ThinkingControl />));
		await waitFor(() => expect(toggle().getAttribute("aria-pressed")).toBe("false"));

		fireEvent.click(toggle());

		await waitFor(() => expect(toggle().getAttribute("aria-pressed")).toBe("true"));
		expect((toggle() as HTMLButtonElement).disabled).toBe(false);
	});

	it("保存失败 → 弹回原样,不留一个骗人的高亮", async () => {
		// 手控 reject:先钉住乐观态确实翻转了,再放失败进来看它弹回 —— 直接
		// mockRejected 的话回滚快过断言,瞬态抓不住,测试等于没测乐观那一半。
		let rejectPatch!: (e: Error) => void;
		G.patch.mockImplementationOnce(
			() =>
				new Promise((_, rj) => {
					rejectPatch = rj;
				}),
		);
		render(wrap(<ThinkingControl />));
		await waitFor(() => expect(toggle().getAttribute("aria-pressed")).toBe("false"));

		fireEvent.click(toggle());
		await waitFor(() => expect(toggle().getAttribute("aria-pressed")).toBe("true"));

		rejectPatch(new Error("500"));
		await waitFor(() => expect(toggle().getAttribute("aria-pressed")).toBe("false"));
	});
});

describe("ThinkingControl — 不支持思考的服务商", () => {
	it("自定义:按钮灰着,并指路去额外请求参数 —— 方言未知,开关帮不上忙", async () => {
		G.ai = aiWith({
			activeProfile: "custom",
			providers: { custom: { provider: "custom", model: "m" } },
		});
		render(wrap(<ThinkingControl />));
		await waitFor(() => expect(toggle()).toBeTruthy());
		expect((toggle() as HTMLButtonElement).disabled).toBe(true);
		expect(toggle().getAttribute("title")).toContain("额外请求参数");
		// 灰按钮点了不该发请求。
		fireEvent.click(toggle());
		expect(G.patch).not.toHaveBeenCalled();
	});
});
