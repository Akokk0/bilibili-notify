// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BackupExportDialog } from "./BackupExportDialog";

/**
 * 导出弹框:完整档必须显示「文件=账号」红字警告并要求 6 位 PIN 才能导出;脱敏档无警告、
 * 无 PIN、可直接导出;勾选项如实进 onExport 载荷。
 */
afterEach(cleanup);

describe("BackupExportDialog", () => {
	it("full backup shows the security warning and blocks export until a 6-digit PIN is entered", () => {
		const onExport = vi.fn();
		render(<BackupExportDialog onCancel={vi.fn()} onExport={onExport} />);

		// default kind = full
		expect(screen.getByText(/切勿外发/)).toBeTruthy();
		expect((screen.getByText("导出") as HTMLButtonElement).disabled).toBe(true);

		fireEvent.change(screen.getByPlaceholderText(/6 位/), { target: { value: "123456" } });
		expect((screen.getByText("导出") as HTMLButtonElement).disabled).toBe(false);

		fireEvent.click(screen.getByText("导出"));
		expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ kind: "full", pin: "123456" }));
	});

	it("sanitized backup has no warning, no PIN, and exports immediately", () => {
		const onExport = vi.fn();
		render(<BackupExportDialog onCancel={vi.fn()} onExport={onExport} />);

		fireEvent.click(screen.getByText(/脱敏/));

		expect(screen.queryByText(/切勿外发/)).toBeNull();
		expect((screen.getByText("导出") as HTMLButtonElement).disabled).toBe(false);

		fireEvent.click(screen.getByText("导出"));
		expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ kind: "sanitized" }));
		expect(onExport.mock.calls[0]?.[0].pin).toBeUndefined();
	});

	it("unchecking a section is reflected in the export payload", () => {
		const onExport = vi.fn();
		render(<BackupExportDialog onCancel={vi.fn()} onExport={onExport} />);

		fireEvent.click(screen.getByText(/脱敏/));
		fireEvent.click(screen.getByRole("checkbox", { name: /推送适配器/ }));
		fireEvent.click(screen.getByText("导出"));

		expect(onExport.mock.calls[0]?.[0].sections.adapters).toBe(false);
	});
});
