// @vitest-environment jsdom

/**
 * AI 页 —— 密钥格的保存闭环(ADR-0021 决策 44)。
 *
 * 下发的 key 永远是遮挡(`{ masked }`,真 key 不出后端)。面板的规矩:
 * - 已存着的 key 显示「遮挡胶囊 + 换一份」,点了才出输入框,可以「不换了」撤回;
 * - **没动过的 key 不进 PATCH**(带着遮挡写回是 400)—— 改一项别的设置再保存,真 key 不能被碰;
 * - 换了新的 → PATCH 里是新明文;点「换一份」后留空保存 = 清空(空串);
 * - 保存后灵动岛回到干净态:只改 key 时重新拉回的 globals 与拉取前深度相等,React Query 的
 *   structural sharing 复用同一个引用,hydrate 的 effect 不触发 —— 所以要靠 PATCH 的**响应**把草稿拉回
 *   已保存态,否则草稿里的明文与基线遮挡永不相等、灵动岛永久 dirty。
 */

import { makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import Ai from "../Ai";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { i18n } from "../../i18n";
import { api } from "../../services/api";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

const MASK = { masked: "••••••••" };

/** 后端 GET / PATCH 都返回打码过的 globals —— 配了的 apiKey 恒为 { masked }。 */
function redactedGlobals() {
	const g = makeDefaultGlobalSettings();
	g.ai.enabled = true;
	// 连接字段住在服务商桶里(各家一套配置)。
	g.ai.activeProfile = "deepseek";
	g.ai.providers = {
		deepseek: {
			provider: "deepseek",
			label: "",
			// 关键:无论真 key 是什么,出后端一律是这个遮挡。
			// 下发的形状是遮挡对象;夹具从域类型造出来,这一格用断言塞进去。
			apiKey: MASK as unknown as string,
			baseUrl: "https://api.example.com/v1",
			model: "test-model",
			apiFlavor: "chat",
			enableThinking: false,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			// 看图副模型的 key 也是遮挡。
			vision: { baseUrl: "", apiKey: MASK as unknown as string, model: "" },
		},
	};
	// 联网搜索 key:配了的一把是遮挡,没配的是空串。
	g.ai.search.keys = { bocha: MASK as unknown as string, tavily: "" };
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

/** 渲染并切到「模型配置」Tab。 */
async function renderModelTab() {
	vi.mocked(api.get).mockImplementation(async (path: string) =>
		path === "/api/targets" ? [] : { core: redactedGlobals() },
	);
	vi.mocked(api.patch).mockImplementation(async () => ({ core: redactedGlobals() }));
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<Ai />
		</QueryClientProvider>,
	);
	// 落地页是「全局配置」;连接字段住在「模型配置」那个 Tab。
	fireEvent.click(await screen.findByRole("tab", { name: /模型配置/ }));
}

/** 主模型 key 那一格(同一页还有副模型 key,按 code 取)。 */
const apiKeyRow = () =>
	document.querySelector('[data-code="ai.providers.deepseek.apiKey"]') as HTMLElement;

type Body = { ai: { providers: Record<string, Record<string, unknown>> } };
/** 最后一发 PATCH 的核心那份(`/api/settings` 上挂在 `core` 下)。 */
const lastPatchBody = () =>
	(vi.mocked(api.patch).mock.calls.at(-1) as [string, { core: Body }])[1].core;
const save = () =>
	act(async () => {
		useDraftStore.getState().current?.onSave();
	});

describe("AI 页 — 密钥格的保存闭环", () => {
	it("已存着的 key 画成遮挡胶囊 + 「换一份」,点了才出输入框,「不换了」撤回", async () => {
		await renderModelTab();
		await screen.findByDisplayValue("test-model");
		expect(apiKeyRow().textContent).toContain("••••••••");
		expect(apiKeyRow().querySelector("input")).toBeNull();
		fireEvent.click(within(apiKeyRow()).getByRole("button", { name: "换一份" }));
		expect(within(apiKeyRow()).getByRole("button", { name: "不换了" })).toBeTruthy();
		fireEvent.click(within(apiKeyRow()).getByRole("button", { name: "不换了" }));
		expect(within(apiKeyRow()).getByRole("button", { name: "换一份" })).toBeTruthy();
		// 换了又撤回 = 没动过,灵动岛不亮。
		expect(useDraftStore.getState().current?.diff ?? []).toHaveLength(0);
	});

	it("换新 key → PATCH 里是新明文;保存后灵动岛回到干净态(不会永久卡在「未保存」)", async () => {
		// 每次 GET 都返回内容相同的**新对象** —— structural sharing 会把它折叠回旧引用,
		// 正是线上的真实情形。(页内的「试一句」面板会另拉 /api/targets,按路径分派。)
		await renderModelTab();
		await screen.findByDisplayValue("test-model");
		fireEvent.click(within(apiKeyRow()).getByRole("button", { name: "换一份" }));
		const input = apiKeyRow().querySelector("input") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "sk-brand-new" } });
		await waitFor(() => {
			expect(useDraftStore.getState().current?.diff.length ?? 0).toBeGreaterThan(0);
		});

		await save();
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		expect(lastPatchBody().ai.providers.deepseek?.apiKey).toBe("sk-brand-new");

		// 保存成功 = 已入库 → 灵动岛必须不再显示未保存改动。
		await waitFor(() => {
			expect(useDraftStore.getState().current?.diff ?? []).toHaveLength(0);
		});
	});

	it("只改别的项再保存 → PATCH 里没有 apiKey 这一格(带遮挡写回是 400)", async () => {
		await renderModelTab();
		const model = await screen.findByDisplayValue("test-model");
		fireEvent.change(model, { target: { value: "other-model" } });
		await save();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const bucket = lastPatchBody().ai.providers.deepseek;
		expect(bucket?.model).toBe("other-model");
		expect(bucket).not.toHaveProperty("apiKey");
		expect(JSON.stringify(lastPatchBody())).not.toContain("masked");
	});

	it("点「换一份」后输入框留空保存 → PATCH 里是空串(清空),不是 null 也不是遮挡", async () => {
		await renderModelTab();
		await screen.findByDisplayValue("test-model");
		fireEvent.click(within(apiKeyRow()).getByRole("button", { name: "换一份" }));
		await save();
		await waitFor(() => expect(api.patch).toHaveBeenCalled());

		const bucket = lastPatchBody().ai.providers.deepseek;
		expect(bucket).toHaveProperty("apiKey");
		expect(bucket?.apiKey).toBe("");
	});

	it("看图副模型 key 与联网搜索 key 同一套:没动不发,换了才发", async () => {
		await renderModelTab();
		const model = await screen.findByDisplayValue("test-model");
		fireEvent.change(model, { target: { value: "other-model" } });
		await save();
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
		// 副模型 key 与搜索 key 都没动 → 整份 PATCH 里一个遮挡都不能有。
		const json = JSON.stringify(lastPatchBody());
		expect(json).not.toContain("masked");
		expect(json).not.toContain('"vision":{"baseUrl":"","apiKey"');
		expect(lastPatchBody().ai.providers.deepseek?.vision).not.toHaveProperty("apiKey");

		// 换搜索 key:全局配置 Tab 里那一格。
		fireEvent.click(screen.getByRole("tab", { name: /全局配置/ }));
		const row = document.querySelector('[data-code="ai.search.keys.bocha"]') as HTMLElement;
		fireEvent.click(within(row).getByRole("button", { name: "换一份" }));
		fireEvent.change(row.querySelector("input") as HTMLElement, { target: { value: "bocha-new" } });
		await save();
		await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
		const search = (lastPatchBody().ai as unknown as { search: { keys: unknown } }).search;
		expect(search.keys).toMatchObject({ bocha: "bocha-new" });
	});

	// ai 的日志等级曾经也在这一页上,退回「跟随全局」要发显式 null 是同一个坑。控件
	// 已整体搬去系统页那格「按模块覆盖」,那条守卫跟着搬进了 System.module-log-levels。
});
