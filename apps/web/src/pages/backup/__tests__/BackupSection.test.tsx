// @vitest-environment jsdom

/**
 * 系统页「备份与恢复」一节:导出走 /api/system/backup/export 并把回来的信封落成下载文件;
 * 导入走 /api/system/backup/import 并把落地结果(增删了多少、cookie 有没有恢复)回报给主人;
 * PIN 错等后端拒绝要显式报错,不能静默。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { BackupSection } from "../BackupSection";
import { BACKUP_FORMAT } from "../backup-file";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {
		constructor(
			public status: number,
			public body: unknown,
			message: string,
		) {
			super(message);
		}
	},
}));
vi.mock("../download", () => ({ downloadJson: vi.fn() }));

import { ApiError, api } from "../../../services/api";
import { downloadJson } from "../download";

const post = vi.mocked(api.post);
const download = vi.mocked(downloadJson);

function renderSection() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<BackupSection />
		</QueryClientProvider>,
	);
}

function pickFile(kind: "full" | "sanitized"): void {
	const doc = {
		format: BACKUP_FORMAT,
		schemaVersion: 1,
		kind,
		createdAt: "2026-07-10T00:00:00.000Z",
		sections: {},
	};
	const file = new File([JSON.stringify(doc)], "b.json", { type: "application/json" });
	fireEvent.change(screen.getByLabelText(/选择备份文件/), { target: { files: [file] } });
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	post.mockReset();
	vi.mocked(api.get).mockReset().mockResolvedValue({ defaultedSettings: [] });
	download.mockReset();
});
afterEach(cleanup);

describe("BackupSection", () => {
	it("exports a full backup and downloads the returned envelope", async () => {
		post.mockResolvedValue({
			format: BACKUP_FORMAT,
			kind: "full",
			createdAt: "2026-07-10T09:00:00.000Z",
		});
		renderSection();

		fireEvent.click(screen.getByText("导出备份"));
		fireEvent.change(screen.getByPlaceholderText(/设置 6 位/), { target: { value: "123456" } });
		await waitFor(() =>
			expect((screen.getByRole("button", { name: "导出" }) as HTMLButtonElement).disabled).toBe(
				false,
			),
		);
		fireEvent.click(screen.getByText("导出"));

		await waitFor(() =>
			expect(post).toHaveBeenCalledWith(
				"/api/system/backup/export",
				expect.objectContaining({ kind: "full", pin: "123456" }),
			),
		);
		await waitFor(() =>
			expect(download).toHaveBeenCalledWith(
				"bilibili-notify-full-2026-07-10.bnbackup",
				expect.objectContaining({ kind: "full" }),
			),
		);
	});

	it("imports a merge backup straight through (nothing gets deleted, so no confirmation)", async () => {
		post.mockResolvedValue({
			subscriptions: { upserted: 3, deleted: 0 },
			connections: { upserted: 0, deleted: 0 },
			targets: { upserted: 2, deleted: 0 },
			globalsApplied: true,
			restoredIntegrations: [],
			unrestoredIntegrations: [],
		});
		renderSection();

		fireEvent.click(screen.getByText("导入备份"));
		pickFile("sanitized");
		expect(await screen.findByText(/检测到：脱敏/)).toBeTruthy();
		fireEvent.click(screen.getByText("导入"));

		await waitFor(() =>
			expect(post).toHaveBeenCalledWith(
				"/api/system/backup/import",
				expect.objectContaining({ mode: "merge", dryRun: false }),
			),
		);
		expect(await screen.findByText(/订阅 3 项/)).toBeTruthy();
	});

	/**
	 * 覆盖会真删东西且不可撤销。落地前先向后端要一份 dryRun 计划,拿真实数字弹确认;
	 * 主人不点头,一个字节都不许写。
	 */
	it("confirms an overwrite that deletes things, and applies it only after 确认", async () => {
		const plan = {
			subscriptions: { upserted: 2, deleted: 1 },
			connections: { upserted: 0, deleted: 0 },
			targets: { upserted: 0, deleted: 2 },
			globalsApplied: true,
			restoredIntegrations: ["bilibili"],
			unrestoredIntegrations: [],
		};
		post.mockResolvedValue(plan);
		renderSection();

		fireEvent.click(screen.getByText("导入备份"));
		pickFile("full");
		fireEvent.change(await screen.findByPlaceholderText(/输入 6 位/), {
			target: { value: "123456" },
		});
		fireEvent.click(screen.getByText("导入"));

		// 计划先行:只发了 dryRun,还没落地。
		expect(await screen.findByText(/订阅 1 项/)).toBeTruthy();
		expect(await screen.findByText(/推送目标 2 项/)).toBeTruthy();
		expect(post).toHaveBeenCalledTimes(1);
		expect(post).toHaveBeenCalledWith(
			"/api/system/backup/import",
			expect.objectContaining({ mode: "overwrite", dryRun: true }),
		);

		fireEvent.click(screen.getByText("确认覆盖"));

		await waitFor(() =>
			expect(post).toHaveBeenCalledWith(
				"/api/system/backup/import",
				expect.objectContaining({ mode: "overwrite", dryRun: false }),
			),
		);
		expect(await screen.findByText(/导入完成/)).toBeTruthy();
	});

	it("cancels a confirmed overwrite: nothing is written", async () => {
		post.mockResolvedValue({
			subscriptions: { upserted: 0, deleted: 3 },
			connections: { upserted: 0, deleted: 0 },
			targets: { upserted: 0, deleted: 0 },
			globalsApplied: false,
			restoredIntegrations: [],
			unrestoredIntegrations: [],
		});
		renderSection();

		fireEvent.click(screen.getByText("导入备份"));
		pickFile("full");
		fireEvent.change(await screen.findByPlaceholderText(/输入 6 位/), {
			target: { value: "123456" },
		});
		fireEvent.click(screen.getByText("导入"));

		fireEvent.click(await screen.findByText("再想想"));

		expect(post).toHaveBeenCalledTimes(1);
		expect(screen.queryByText(/导入完成/)).toBeNull();
	});

	it("surfaces a rejected import (wrong PIN) instead of failing silently", async () => {
		post.mockRejectedValue(new ApiError(400, undefined, "备份 PIN 错误，或文件已损坏"));
		renderSection();

		fireEvent.click(screen.getByText("导入备份"));
		pickFile("full");
		fireEvent.change(await screen.findByPlaceholderText(/输入 6 位/), {
			target: { value: "999999" },
		});
		fireEvent.click(screen.getByText("导入"));

		expect(await screen.findByText(/PIN 错误/)).toBeTruthy();
	});
});

