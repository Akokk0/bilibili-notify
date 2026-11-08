// @vitest-environment jsdom
import { createI18n, type Locale } from "@bilibili-notify/internal/i18n";
import { type PackageTextKey, withPackageDicts } from "@bilibili-notify/internal/texts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import { ConfirmDialog } from "../dialog";
import { TColor } from "../form-controls";
import { UiTextProvider } from "../texts";
import { TriStateChip } from "../tri-state";

afterEach(cleanup);
it("updates mounted form controls when the supplied translator changes", () => {
	const { rerender } = render(
		<UiTextProvider t={() => "Picker"}>
			<TColor value="#ffffff" onChange={() => {}} ariaLabel="Color" />
		</UiTextProvider>,
	);
	expect(screen.queryByLabelText("Picker")).not.toBeNull();
	const input = screen.getByLabelText("Color");
	rerender(
		<UiTextProvider t={() => "Changed picker"}>
			<TColor value="#ffffff" onChange={() => {}} ariaLabel="Color" />
		</UiTextProvider>,
	);
	expect(screen.getByLabelText("Color")).toBe(input);
	expect(screen.queryByLabelText("Changed picker")).not.toBeNull();
});

it("updates mounted shared dialog defaults and capability labels through the existing provider", () => {
	const tree = (word: string) => (
		<UiTextProvider t={() => word}>
			<ConfirmDialog
				title="Confirm action"
				message="Body"
				onConfirm={() => {}}
				onCancel={() => {}}
			/>
			<TriStateChip label="Images" state="unknown" />
		</UiTextProvider>
	);
	const { rerender } = render(tree("First"));
	expect(screen.queryAllByRole("button", { name: "First" })).toHaveLength(3);
	expect(screen.queryByTitle("Images:First")).not.toBeNull();
	rerender(tree("Second"));
	expect(screen.queryAllByRole("button", { name: "Second" })).toHaveLength(3);
	expect(screen.queryByTitle("Images:Second")).not.toBeNull();
});

it("bundled UI translations update shared controls without replacing mounted dialogs", () => {
	const texts = createI18n<PackageTextKey, Locale>({
		dicts: withPackageDicts({
			"zh-CN": { plain: {} },
			en: { plain: {} },
			ja: { plain: {} },
			"zh-TW": { plain: {} },
		}),
		fallback: "zh-CN",
		locale: "en",
		voice: "plain",
	});
	const tree = () => (
		<UiTextProvider t={texts.state().t}>
			<ConfirmDialog title="Action" message="Body" onConfirm={() => {}} onCancel={() => {}} />
			<TColor value="#ffffff" onChange={() => {}} ariaLabel="Color" />
			<TriStateChip label="Images" state="unknown" />
		</UiTextProvider>
	);
	const { rerender } = render(tree());
	const dialog = screen.getByRole("dialog");
	for (const [locale, confirm, cancel, picker, unknown] of [
		["en", "Confirm", "Cancel", "Color (color picker)", "Unknown"],
		["ja", "確認", "キャンセル", "Color（カラーピッカー）", "未確認"],
		["zh-TW", "確認", "取消", "Color（色彩選擇器）", "尚不確定"],
	] as const) {
		texts.set({ locale });
		rerender(tree());
		expect(screen.getByRole("dialog")).toBe(dialog);
		expect(screen.queryByRole("button", { name: confirm })).not.toBeNull();
		expect(screen.queryByRole("button", { name: cancel })).not.toBeNull();
		expect(screen.queryByLabelText(picker)).not.toBeNull();
		expect(screen.queryByTitle(`Images:${unknown}`)).not.toBeNull();
	}
});
