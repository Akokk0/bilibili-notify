// @vitest-environment jsdom

/**
 * AI 页「图片理解」这一块 —— 副模型的地址与密钥必须一直摆在明面上。
 *
 * 回归背景:这两格原先藏在「视觉模型 ID 已填」之后才出现。可这块存在的**前提**就是
 * 主模型那家没有视觉模型(DeepSeek 官方接口一个都没有),副模型多半在**另一家** ——
 * 于是主人打开这块,看见的只有一个模型 ID 输入框,结论是「没法给它单配地址和密钥」。
 * 块标题下的副标题偏偏还写着 `ai.vision.{model,baseUrl,apiKey}`,更坐实了「有这功能
 * 但找不着」。真配了模型 ID 之后它们才现身这件事,主人是不会先知道的。
 *
 * 所以这里守两件事:两格恒在场、填进去的东西落进**那一家的 vision 桶**(不是主模型
 * 那两格 —— 写串了就是拿副模型的 key 去发主请求)。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import Ai from "../Ai";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

/** 主模型落在 DeepSeek —— 正是「主模型没有视觉能力」那一档,副模型必然在别家。 */
function globals() {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.enabled = true;
	g.defaults.ai.provider = "deepseek";
	g.defaults.ai.providers = {
		deepseek: {
			apiKey: "sk-main",
			baseUrl: "https://api.deepseek.com/v1",
			model: "deepseek-chat",
			temperature: 0.7,
			enableThinking: false,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			// 关键:视觉模型 ID **还空着**。这正是主人第一次打开这块时的样子。
			vision: { baseUrl: "", apiKey: "", model: "" },
		},
	};
	return JSON.parse(JSON.stringify(g));
}

function mount() {
	const g = globals();
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

/** 按字段 code 取那一格的输入框 —— 标签文案会改,`data-code` 是稳的。 */
function inputAt(code: string): HTMLInputElement | null {
	return document.querySelector<HTMLInputElement>(`[data-code="${code}"] input`);
}

/**
 * 某个前缀下这几项在页面上**从上到下**的实际先后。
 *
 * 按 `[data-code]` 的文档顺序取,而不是按传进来的顺序 —— 后者会让断言恒真。
 */
function fieldOrder(prefix: string, fields: readonly string[]): string[] {
	const want = new Set(fields.map((f) => `${prefix}${f}`));
	return Array.from(document.querySelectorAll<HTMLElement>("[data-code]"))
		.map((el) => el.dataset.code ?? "")
		.filter((code) => want.has(code))
		.map((code) => code.slice(prefix.length));
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

describe("AI 页 · 图片理解", () => {
	/** 落地页是「全局配置」,这一块住在「模型配置」。 */
	async function gotoModel() {
		fireEvent.click(await screen.findByRole("tab", { name: /模型配置/ }));
	}

	it("这一块叫「图片理解」,标题里不再拖一条 · vision 的尾巴", async () => {
		mount();
		await gotoModel();
		expect(await screen.findByText("图片理解")).toBeTruthy();
		expect(screen.queryByText("图片理解 · vision")).toBeNull();
	});

	it("视觉模型 ID 还空着,地址与密钥两格也在场 —— 否则主人以为压根没这功能", async () => {
		mount();
		await gotoModel();
		await waitFor(() => expect(inputAt("ai.providers.deepseek.vision.model")).toBeTruthy());
		expect(inputAt("ai.providers.deepseek.vision.baseUrl")).toBeTruthy();
		expect(inputAt("ai.providers.deepseek.vision.apiKey")).toBeTruthy();
	});

	it("三格的先后跟上面「模型连接」一模一样 —— 两块摆的是同一件事,顺序不该各走各的", async () => {
		mount();
		await gotoModel();
		await waitFor(() => expect(inputAt("ai.providers.deepseek.vision.apiKey")).toBeTruthy());

		const three = ["apiKey", "baseUrl", "model"] as const;
		// 不写死顺序,直接拿上面那块当基准 —— 哪天上面改了,下面没跟着改就红。
		const main = fieldOrder("ai.providers.deepseek.", three);
		expect(main).toHaveLength(3);
		expect(fieldOrder("ai.providers.deepseek.vision.", three)).toEqual(main);
	});

	it("填进去的地址与密钥落进那一家的 vision 桶,主模型那两格纹丝不动", async () => {
		mount();
		await gotoModel();
		await waitFor(() => expect(inputAt("ai.providers.deepseek.vision.baseUrl")).toBeTruthy());

		fireEvent.change(inputAt("ai.providers.deepseek.vision.baseUrl") as HTMLInputElement, {
			target: { value: "https://api.siliconflow.cn/v1" },
		});
		fireEvent.change(inputAt("ai.providers.deepseek.vision.apiKey") as HTMLInputElement, {
			target: { value: "sk-vision" },
		});

		await act(async () => {
			useDraftStore.getState().current?.onSave();
		});
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{
				defaults: {
					ai: {
						providers: Record<
							string,
							{
								apiKey?: string;
								baseUrl?: string;
								vision?: { baseUrl?: string; apiKey?: string };
							}
						>;
					};
				};
			},
		];
		const bucket = body.defaults.ai.providers.deepseek;
		expect(bucket?.vision?.baseUrl).toBe("https://api.siliconflow.cn/v1");
		expect(bucket?.vision?.apiKey).toBe("sk-vision");
		// 写串桶的话主模型会拿副模型的地址/密钥去发主请求 —— 一律 401,而且查不出所以然。
		expect(bucket?.baseUrl ?? "https://api.deepseek.com/v1").toBe("https://api.deepseek.com/v1");
		expect(bucket?.apiKey ?? "sk-main").toBe("sk-main");
	});
});
