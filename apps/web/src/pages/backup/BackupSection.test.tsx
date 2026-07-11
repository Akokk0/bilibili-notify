// @vitest-environment jsdom

/**
 * 系统页「备份与恢复」一节:导出走 /api/backup/export 并把回来的信封落成下载文件;
 * 导入走 /api/backup/import 并把落地结果(增删了多少、cookie 有没有恢复)回报给主人;
 * PIN 错等后端拒绝要显式报错,不能静默。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BackupSection } from "./BackupSection";
import { BACKUP_FORMAT } from "./backup-file";

vi.mock("../../services/api", () => ({
	api: { post: vi.fn() },
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
vi.mock("./download", () => ({ downloadJson: vi.fn() }));

import { ApiError, api } from "../../services/api";
import { downloadJson } from "./download";

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
	post.mockReset();
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
		fireEvent.change(screen.getByPlaceholderText(/设置 4 位/), { target: { value: "1234" } });
		fireEvent.click(screen.getByText("导出"));

		await waitFor(() =>
			expect(post).toHaveBeenCalledWith(
				"/api/backup/export",
				expect.objectContaining({ kind: "full", pin: "1234" }),
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
			adapters: { upserted: 0, deleted: 0 },
			targets: { upserted: 2, deleted: 0 },
			globalsApplied: true,
			cookiesRestored: false,
		});
		renderSection();

		fireEvent.click(screen.getByText("导入备份"));
		pickFile("sanitized");
		expect(await screen.findByText(/检测到：脱敏/)).toBeTruthy();
		fireEvent.click(screen.getByText("导入"));

		await waitFor(() =>
			expect(post).toHaveBeenCalledWith(
				"/api/backup/import",
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
			adapters: { upserted: 0, deleted: 0 },
			targets: { upserted: 0, deleted: 2 },
			globalsApplied: true,
			cookiesRestored: true,
		};
		post.mockResolvedValue(plan);
		renderSection();

		fireEvent.click(screen.getByText("导入备份"));
		pickFile("full");
		fireEvent.change(await screen.findByPlaceholderText(/输入 4 位/), {
			target: { value: "1234" },
		});
		fireEvent.click(screen.getByText("导入"));

		// 计划先行:只发了 dryRun,还没落地。
		expect(await screen.findByText(/订阅 1 项/)).toBeTruthy();
		expect(await screen.findByText(/推送目标 2 项/)).toBeTruthy();
		expect(post).toHaveBeenCalledTimes(1);
		expect(post).toHaveBeenCalledWith(
			"/api/backup/import",
			expect.objectContaining({ mode: "overwrite", dryRun: true }),
		);

		fireEvent.click(screen.getByText("确认覆盖"));

		await waitFor(() =>
			expect(post).toHaveBeenCalledWith(
				"/api/backup/import",
				expect.objectContaining({ mode: "overwrite", dryRun: false }),
			),
		);
		expect(await screen.findByText(/导入完成/)).toBeTruthy();
	});

	it("cancels a confirmed overwrite: nothing is written", async () => {
		post.mockResolvedValue({
			subscriptions: { upserted: 0, deleted: 3 },
			adapters: { upserted: 0, deleted: 0 },
			targets: { upserted: 0, deleted: 0 },
			globalsApplied: false,
			cookiesRestored: false,
		});
		renderSection();

		fireEvent.click(screen.getByText("导入备份"));
		pickFile("full");
		fireEvent.change(await screen.findByPlaceholderText(/输入 4 位/), {
			target: { value: "1234" },
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
		fireEvent.change(await screen.findByPlaceholderText(/输入 4 位/), {
			target: { value: "9999" },
		});
		fireEvent.click(screen.getByText("导入"));

		expect(await screen.findByText(/PIN 错误/)).toBeTruthy();
	});
});