describe("export effective-default preview", () => {
	it("names defaulted paths without original values before exporting", async () => {
		vi.mocked(api.get).mockResolvedValue({
			defaultedSettings: [
				["core", "logging"],
				["bilibili", "healthCheckMinutes"],
			],
		});
		renderSection();
		fireEvent.click(screen.getByText("导出备份"));
		expect(await screen.findByText("core.logging")).toBeTruthy();
		expect(screen.getByText("bilibili.healthCheckMinutes")).toBeTruthy();
		expect(post).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("checkbox", { name: /设置/ }));
		expect(screen.queryByText("core.logging")).toBeNull();
	});
	it("blocks selected settings on preview failure and offers retry without exporting", async () => {
		vi.mocked(api.get).mockRejectedValue(new Error("preview unavailable"));
		renderSection();
		fireEvent.click(screen.getByText("导出备份"));
		fireEvent.click(screen.getByRole("button", { name: /脱敏导出/ }));
		expect(await screen.findByText(/preview unavailable/)).toBeTruthy();
		expect((screen.getByRole("button", { name: "导出" }) as HTMLButtonElement).disabled).toBe(true);
		vi.mocked(api.get).mockResolvedValue({ defaultedSettings: [] });
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		await waitFor(() =>
			expect((screen.getByRole("button", { name: "导出" }) as HTMLButtonElement).disabled).toBe(
				false,
			),
		);
		expect(post).not.toHaveBeenCalled();
	});
});

