import { Btn, Icon, ModalShell } from "@bilibili-notify/ui";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { toggleSelected } from "../../pages/cards/gallery-ops";
import { LibraryBrowser } from "./library-browser";
import { type LibraryKind, useLibrary } from "./library-data";

export function LibraryPicker({
	kind,
	value,
	onChange,
	onAssetDeleted,
}: {
	kind: LibraryKind;
	value: string[];
	onChange: (ids: string[]) => void;
	onAssetDeleted?: (id: string) => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLSpanElement>(null);
	const close = () => {
		setOpen(false);
		trigger.current?.querySelector("button")?.focus();
	};
	return (
		<>
			<span ref={trigger}>
				<Btn size="sm" variant="outline" onClick={() => setOpen(true)}>
					{kind === "images" ? t("library.chooseImages") : t("library.chooseFont")}
				</Btn>
			</span>
			{open ? (
				<SelectionDialog
					kind={kind}
					initial={value}
					onCancel={close}
					onConfirm={(ids) => {
						onChange(ids);
						close();
					}}
					onAssetDeleted={onAssetDeleted}
				/>
			) : null}
		</>
	);
}
function SelectionDialog({
	kind,
	initial,
	onCancel,
	onConfirm,
	onAssetDeleted,
}: {
	kind: LibraryKind;
	initial: string[];
	onCancel: () => void;
	onConfirm: (ids: string[]) => void;
	onAssetDeleted?: (id: string) => void;
}) {
	const t = useT(),
		list = useLibrary(kind);
	const [selected, setSelected] = useState(initial),
		[busy, setBusy] = useState(false);
	const body = useRef<HTMLDivElement>(null);
	useEffect(() => {
		body.current?.querySelector<HTMLButtonElement>("button")?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (!body.current?.contains(document.activeElement)) return;
			if (event.key !== "Tab") return;
			const controls = [
				...(body.current?.querySelectorAll<HTMLElement>(
					"button:not([disabled]),input:not([disabled])",
				) ?? []),
			];
			if (!controls.length) return;
			const first = controls[0],
				last = controls[controls.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
	const known = list.isSuccess && !list.isError;
	return (
		<ModalShell
			title={kind === "images" ? t("library.chooseImages") : t("library.chooseFont")}
			description={kind === "images" ? t("library.chooseImagesHint") : t("library.chooseFontHint")}
			width={740}
			onCancel={onCancel}
		>
			<div ref={body}>
				<div className="mb-3 flex justify-end">
					<Btn
						size="sm"
						variant="outline"
						icon={<Icon.link size={14} />}
						title={t("library.manageResourcesHint")}
						onClick={() =>
							window.open(`/library?category=${kind}`, "_blank", "noopener,noreferrer")
						}
					>
						{t("library.manageResources")}
					</Btn>
				</div>
				<div className="bn-library-picker-scroll">
					<LibraryBrowser
						kind={kind}
						selection={{
							ids: selected,
							onSelect: (id) =>
								setSelected((prev) => (kind === "images" ? toggleSelected(prev, id) : [id])),
						}}
						onUploaded={(id) =>
							setSelected((prev) =>
								kind === "images" ? (prev.includes(id) ? prev : [...prev, id]) : [id],
							)
						}
						onPendingChange={setBusy}
						onAssetDeleted={(id) => {
							setSelected((prev) => prev.filter((value) => value !== id));
							onAssetDeleted?.(id);
						}}
					/>
				</div>
				<div className="bn-library-picker-footer">
					<span className="text-bn-xs text-bn-text-tertiary">
						{kind === "images"
							? t("library.selectedImages", { count: selected.length })
							: selected.length
								? t("library.selectedFont")
								: t("library.noFontSelected")}
					</span>
					<div className="flex gap-2">
						<Btn size="sm" variant="outline" onClick={onCancel}>
							{t("library.cancel")}
						</Btn>
						<Btn
							size="sm"
							variant="primary"
							disabled={
								!known ||
								busy ||
								(kind === "fonts" && !list.entries.some((entry) => entry.id === selected[0]))
							}
							onClick={() => onConfirm(selected)}
						>
							{t("library.useSelected")}
						</Btn>
					</div>
				</div>
			</div>
		</ModalShell>
	);
}
