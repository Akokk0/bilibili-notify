// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { chooseSelect } from "../../__tests__/select-controls";
import { i18n } from "../../i18n";
import Logs from "../Logs";

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

const { apiGetMock } = vi.hoisted(() => ({
	apiGetMock: vi.fn(async (_url: string) => ({ entries: [] })),
}));

vi.mock("../../hooks/useLogChannel", () => ({
	useLogChannel: () => undefined,
}));

vi.mock("../../services/api", () => ({
	api: {
		get: apiGetMock as unknown as (url: string) => Promise<{ entries: unknown[] }>,
	},
}));

function renderLogs() {
	const qc = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
			},
		},
	});
	return render(
		<QueryClientProvider client={qc}>
			<Logs />
		</QueryClientProvider>,
	);
}

describe("Logs page", () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		apiGetMock.mockClear();
		Element.prototype.scrollIntoView = vi.fn();
	});

	it("renders the runtime log area with an empty state", async () => {
		renderLogs();
		expect(await screen.findByText("没有符合条件的日志")).toBeTruthy();
	});

	// 更新日志已迁出到 `/about`,日志页回归纯运行日志(单栏,不再有 SectionNav)。
	it("no longer hosts the changelog (moved to /about)", async () => {
		renderLogs();
		await screen.findByText("没有符合条件的日志");
		expect(screen.queryByText("apps/CHANGELOG.md")).toBeNull();
		expect(screen.queryByText("更新日志")).toBeNull();
	});

	it("locale changes redraw log controls without rewriting existing log text or resetting filters and pause", async () => {
		apiGetMock.mockResolvedValueOnce({
			entries: [
				{
					ts: "2026-11-01T00:00:00Z",
					level: "info",
					name: "alpha",
					msg: "原文说明",
					args: [{ diagnostic: "原始诊断" }],
				},
			],
		} as never);
		renderLogs();
		const line = await screen.findByText("原文说明");
		const search = screen.getByPlaceholderText("搜索日志正文 / 源 / 参数...");
		fireEvent.change(search, { target: { value: "原文" } });
		chooseSelect(screen.getByRole("combobox"), "alpha");
		fireEvent.click(screen.getByRole("button", { name: "暂停" }));
		for (const [locale, placeholder, source, paused, count] of [
			["en", "Search log text / source / arguments…", "Log source", "Paused", "Showing 1 line"],
			["ja", "ログ本文 / ソース / 引数を検索…", "ログのソース", "一時停止中", "1行を表示"],
			["zh-TW", "搜尋日誌內容 / 來源 / 參數…", "日誌來源", "已暫停", "顯示 1 行"],
		] as const) {
			await act(async () => {
				i18n.set({ locale, voice: "plain" });
			});
			expect(screen.getByPlaceholderText(placeholder)).toBe(search);
			expect(search).toHaveProperty("value", "原文");
			expect(screen.getByRole("combobox", { name: source }).textContent).toContain("alpha");
			expect(screen.getByRole("button", { name: paused })).toBeTruthy();
			expect(screen.getByText(new RegExp(count))).toBeTruthy();
			expect(screen.getByText("原文说明")).toBe(line);
			expect(screen.getByText('[{"diagnostic":"原始诊断"}]')).toBeTruthy();
		}
	});
});

it("filters sources locally and restores all sources through the empty option", async () => {
	apiGetMock.mockResolvedValueOnce({
		entries: [
			{ ts: "2026-11-01T00:00:00Z", level: "info", name: "alpha", msg: "Alpha entry" },
			{ ts: "2026-11-01T00:00:00Z", level: "info", name: "beta", msg: "Beta entry" },
		],
	} as never);
	renderLogs();
	await screen.findByText("Beta entry");
	chooseSelect(screen.getByRole("combobox"), "alpha");
	await waitFor(() => expect(screen.queryByText("Beta entry")).toBeNull());
	expect(screen.getByText("Alpha entry")).toBeTruthy();
	chooseSelect(screen.getByRole("combobox"), "全部来源");
	expect(screen.getByText("Beta entry")).toBeTruthy();
});
