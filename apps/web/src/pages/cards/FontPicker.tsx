/** Font mode stays in the original field; uploaded assets use the shared single-selection dialog. */
import { Btn, ErrorNote, HintNote, Picker, WarnNote } from "@bilibili-notify/ui";
import { useState } from "react";
import { TInput } from "../../components/forms";
import { useLibrary } from "../../components/library/library-data";
import { LibraryPicker } from "../../components/library/library-picker";
import { useT } from "../../i18n";
import { errorTextOf } from "../../services/error-text";
import {
	type FontChoice,
	fontSelection,
	fontSizeWarning,
	pickDefaultFont,
	pickFamilyFont,
	pickUploadedFont,
} from "./font-ops";

export function FontPicker({
	value,
	onChange,
	onAssetDeleted,
}: {
	value: FontChoice;
	onChange: (next: FontChoice) => void;
	onAssetDeleted?: (id: string) => void;
}) {
	const t = useT(),
		list = useLibrary("fonts");
	const known = list.isSuccess && !list.isError;
	const sel = fontSelection(value, known ? list.entries.map((entry) => entry.id) : null);
	const inferMode = (choice: FontChoice) =>
		choice.fontAsset ? "uploaded" : choice.font ? "custom" : "default";
	const [selection, setSelection] = useState({ ...value, mode: inferMode(value) });
	if (selection.font !== value.font || selection.fontAsset !== value.fontAsset) {
		setSelection({ ...value, mode: inferMode(value) });
	}
	const mode =
		selection.font === value.font && selection.fontAsset === value.fontAsset
			? selection.mode
			: inferMode(value);
	const setMode = (mode: string) => setSelection((previous) => ({ ...previous, mode }));
	const change = (next: FontChoice) => {
		setSelection((previous) => ({ ...next, mode: previous.mode }));
		onChange(next);
	};

	const [beforeMachine, afterMachine] = t("library.fonts.localHint", { machine: "\u0000" }).split(
		"\u0000",
	);
	const current = known ? list.entries.find((entry) => entry.id === value.fontAsset) : undefined;
	const warn = sel.kind === "uploaded" && known ? fontSizeWarning(current?.size ?? 0) : null;
	return (
		<div className="space-y-2">
			<Picker
				value={mode}
				onChange={(next) => {
					setMode(next);
					if (next === "default") change(pickDefaultFont(value));
					else if (next === "custom") change(pickFamilyFont(value, value.font));
				}}
				options={[
					{ value: "default", label: t("library.defaultMode") },
					{ value: "uploaded", label: t("library.uploadedMode") },
					{ value: "custom", label: t("library.customMode") },
				]}
			/>
			{mode === "default" ? (
				<p className="text-bn-2xs text-bn-text-tertiary">{t("library.fonts.defaultHint")}</p>
			) : null}
			{mode === "uploaded" ? (
				<>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<span className="min-w-0 break-words text-bn-xs text-bn-text-secondary">
							{!known
								? t("library.fontUnknown")
								: (current?.name ??
									(value.fontAsset ? t("library.fontMissingShort") : t("library.noFontSelected")))}
						</span>
						<LibraryPicker
							kind="fonts"
							value={value.fontAsset ? [value.fontAsset] : []}
							onChange={(ids) => {
								if (ids[0]) change(pickUploadedFont(value, ids[0]));
							}}
							onAssetDeleted={(id) => {
								if (id === value.fontAsset) change(pickDefaultFont(value));
								onAssetDeleted?.(id);
							}}
						/>
					</div>
					{sel.kind === "missing" ? (
						<HintNote tone="danger" className="flex items-center gap-2">
							<span className="flex-1">{t("library.fonts.missing")}</span>
							<Btn
								variant="danger-outline"
								size="sm"
								onClick={() => {
									setMode("default");
									change(pickDefaultFont(value));
								}}
							>
								{t("library.fonts.clear")}
							</Btn>
						</HintNote>
					) : null}
				</>
			) : null}
			<div hidden={mode !== "custom"} className="space-y-1">
				<TInput
					ariaLabel={t("library.fonts.family")}
					value={value.font}
					placeholder={t("library.fonts.familyPlaceholder")}
					onChange={(family) => change(pickFamilyFont(value, family))}
				/>
				<p className="text-bn-2xs text-bn-text-tertiary">
					{beforeMachine}
					<strong>{t("library.fonts.renderingMachine")}</strong>
					{afterMachine}
				</p>
			</div>
			{list.isError ? (
				<ErrorNote size="sm">
					{t("library.readFailed")}
					<p className="my-2 break-words">{errorTextOf(list.error)}</p>
					<Btn size="sm" variant="outline" onClick={() => void list.refetch()}>
						{t("library.retry")}
					</Btn>
				</ErrorNote>
			) : null}
			{warn ? <WarnNote size="sm">{warn}</WarnNote> : null}
		</div>
	);
}
