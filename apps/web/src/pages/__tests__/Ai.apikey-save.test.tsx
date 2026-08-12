// @vitest-environment jsdom

/**
 * AI 页 —— 只改 apiKey 保存后,灵动岛必须回到干净态。
 *
 * 回归背景:apiKey 从后端 GET 回来永远是 REDACTED 占位(真 key 不出后端)。于是**只改
 * apiKey** 时,保存后重新拉取的 globals 与拉取前**深度完全相等** —— React Query 的
 * structural sharing 会复用同一个对象引用,`useEffect([globalsQuery.data])` 因此
 * **不触发**,draft 里仍留着用户输入的明文。draft(明文) 与 baseline(占位) 永远不等
 * → 灵动岛**永久 dirty**,反复点保存也消不掉,用户看到的就是「保存不了」。
 *
 * (顺手改了 model / 人格就不会犯 —— 那些字段不脱敏,GET 回来数据变了、引用就变了。
 * 所以这个 bug 只在「单独改 apiKey」这条路上现形。)
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

const REDACTED = "__BN_REDACTED__";

/** 后端 GET / PATCH 都返回 redact 过的 globals —— apiKey 恒为占位。 */
function redactedGlobals() {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.enabled = true;
	// 连接字段住在服务商桶里(各家一套配置)。
	g.defaults.ai.activeProfile = "deepseek";
	g.defaults.ai.providers = {
		deepseek: {
			provider: "deepseek",
			label: "",
			// 关键:无论真 key 是什么,出后端一律是这个占位。
			apiKey: REDACTED,
			baseUrl: "https://api.example.com/v1",
			model: "test-model",
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

describe("AI 页 — 只改 apiKey 的保存闭环", () => {
	it("保存后灵动岛回到干净态(不会永久卡在「未保存」)", async () => {
		// 每次 GET 都返回内容相同的**新对象** —— structural sharing 会把它折叠回旧引用,
		// 正是线上的真实情形。(页内的「试一句」面板会另拉 /api/targets,按路径分派。)
		vi.mocked(api.get).mockImplementation(async (path: string) =>
			path === "/api/targets" ? [] : redactedGlobals(),
		);
		vi.mocked(api.patch).mockImplementation(async () => redactedGlobals());

		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<Ai />
			</QueryClientProvider>,
		);

		// 落地页是「全局配置」;连接字段住在「模型配置」那个 Tab。
		fireEvent.click(await screen.findByRole("tab", { name: /模型配置/ }));
		// 等 hydrate 完成:apiKey 输入框里是占位。
		const input = await screen.findByDisplayValue(REDACTED);

		// 用户输入一把新 key → 灵动岛变 dirty。
		fireEvent.change(input, { target: { value: "sk-brand-new" } });
		await waitFor(() => {
			expect(useDraftStore.getState().current?.diff.length ?? 0).toBeGreaterThan(0);
		});

		// 点保存(灵动岛的保存按钮回调)。
		await act(async () => {
			useDraftStore.getState().current?.onSave();
		});
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));

		// 保存成功 = 已入库 → 灵动岛必须不再显示未保存改动。
		await waitFor(() => {
			expect(useDraftStore.getState().current?.diff ?? []).toHaveLength(0);
		});
	});

	it("清空 apiKey → PATCH 里显式 null,否则旧 key 一直留在后端", async () => {
		// 换 provider 时会先把 key 清空。手写 payload 时 apiKey: undefined 会被
		// JSON.stringify 连键一起丢掉,服务端当「不改」→ 旧 key 静默留着。
		vi.mocked(api.get).mockImplementation(async (path: string) =>
			path === "/api/targets" ? [] : redactedGlobals(),
		);
		vi.mocked(api.patch).mockImplementation(async () => redactedGlobals());

		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<Ai />
			</QueryClientProvider>,
		);

		fireEvent.click(await screen.findByRole("tab", { name: /模型配置/ }));
		const input = await screen.findByDisplayValue(REDACTED);
		fireEvent.change(input, { target: { value: "" } });
		await act(async () => {
			useDraftStore.getState().current?.onSave();
		});
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{ defaults: { ai: { providers: Record<string, Record<string, unknown>> } } },
		];
		// 清空后送的是**空串**,不再是显式 null。分桶之后 apiKey 带 `.default("")`、
		// 恒存在,空串就是「已清空」的合法值;`collectAiSecrets` 见空即把那把从加密袋
		// 里剔除。旧模型里 apiKey 是 optional,缺键意味着「不改」,所以当年非得发 null。
		const bucket = body.defaults.ai.providers.deepseek;
		expect(bucket).toHaveProperty("apiKey");
		expect(bucket?.apiKey).toBe("");
	});

	it("日志等级退回「跟随全局」→ PATCH 里显式 null(与 Cards 同一个坑)", async () => {
		// PATCH 是 JSON Merge Patch:键消失 = 该字段不改。靠「把 ai 这个键过滤掉」
		// 来表达清除,请求会成功但后端原样留着旧等级 —— 退不回跟随全局。
		const globals = redactedGlobals();
		globals.app.logLevels = { ai: "debug" };
		vi.mocked(api.get).mockImplementation(async (path: string) =>
			path === "/api/targets" ? [] : JSON.parse(JSON.stringify(globals)),
		);
		vi.mocked(api.patch).mockImplementation(async () => redactedGlobals());

		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<Ai />
			</QueryClientProvider>,
		);

		// 日志等级住在「全局配置」Tab —— 它是落地页,不用切。
		fireEvent.click(await screen.findByText("跟随全局"));
		await act(async () => {
			useDraftStore.getState().current?.onSave();
		});
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{ app: { logLevels: Record<string, unknown> } },
		];
		expect(body.app.logLevels).toHaveProperty("ai");
		expect(body.app.logLevels.ai).toBeNull();
	});
});
