// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BackupImportDialog } from "./BackupImportDialog";
import { BACKUP_FORMAT } from "./backup-file";

/**
 * 导入弹框:选文件 → 客户端识别档位;完整档要 6 位 PIN、默认覆盖;脱敏档默认合并、无 PIN;
 * 非备份文件报错且不放行导入。
 */
afterEach(cleanup);

function backupFile(kind: "full" | "sanitized"): File {
	const doc = {
		format: BACKUP_FORMAT,
		schemaVersion: 1,
		kind,
		createdAt: "2026-07-10T00:00:00.000Z",
		sections: {},
	};
	return new File([JSON.stringify(doc)], `b.${kind === "full" ? "bnbackup" : "json"}`, {
		type: "application/json",
	});
}

function pickFile(file: File): void {
	fireEvent.change(screen.getByLabelText(/选择备份文件/), { target: { files: [file] } });
}

describe("BackupImportDialog", () => {
	it("loads a full backup, defaults to overwrite, requires a PIN, then imports", async () => {
		const onImport = vi.fn();
		render(<BackupImportDialog onCancel={vi.fn()} onImport={onImport} />);

		pickFile(backupFile("full"));

		expect(await screen.findByText(/完整备份/)).toBeTruthy();
		expect((screen.getByText("导入") as HTMLButtonElement).disabled).toBe(true);

		fireEvent.change(screen.getByPlaceholderText(/6 位/), { target: { value: "123456" } });
		fireEvent.click(screen.getByText("导入"));

		expect(onImport).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "overwrite", pin: "123456" }),
		);
	});

	it("loads a sanitized backup, defaults to merge, needs no PIN", async () => {
		const onImport = vi.fn();
		render(<BackupImportDialog onCancel={vi.fn()} onImport={onImport} />);

		pickFile(backupFile("sanitized"));

		expect(await screen.findByText(/脱敏/)).toBeTruthy();
		fireEvent.click(screen.getByText("导入"));

		expect(onImport).toHaveBeenCalledWith(expect.objectContaining({ mode: "merge" }));
		expect(onImport.mock.calls[0]?.[0].pin).toBeUndefined();
	});

	it("rejects a non-backup file and keeps import disabled", async () => {
		const onImport = vi.fn();
		render(<BackupImportDialog onCancel={vi.fn()} onImport={onImport} />);

		const bad = new File(['{"hello":"world"}'], "x.json", { type: "application/json" });
		pickFile(bad);

		expect(await screen.findByText(/不是.*备份文件/)).toBeTruthy();
		expect((screen.getByText("导入") as HTMLButtonElement).disabled).toBe(true);
		expect(onImport).not.toHaveBeenCalled();
	});
});
