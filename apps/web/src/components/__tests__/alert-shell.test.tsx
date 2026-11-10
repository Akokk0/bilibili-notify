// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { useAlertStore } from "../../store/alerts";
import { AlertShell } from "../alert-shell";
import { ProblemBox } from "../problem-box";

vi.mock("../../services/api", () => ({
	api: {
		get: vi.fn(async (path: string) => {
			if (path === "/api/health") return { status: "ok", version: "dev", uptime: 1 };
			if (path === "/api/problems")
				return {
					problems: [
						{
							reporter: "core",
							code: "pending",
							message: "持续问题原文",
							since: "2026-11-01T00:00:00Z",
						},
					],
				};
			if (path === "/api/sources") return { sources: [] };
			if (path === "/api/adapters") return { adapters: [] };
			if (path === "/api/ext") return { extensions: [] };
			return [];
		}),
	},
}));
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	useAlertStore.getState().clear();
});
afterEach(() => {
	cleanup();
	useAlertStore.getState().clear();
	vi.useRealTimers();
});

it("错误时间随四语切换并保持秒精度，原诊断和接收时刻不改", () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const at = new Date(2026, 8, 2, 18, 5, 7).getTime();
	vi.setSystemTime(at);
	useAlertStore.getState().push({ source: "image", message: "Original diagnostic 原文 {name}" });
	render(
		<MemoryRouter>
			<AlertShell />
		</MemoryRouter>,
	);
	const original = screen.getByText("Original diagnostic 原文 {name}");
	for (const [locale, expected] of [
		["zh-CN", "18:05:07"],
		["en", "06:05:07 PM"],
		["ja", "18:05:07"],
		["zh-TW", "下午06:05:07"],
	] as const) {
		act(() => i18n.set({ locale, voice: "plain" }));
		expect(screen.getByText(expected)).toBeTruthy();
		expect(screen.getByText("Original diagnostic 原文 {name}")).toBe(original);
		expect(useAlertStore.getState().items[0]).toMatchObject({
			receivedAt: at,
			message: "Original diagnostic 原文 {name}",
		});
	}
});

it("error categories follow locale while received text stays intact and dismissing errors preserves ongoing problems", async () => {
	const sources = [
		"live-engine",
		"post-delivery",
		"push",
		"image",
		"ai",
		"link-previewer",
		"other-service",
	];
	for (const source of sources) useAlertStore.getState().push({ source, message: `${source}原文` });
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/#problems"]}>
				<ProblemBox />
				<AlertShell />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	const ongoing = await screen.findByText("持续问题原文");
	const image = screen.getByText("image原文");
	for (const [locale, title, categories] of [
		[
			"en",
			"Push pipeline errors (7)",
			["Live", "Post delivery", "Push", "Rendering", "AI", "Link preview", "Other"],
		],
		[
			"ja",
			"送信処理エラー (7)",
			["配信", "投稿の配信", "送信", "描画", "AI", "リンクプレビュー", "その他"],
		],
		["zh-TW", "推播流程錯誤 (7)", ["直播", "作品投遞", "推播", "繪製", "AI", "連結預覽", "其他"]],
	] as const) {
		await act(async () => {
			i18n.set({ locale, voice: "plain" });
		});
		expect(screen.getByText(title)).toBeTruthy();
		for (const category of categories) expect(screen.getByText(category)).toBeTruthy();
		expect(screen.getByText("image原文")).toBe(image);
		expect(screen.getByText("持续问题原文")).toBe(ongoing);
	}
	await userEvent.click(screen.getAllByRole("button", { name: "關閉" })[0]);
	expect(screen.queryByText("other-service原文")).toBeNull();
	expect(screen.getByText("image原文")).toBe(image);
	await userEvent.click(screen.getByRole("button", { name: "清空錯誤紀錄" }));
	expect(screen.queryByText("image原文")).toBeNull();
	// Clicking outside closes the problem popover; reopening must show the same ongoing issue.
	await userEvent.click(screen.getByRole("button", { name: "待處理問題 1" }));
	expect(await screen.findByText("持续问题原文")).toBeTruthy();
	qc.clear();
});