it.each(["cancel", "confirm"] as const)(
	"translated overwrite plan keeps the real deletion counts and waits for %s",
	async (action) => {
		const plan = {
			subscriptions: { upserted: 2, deleted: 1 },
			targets: { upserted: 0, deleted: 2 },
			connections: { upserted: 0, deleted: 1 },
			globalsApplied: true,
			restoredIntegrations: [],
			unrestoredIntegrations: [],
		};
		post.mockResolvedValue(plan);
		renderSection();
		fireEvent.click(screen.getByText("导入备份"));
		pickFile("full");
		fireEvent.change(await screen.findByPlaceholderText(/输入 6 位/), {
			target: { value: "123456" },
		});
		fireEvent.click(screen.getByText("导入"));
		const heading = await screen.findByText("覆盖导入会删除现有配置");
		const dialog = heading.closest('[role="dialog"]') as HTMLElement;
		for (const [locale, title, counts, confirm, cancel] of [
			[
				"en",
				"Overwrite import will delete existing settings",
				"Subscriptions: 1 item, Push targets: 2 items, Push connections: 1 item",
				"Confirm overwrite",
				"Go back",
			],
			[
				"ja",
				"上書きインポートで既存の設定が削除されます",
				"購読 1件、送信先 2件、プッシュ接続 1件",
				"上書きを確認",
				"戻る",
			],
			[
				"zh-TW",
				"覆寫匯入將刪除現有設定",
				"訂閱 1 項、推播目標 2 項、推播連線 1 項",
				"確認覆寫",
				"返回",
			],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(dialog.isConnected).toBe(true);
			expect(within(dialog).getByText(title)).toBeTruthy();
			expect(dialog.textContent).toContain(counts);
			expect(within(dialog).getByRole("button", { name: confirm })).toBeTruthy();
			expect(within(dialog).getByRole("button", { name: cancel })).toBeTruthy();
			expect(post).toHaveBeenCalledOnce();
			expect(post).toHaveBeenLastCalledWith(
				"/api/system/backup/import",
				expect.objectContaining({ mode: "overwrite", pin: "123456", dryRun: true }),
			);
		}
		fireEvent.click(
			within(dialog).getByRole("button", { name: action === "confirm" ? "確認覆寫" : "返回" }),
		);
		if (action === "cancel") {
			expect(post).toHaveBeenCalledOnce();
			expect(screen.queryByText("覆寫匯入將刪除現有設定")).toBeNull();
		} else {
			await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
			expect(post).toHaveBeenLastCalledWith("/api/system/backup/import", {
				backup: {
					format: BACKUP_FORMAT,
					schemaVersion: 1,
					kind: "full",
					createdAt: "2026-07-10T00:00:00.000Z",
					sections: {},
				},
				mode: "overwrite",
				pin: "123456",
				dryRun: false,
			});
		}
	},
);

it.each([
	[
		"ja",
		"ご主人様、完全バックアップをダウンロードしました。アカウントとパスワードが入っているので、大切に保管し、ほかの方には渡さないでくださいね。",
	],
	["zh-TW", "主人，完整備份已下載，裡面有您的帳號和密碼，請妥善保管、不要外傳喔。"],
] as const)("%s 女仆下载提醒随语言重画，不再次导出", async (locale, notice) => {
	post.mockResolvedValue({
		format: BACKUP_FORMAT,
		kind: "full",
		createdAt: "2026-07-10T09:00:00.000Z",
	});
	renderSection();
	fireEvent.click(screen.getByText("导出备份"));
	fireEvent.change(screen.getByPlaceholderText(/设置 6 位/), { target: { value: "123456" } });
	await waitFor(() =>
		expect((screen.getByRole("button", { name: "导出" }) as HTMLButtonElement).disabled).toBe(
			false,
		),
	);
	fireEvent.click(screen.getByRole("button", { name: "导出" }));
	await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
	act(() => i18n.set({ locale, voice: "maid" }));
	expect(screen.getByText(notice)).toBeTruthy();
	expect(post).toHaveBeenCalledTimes(1);
	expect(download).toHaveBeenCalledTimes(1);
	expect(download).toHaveBeenCalledWith(
		"bilibili-notify-full-2026-07-10.bnbackup",
		expect.objectContaining({ kind: "full" }),
	);
});
