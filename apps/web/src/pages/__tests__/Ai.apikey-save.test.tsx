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
	g.defaults.ai.model = "test-model";
	g.defaults.ai.baseUrl = "https://api.example.com/v1";
	// 关键:无论真 key 是什么,出后端一律是这个占位。
	g.defaults.ai.apiKey = REDACTED;
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
});
