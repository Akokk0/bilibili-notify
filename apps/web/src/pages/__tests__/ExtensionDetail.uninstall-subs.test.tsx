// @vitest-environment jsdom

/**
 * 卸订阅源拓展之前,确认框说清它名下的订阅怎么办(ADR-0019 决策 10):订阅**保留**、暂停,装回来
 * 自动恢复 —— 不说的话,主人会以为卸掉拓展就把那些订阅一起删了,或者反过来以为它们还在推。
 * 名下一条都没有时不多这一句。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { api } from "../../services/api";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import ExtensionDetail from "../ExtensionDetail";

const { FakeApiError, disk } = vi.hoisted(() => {
	class FakeApiError extends Error {}
	return { FakeApiError, disk: { subs: [] as unknown[] } };
});

vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: {
		get: vi.fn(async (url: string) => {
			if (url === "/api/subscriptions") return disk.subs;
			if (url.endsWith("/docs")) return {};
			if (url === "/api/ext") {
				return {
					extensions: [
						{
							id: "douyin",
							name: "抖音订阅",
							version: "0.1.0",
							apiVersion: 1,
							provides: ["subscription"],
							dir: "/data/extensions/douyin",
							enabled: false,
							state: "disabled",
						},
					],
				};
			}
			return {};
		}),
		patch: vi.fn(async () => ({})),
		delete: vi.fn(async () => ({ ok: true })),
	},
}));

function extSub(extensionId: string, externalId: string): Subscription {
	return makeEmptySubscription({ sourceKey: extensionId, externalId });
}

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

describe("卸订阅源拓展:名下的订阅", () => {
	beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		disk.subs = [];
	});

	it.each([1, 2])(
		"%i retained subscriptions remain paused in the translated uninstall confirmation, cancellation, failure, and pending states",
		async (count) => {
			disk.subs = [
				...Array.from({ length: count }, (_, index) => extSub("douyin", String(index))),
				extSub("other", "not-ours"),
			];
			vi.mocked(api.delete).mockRejectedValueOnce(new Error("原拒绝 / connection in use"));
			renderDetail();
			await userEvent.click(await screen.findByRole("button", { name: "删除拓展" }));
			await screen.findByText(`有 ${count} 条订阅会保留(暂停)`);
			for (const [locale, title, lead, settings, tail, kept, confirm, note] of [
				[
					"en",
					"Remove “抖音订阅”?",
					"Removing it deletes the package on disk and",
					"all of this extension’s settings",
					". You can reinstall it from the marketplace at any time.",
					count === 1
						? "1 subscription will be kept (paused)"
						: "2 subscriptions will be kept (paused)",
					"Remove",
					"Uninstalling removes its files and settings. You can reinstall it at any time.",
				],
				[
					"ja",
					"「抖音订阅」を削除しますか？",
					"ディスク上のパッケージと",
					"この拡張機能の設定",
					"を削除します。マーケットからいつでも再インストールできます。",
					`${count}件の購読は保持されます（一時停止）`,
					"削除",
					"アンインストールすると、ファイルと設定を削除します。いつでも再インストールできます。",
				],
				[
					"zh-TW",
					"移除「抖音订阅」？",
					"將移除磁碟上的拓展套件，以及",
					"此拓展的所有設定",
					"。可隨時從拓展市場重新安裝。",
					`會保留 ${count} 條訂閱（暫停）`,
					"確認移除",
					"移除後會刪除拓展檔案與設定，可隨時重新安裝。",
				],
			] as const) {
				act(() => i18n.set({ locale }));
				const dialog = within(screen.getByRole("dialog"));
				expect(dialog.getByText(title)).toBeTruthy();
				expect(dialog.getByText(lead, { exact: false })).toBeTruthy();
				expect(dialog.getByText(settings).tagName).toBe("STRONG");
				expect(dialog.getByText(tail, { exact: false })).toBeTruthy();
				expect(dialog.getByText(kept)).toBeTruthy();
				expect(dialog.getByRole("button", { name: confirm })).toBeTruthy();
				expect(screen.getByText(note, { exact: false })).toBeTruthy();
				expect(api.delete).not.toHaveBeenCalled();
			}
			await userEvent.click(screen.getByRole("button", { name: "取消" }));
			expect(api.delete).not.toHaveBeenCalled();
			await userEvent.click(screen.getByRole("button", { name: "移除拓展" }));
			await userEvent.click(screen.getByRole("button", { name: "確認移除" }));
			await screen.findByText("原拒绝 / connection in use");
			for (const locale of ["en", "ja", "zh-TW"] as const) {
				act(() => i18n.set({ locale }));
				expect(
					within(screen.getByRole("dialog")).getByText("原拒绝 / connection in use"),
				).toBeTruthy();
				expect(api.delete).toHaveBeenCalledExactlyOnceWith("/api/ext/douyin");
			}
			let reject!: (error: Error) => void;
			vi.mocked(api.delete).mockReturnValueOnce(
				new Promise((_, fail) => {
					reject = fail;
				}),
			);
			await userEvent.click(screen.getByRole("button", { name: "確認移除" }));
			for (const [locale, pending] of [
				["en", "Removing…"],
				["ja", "削除中…"],
				["zh-TW", "正在移除…"],
			] as const) {
				act(() => i18n.set({ locale }));
				fireEvent.click(screen.getByRole("button", { name: pending }));
				expect(api.delete).toHaveBeenCalledTimes(2);
			}
			await act(async () => reject(new Error("Original retry rejection")));
		},
	);

	it("名下有 2 条 → 确认框写「有 2 条订阅会保留(暂停)」;别人名下的、B 站的不算", async () => {
		disk.subs = [
			extSub("douyin", "a"),
			extSub("douyin", "b"),
			extSub("kuaishou", "c"),
			makeEmptySubscription({ sourceKey: "bilibili", externalId: "123" }),
		];
		renderDetail();

		await userEvent.click(await screen.findByRole("button", { name: "删除拓展" }));

		expect(await screen.findByText("有 2 条订阅会保留(暂停)")).toBeTruthy();
	});

	it("名下一条都没有 → 不多这一句", async () => {
		disk.subs = [
			extSub("kuaishou", "c"),
			makeEmptySubscription({ sourceKey: "bilibili", externalId: "123" }),
		];
		renderDetail();

		await userEvent.click(await screen.findByRole("button", { name: "删除拓展" }));
		await screen.findByText(/删掉它的设置也会一起没/);
		await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/subscriptions"));
		// 让订阅表那一发落地、框重画一次,再看。
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(screen.queryByText(/条订阅会保留/)).toBeNull();
	});
});
