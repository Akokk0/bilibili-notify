// @vitest-environment jsdom

/**
 * 拓展详情页的「译文问题」注(ADR-0037 决策 14):拓展自带的译文里没收下的条目,服务端已经按当前语言
 * 取成了句子(`localeIssues`),面板原样列出、不再翻。**有才出现**;没有这一格或是空数组就不画。
 * 标题那一句是面板自己的字,从面板字典取。
 */

import type { ExtensionEntryView } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import zhCN from "../../i18n/locales/zh-CN.json";
import { api } from "../../services/api";
import ExtensionDetail from "../ExtensionDetail";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

const { FakeApiError, disk } = vi.hoisted(() => {
	class FakeApiError extends Error {}
	return { FakeApiError, disk: { issues: undefined as string[] | undefined } };
});

vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: {
		get: vi.fn(async (url: string) => {
			if (url === "/api/subscriptions") return [];
			if (url.endsWith("/docs")) return {};
			if (url === "/api/ext") {
				const ext: ExtensionEntryView = {
					id: "douyin",
					name: "抖音订阅",
					version: "0.1.0",
					apiVersion: 1,
					provides: ["subscription"],
					dir: "/data/extensions/douyin",
					enabled: true,
					state: "running",
					...(disk.issues ? { localeIssues: disk.issues } : {}),
				};
				return { extensions: [ext] };
			}
			return {};
		}),
		patch: vi.fn(async () => ({})),
		delete: vi.fn(async () => ({ ok: true })),
	},
}));

const TITLE = (zhCN as Record<string, string>)["extension.detail.localeIssuesTitle"] as string;

function renderDetail() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<MemoryRouter initialEntries={["/extensions/douyin"]}>
			<QueryClientProvider client={qc}>
				<Routes>
					<Route path="/extensions/:id" element={<ExtensionDetail />} />
				</Routes>
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

describe("拓展详情页:译文问题", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		disk.issues = undefined;
	});

	it("有问题:标题一句,下面每句问题原样列出", async () => {
		disk.issues = [
			"译文 en.json 里「a.b」的键写法不对，这一条没有用上",
			"译文 ja.json 过大，整份没有用上",
		];
		renderDetail();

		expect(await screen.findByText(TITLE)).toBeTruthy();
		for (const issue of disk.issues) expect(screen.getByText(issue)).toBeTruthy();
	});

	it("translation warning headings change language while host diagnostics remain intact", async () => {
		disk.issues = ["en.json: unknown.key / Invalid placeholder {raw}"];
		renderDetail();
		const diagnostic = await screen.findByText(disk.issues[0] as string);
		for (const [locale, title] of [
			["en", "Some translations supplied by this extension were not used"],
			["ja", "この拡張機能の一部の翻訳は適用されませんでした"],
			["zh-TW", "此拓展提供的部分譯文未套用"],
		] as const) {
			await act(async () => {
				i18n.set({ locale, voice: "plain" });
			});
			expect(screen.getByText(title)).toBeTruthy();
			expect(screen.getByText(disk.issues[0] as string)).toBe(diagnostic);
			expect(screen.getAllByText("抖音订阅").length).toBeGreaterThan(0);
		}
		expect(api.patch).not.toHaveBeenCalled();
		expect(api.delete).not.toHaveBeenCalled();
	});

	it("没有这一格 → 不画", async () => {
		renderDetail();
		// 页画完了(面包屑上的返回链接在)再断言「没有」,没等的话空 DOM 也会过。
		await screen.findByRole("link", { name: "返回拓展列表" });
		expect(screen.queryByText(TITLE)).toBeNull();
	});

	it("空数组 → 不画", async () => {
		disk.issues = [];
		renderDetail();
		// 页画完了(面包屑上的返回链接在)再断言「没有」,没等的话空 DOM 也会过。
		await screen.findByRole("link", { name: "返回拓展列表" });
		expect(screen.queryByText(TITLE)).toBeNull();
	});
});
