// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { BackupExportDialog } from "../BackupExportDialog";

/**
 * 导出弹框:完整档必须显示「文件=账号」红字警告并要求 6 位 PIN 才能导出;脱敏档无警告、
 * 无 PIN、可直接导出;勾选项如实进 onExport 载荷。
 */
beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
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

	it("the full / sanitized cards report which one is pressed, and flip with the choice", () => {
		render(<BackupExportDialog onCancel={vi.fn()} onExport={vi.fn()} />);
		const full = screen.getByRole("button", { name: /完整备份/ });
		const sanitized = screen.getByRole("button", { name: /脱敏导出/ });
		expect(full.getAttribute("aria-pressed")).toBe("true");
		expect(sanitized.getAttribute("aria-pressed")).toBe("false");

		fireEvent.click(sanitized);

		expect(full.getAttribute("aria-pressed")).toBe("false");
		expect(sanitized.getAttribute("aria-pressed")).toBe("true");
	});

	it("unchecking a section is reflected in the export payload", () => {
		const onExport = vi.fn();
		render(<BackupExportDialog onCancel={vi.fn()} onExport={onExport} />);

		fireEvent.click(screen.getByText(/脱敏/));
		fireEvent.click(screen.getByRole("checkbox", { name: /推送连接/ }));
		fireEvent.click(screen.getByText("导出"));

		expect(onExport.mock.calls[0]?.[0].sections.connections).toBe(false);
	});
});

it("translated export checks retain the PIN and selected sections and require a completed preview", () => {
	i18n.set({ locale: "en", voice: "plain" });
	const onExport = vi.fn();
	const onRetryPreview = vi.fn();
	const onCancel = vi.fn();
	const props = { onExport, onRetryPreview, onCancel };
	const { rerender } = render(<BackupExportDialog {...props} previewPending />);
	fireEvent.change(screen.getByPlaceholderText("Set a 6-digit PIN"), {
		target: { value: "123456" },
	});
	fireEvent.click(screen.getByRole("checkbox", { name: "Push connections" }));
	for (const [locale, loading, error, retry, warning, exportLabel, connections, pin] of [
		[
			"en",
			"Checking settings for export…",
			"Could not read setting issues: 原诊断",
			"Retry",
			"The settings below will be exported using their current in-memory defaults, without the original values from local files. Isolated AI service instances are excluded.",
			"Export",
			"Push connections",
			"Backup PIN (6 digits)",
		],
		[
			"ja",
			"エクスポートする設定を確認中…",
			"設定の問題を取得できませんでした: 原诊断",
			"再試行",
			"以下の項目は、ローカルファイルの元の値ではなく、現在メモリー上で使っている既定値でエクスポートします。隔離されたAIサービス設定は含まれません。",
			"エクスポート",
			"プッシュ接続",
			"バックアップPIN（数字6桁）",
		],
		[
			"zh-TW",
			"正在檢查匯出設定…",
			"無法讀取設定問題：原诊断",
			"重試",
			"下列項目會以目前記憶體中的預設值匯出，不包含本機檔案中的原值；已隔離的 AI 服務設定也不會匯出。",
			"匯出",
			"推播連線",
			"備份 PIN（6 位數字）",
		],
	] as const) {
		act(() => i18n.set({ locale }));
		rerender(<BackupExportDialog {...props} previewPending />);
		expect(screen.getByText(loading)).toBeTruthy();
		expect((screen.getByRole("button", { name: exportLabel }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		rerender(<BackupExportDialog {...props} previewError="原诊断" />);
		expect(screen.getByText(error)).toBeTruthy();
		expect((screen.getByRole("button", { name: exportLabel }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		fireEvent.click(screen.getByRole("button", { name: retry }));
		rerender(<BackupExportDialog {...props} previewPaths={[["core", "stats", "enabled"]]} />);
		expect(screen.getByText(warning)).toBeTruthy();
		expect(screen.getByText("core.stats.enabled")).toBeTruthy();
		expect((screen.getByLabelText(pin) as HTMLInputElement).value).toBe("123456");
		expect((screen.getByRole("checkbox", { name: connections }) as HTMLInputElement).checked).toBe(
			false,
		);
		expect((screen.getByRole("button", { name: exportLabel }) as HTMLButtonElement).disabled).toBe(
			false,
		);
		expect(onExport).not.toHaveBeenCalled();
	}
	expect(onRetryPreview).toHaveBeenCalledTimes(3);
	fireEvent.click(screen.getByRole("button", { name: "匯出" }));
	expect(onExport).toHaveBeenCalledOnce();
	expect(onExport).toHaveBeenCalledWith({
		kind: "full",
		pin: "123456",
		sections: { globals: true, subscriptions: true, connections: false, targets: true },
	});
});

it.each([
	[
		"ja",
		"ご主人様、このファイルにはアカウントのログイン情報とダッシュボードのパスワードが入っています。大切に保管し、ほかの方には渡さないでくださいね。数字6桁のPINは誤操作を防ぐだけなので、ファイル自体を守ることが大切です。",
		"エクスポート",
	],
	[
		"zh-TW",
		"主人，這份檔案含有帳號登入資訊和面板密碼，請妥善保管、不要外傳喔。6 位 PIN 只能避免誤操作，真正的安全還是靠保管好檔案本身。",
		"匯出",
	],
] as const)("%s 女仆安全提醒保留 PIN 和导出限制", (locale, warning, exportLabel) => {
	const onExport = vi.fn();
	render(<BackupExportDialog onCancel={vi.fn()} onExport={onExport} />);
	fireEvent.change(screen.getByPlaceholderText(/6 位/), { target: { value: "12345" } });
	act(() => i18n.set({ locale, voice: "maid" }));
	expect(screen.getByText(warning)).toBeTruthy();
	expect(screen.getByDisplayValue("12345")).toBeTruthy();
	expect((screen.getByRole("button", { name: exportLabel }) as HTMLButtonElement).disabled).toBe(
		true,
	);
	expect(onExport).not.toHaveBeenCalled();
	fireEvent.change(screen.getByDisplayValue("12345"), { target: { value: "123456" } });
	fireEvent.click(screen.getByRole("button", { name: exportLabel }));
	expect(onExport).toHaveBeenCalledTimes(1);
	expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ kind: "full", pin: "123456" }));
});
