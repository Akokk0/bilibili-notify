// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { BackupImportDialog } from "../BackupImportDialog";
import { BACKUP_FORMAT } from "../backup-file";

/**
 * 导入弹框:选文件 → 客户端识别档位;完整档要 6 位 PIN、默认覆盖;脱敏档默认合并、无 PIN;
 * 非备份文件报错且不放行导入。
 */
beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
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

	it("the overwrite / merge cards report which one is pressed, and flip with the choice", async () => {
		render(<BackupImportDialog onCancel={vi.fn()} onImport={vi.fn()} />);
		pickFile(backupFile("full"));

		const overwrite = await screen.findByRole("button", { name: /覆盖/ });
		const merge = screen.getByRole("button", { name: /合并/ });
		expect(overwrite.getAttribute("aria-pressed")).toBe("true");
		expect(merge.getAttribute("aria-pressed")).toBe("false");

		fireEvent.click(merge);

		expect(overwrite.getAttribute("aria-pressed")).toBe("false");
		expect(merge.getAttribute("aria-pressed")).toBe("true");
	});

	it("选文件框说的是虚线空位家族的话 —— 不再是统一前的手写方言", () => {
		render(<BackupImportDialog onCancel={vi.fn()} onImport={vi.fn()} />);
		const picker = screen.getByLabelText(/选择备份文件/).closest("label");
		// 内容语汇(虚线加浓边、hover 粉三件套)由 ui 库 add-controls 测试统一钉住,
		// 这里只钉「它确实是家族成员」:挂 add-slot、不再自带实底。
		expect(picker?.getAttribute("data-bn")).toBe("add-slot");
		expect(picker?.className).not.toContain("bg-bn-surface");
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

it.each(["full", "sanitized"] as const)(
	"%s backup language changes retain the parsed file, selected mode and PIN until import",
	async (kind) => {
		const onImport = vi.fn();
		render(<BackupImportDialog onCancel={vi.fn()} onImport={onImport} />);
		pickFile(backupFile(kind));
		await screen.findByText(kind === "full" ? /完整备份/ : /脱敏导出/);
		const mode = kind === "full" ? "merge" : "overwrite";
		fireEvent.click(screen.getByRole("button", { name: mode === "merge" ? /合并/ : /覆盖/ }));
		if (kind === "full")
			fireEvent.change(screen.getByPlaceholderText(/6 位/), { target: { value: "654321" } });
		for (const [locale, title, overwrite, merge, importLabel] of [
			["en", "Import / restore backup", "Overwrite", "Merge", "Import"],
			["ja", "バックアップをインポート・復元", "上書き", "統合", "インポート"],
			["zh-TW", "匯入／還原備份", "覆寫", "合併", "匯入"],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(screen.getByText(title)).toBeTruthy();
			expect(
				screen
					.getByRole("button", { name: new RegExp(mode === "merge" ? merge : overwrite) })
					.getAttribute("aria-pressed"),
			).toBe("true");
			expect(screen.getByText(/2026-07-10/)).toBeTruthy();
			if (kind === "full") expect(screen.getByDisplayValue("654321")).toBeTruthy();
			expect(
				(screen.getByRole("button", { name: importLabel }) as HTMLButtonElement).disabled,
			).toBe(false);
			expect(onImport).not.toHaveBeenCalled();
		}
		fireEvent.click(screen.getByRole("button", { name: "匯入" }));
		expect(onImport).toHaveBeenCalledOnce();
		expect(onImport).toHaveBeenCalledWith({
			backup: {
				format: BACKUP_FORMAT,
				schemaVersion: 1,
				kind,
				createdAt: "2026-07-10T00:00:00.000Z",
				sections: {},
			},
			mode,
			pin: kind === "full" ? "654321" : undefined,
		});
	},
);

it.each([
	[
		"invalid",
		'{"hello":"world"}',
		"This is not a bilibili-notify backup file",
		"bilibili-notifyのバックアップファイルではありません",
		"這不是 bilibili-notify 備份檔案",
	],
	[
		"unreadable",
		"{oops",
		"Could not parse the file. Make sure you selected a backup file.",
		"ファイルを解析できません。バックアップファイルを選択したか確認してください。",
		"無法解析檔案，請確認選擇的是備份檔案。",
	],
] as const)(
	"%s file error translates and never enables import",
	async (_kind, body, en, ja, tw) => {
		const onImport = vi.fn();
		render(<BackupImportDialog onCancel={vi.fn()} onImport={onImport} />);
		pickFile(new File([body], "x.json", { type: "application/json" }));
		await screen.findByText(_kind === "invalid" ? /不是.*备份文件/ : /文件解析失败/);
		for (const [locale, message, importLabel] of [
			["en", en, "Import"],
			["ja", ja, "インポート"],
			["zh-TW", tw, "匯入"],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(screen.getByText(message)).toBeTruthy();
			expect(
				(screen.getByRole("button", { name: importLabel }) as HTMLButtonElement).disabled,
			).toBe(true);
			expect(onImport).not.toHaveBeenCalled();
		}
	},
);

it.each([
	[
		"ja",
		"ご主人様、バックアップファイル（.bnbackup / .json）を選んでくださいね。",
		"インポート",
		"キャンセル",
	],
	["zh-TW", "主人，請選擇備份檔案（.bnbackup／.json）喔。", "匯入", "取消"],
] as const)("%s 女仆文件指引不提前导入", (locale, hint, importLabel, cancelLabel) => {
	const onImport = vi.fn();
	const onCancel = vi.fn();
	render(<BackupImportDialog onCancel={onCancel} onImport={onImport} />);
	act(() => i18n.set({ locale, voice: "maid" }));
	const picker = screen.getByLabelText(hint) as HTMLInputElement;
	expect(picker.accept).toBe(".json,.bnbackup,application/json");
	expect((screen.getByRole("button", { name: importLabel }) as HTMLButtonElement).disabled).toBe(
		true,
	);
	fireEvent.click(screen.getByRole("button", { name: cancelLabel }));
	expect(onCancel).toHaveBeenCalledTimes(1);
	expect(onImport).not.toHaveBeenCalled();
});
