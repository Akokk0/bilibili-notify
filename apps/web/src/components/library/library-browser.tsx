import {
	FONT_ASSET_WARN_BYTES,
	MAX_CARD_BG_BYTES,
	MAX_FONT_ASSET_BYTES,
} from "@bilibili-notify/internal/card-skin";
import {
	AddFileButton,
	Btn,
	EmptyNote,
	ErrorNote,
	Icon,
	IconButton,
	LoadingBlock,
	ModalShell,
	SELECTED_LANGUAGE,
} from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { ApiError } from "../../services/api";
import { errorTextOf } from "../../services/error-text";
import {
	deleteLibraryFile,
	invalidateLibrary,
	type LibraryEntry,
	type LibraryKind,
	uploadLibraryFile,
	useLibrary,
} from "./library-data";
import { LibraryImage, LibraryOrderBadge, MissingLibraryImage } from "./library-image";

interface LibraryBrowserProps {
	kind: LibraryKind;
	selection?: { ids: string[]; onSelect: (id: string) => void };
	onUploaded?: (id: string) => void;
	onPendingChange?: (busy: boolean) => void;
	onAssetDeleted?: (id: string) => void;
}
/** One resource browser for management and staged field selection, with the original caches and HTTP paths. */
export function LibraryBrowser({
	kind,
	selection,
	onUploaded,
	onPendingChange,
	onAssetDeleted,
}: LibraryBrowserProps) {
	const t = useT(),
		list = useLibrary(kind),
		qc = useQueryClient();
	const [preview, setPreview] = useState<string | null>(null),
		[deleting, setDeleting] = useState<LibraryEntry | null>(null);
	const opener = useRef<HTMLElement | null>(null),
		cancel = useRef<HTMLSpanElement>(null);
	const upload = useMutation({
		mutationFn: (file: File) => uploadLibraryFile(kind, file),
		onSuccess: async (saved) => {
			await invalidateLibrary(qc, kind);
			onUploaded?.(saved.id);
		},
	});
	const remove = useMutation({
		mutationFn: (entry: LibraryEntry) => deleteLibraryFile(kind, entry.id),
		onSuccess: async (_saved, entry) => {
			onAssetDeleted?.(entry.id);
			await invalidateLibrary(qc, kind);
			setDeleting(null);
			if (opener.current?.isConnected) opener.current.focus();
		},
	});
	useEffect(() => {
		onPendingChange?.(upload.isPending);
	}, [onPendingChange, upload.isPending]);
	useEffect(() => {
		if (deleting) cancel.current?.querySelector("button")?.focus();
	}, [deleting]);
	const beginDelete = (entry: LibraryEntry) => {
		opener.current = document.activeElement as HTMLElement;
		remove.reset();
		setDeleting(entry);
	};
	const closeDelete = () => {
		if (remove.isPending) return;
		setDeleting(null);
		opener.current?.focus();
	};
	const blocked = remove.error instanceof ApiError && remove.error.code === "conflict";
	const deleteButton = (entry: LibraryEntry, index: number) =>
		!selection ? (
			<IconButton
				icon={<Icon.trash size={13} />}
				size="lg"
				tone="danger"
				disabled={remove.isPending || upload.isPending}
				label={
					kind === "images"
						? t("library.deleteImage", { number: index + 1 })
						: t("library.deleteFont", { name: entry.name ?? entry.id })
				}
				onClick={() => beginDelete(entry)}
			/>
		) : null;
	function content() {
		if (list.isError)
			return (
				<ErrorNote size="sm">
					{t("library.readFailed")}
					<p className="my-2 break-words">{errorTextOf(list.error)}</p>
					<Btn size="sm" variant="outline" onClick={() => void list.refetch()}>
						{t("library.retry")}
					</Btn>
				</ErrorNote>
			);
		if (list.isPending) return <LoadingBlock label={t("library.loading")} />;
		if (list.entries.length === 0 && (kind === "fonts" || !selection?.ids.length))
			return (
				<EmptyNote>
					<span className="block font-medium">
						{kind === "images" ? t("library.emptyImages") : t("library.emptyFonts")}
					</span>
					<span className="mt-1 block text-bn-xs">{t("library.emptyHint")}</span>
				</EmptyNote>
			);
		if (kind === "images")
			return (
				<div className="bn-library-grid">
					{list.entries.map((entry, index) => {
						const order = selection?.ids.indexOf(entry.id) ?? -1;
						return (
							<div
								key={entry.id}
								className={`bn-library-image-card ${order >= 0 ? "bn-library-selected" : ""}`}
							>
								<button
									type="button"
									data-bn="option"
									className="bn-library-image-target"
									aria-pressed={selection ? order >= 0 : undefined}
									title={selection ? t("library.images.toggle") : undefined}
									aria-label={
										selection
											? t("library.selectImage", { number: index + 1 })
											: t("library.previewImage", { number: index + 1 })
									}
									onClick={() => {
										if (selection) selection.onSelect(entry.id);
										else {
											opener.current = document.activeElement as HTMLElement;
											setPreview(entry.id);
										}
									}}
								>
									<LibraryImage
										id={entry.id}
										alt={t("library.imageNumber", { number: index + 1 })}
									/>
									{order >= 0 ? <LibraryOrderBadge>{order + 1}</LibraryOrderBadge> : null}
								</button>
								<div className="bn-library-image-meta">
									<span className="text-bn-xs text-bn-text-secondary">
										{t("library.imageNumber", { number: index + 1 })} ·{" "}
										{entry.id.split(".").pop()?.toUpperCase()}
									</span>
									{deleteButton(entry, index)}
								</div>
							</div>
						);
					})}
					{selection
						? selection.ids
								.filter((id) => !list.entries.some((entry) => entry.id === id))
								.map((id) => (
									<MissingLibraryImage
										key={id}
										order={selection.ids.indexOf(id)}
										onRemove={() => selection.onSelect(id)}
									/>
								))
						: null}
				</div>
			);
		return (
			<div className="space-y-2">
				{list.entries.map((entry, index) => {
					const active = selection?.ids.includes(entry.id) ?? false;
					const description = (
						<>
							<span className="bn-library-font-glyph" aria-hidden>
								Aa
							</span>
							<span className="min-w-0 flex-1">
								<span className="block break-words text-bn-sm font-semibold">
									{entry.name ?? entry.id}
								</span>
								{entry.size !== undefined ? (
									<span className="mt-1 block text-bn-xs text-bn-text-tertiary">
										{t("library.fontFileMeta", { mb: (entry.size / 1024 / 1024).toFixed(1) })}
									</span>
								) : null}
								{(entry.size ?? 0) > FONT_ASSET_WARN_BYTES ? (
									<span className="mt-1 block text-bn-xs text-bn-text-secondary">
										{t("library.largeFontHint")}
									</span>
								) : null}
							</span>
							{active ? <Icon.check size={15} /> : null}
						</>
					);
					return (
						<div
							key={entry.id}
							data-bn={selection ? (active ? "option option-active" : "option") : undefined}
							className={`bn-library-font-row ${active ? SELECTED_LANGUAGE : ""}`}
						>
							{selection ? (
								<button
									type="button"
									data-bn="option"
									aria-label={t("library.selectFont", { name: entry.name ?? entry.id })}
									aria-pressed={active}
									className="flex min-w-0 flex-1 items-center gap-3 text-left"
									onClick={() => selection.onSelect(entry.id)}
								>
									{description}
								</button>
							) : (
								<div className="flex min-w-0 flex-1 items-center gap-3">{description}</div>
							)}
							{deleteButton(entry, index)}
						</div>
					);
				})}
			</div>
		);
	}
	return (
		<>
			<div className="bn-library-toolbar">
				<p className="text-bn-xs text-bn-text-tertiary">
					{kind === "images"
						? t("library.imageFormats", { mb: MAX_CARD_BG_BYTES / 1024 / 1024 })
						: t("library.fontFormats", { mb: MAX_FONT_ASSET_BYTES / 1024 / 1024 })}
				</p>
				<AddFileButton
					accept={kind === "images" ? "image/png,image/jpeg,image/webp" : ".woff2,.woff,.ttf,.otf"}
					uploading={upload.isPending}
					onFile={(file) => {
						if (file && !upload.isPending) upload.mutate(file);
					}}
					className="inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-2 text-bn-xs"
				>
					<Icon.plus size={13} />
					{kind === "images" ? t("library.uploadImage") : t("library.fonts.upload")}
				</AddFileButton>
			</div>
			{upload.isError ? (
				<ErrorNote size="sm" className="mb-3">
					{errorTextOf(upload.error)}
				</ErrorNote>
			) : null}
			{content()}
			{deleting ? (
				<ModalShell
					title={
						kind === "images" ? t("library.confirmDeleteImage") : t("library.confirmDeleteFont")
					}
					width={420}
					onCancel={closeDelete}
				>
					<p className="text-bn-sm text-bn-text-secondary">{t("library.deleteHint")}</p>
					{deleting.name ? <p className="mt-3 break-words text-bn-xs">{deleting.name}</p> : null}
					{remove.isError ? (
						<ErrorNote size="sm" className="mt-3">
							<p className="break-words">{errorTextOf(remove.error)}</p>
						</ErrorNote>
					) : null}
					<div className="mt-4 flex justify-end gap-2">
						<span ref={cancel}>
							<Btn size="sm" variant="outline" disabled={remove.isPending} onClick={closeDelete}>
								{remove.isError ? t("library.close") : t("library.cancel")}
							</Btn>
						</span>
						{!blocked ? (
							<Btn
								size="sm"
								variant="danger-outline"
								disabled={remove.isPending}
								onClick={() => {
									if (deleting && !remove.isPending) remove.mutate(deleting);
								}}
							>
								{remove.isPending
									? t("library.deleting")
									: remove.isError
										? t("library.retryDelete")
										: t("library.delete")}
							</Btn>
						) : null}
					</div>
				</ModalShell>
			) : null}
			{preview ? (
				<ImagePreview
					id={preview}
					onClose={() => {
						setPreview(null);
						opener.current?.focus();
					}}
				/>
			) : null}
		</>
	);
}
function ImagePreview({ id, onClose }: { id: string; onClose: () => void }) {
	const t = useT(),
		close = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		close.current?.querySelector("button")?.focus();
	}, []);
	return (
		<ModalShell title={t("library.previewTitle")} width={760} onCancel={onClose}>
			<div className="bn-library-preview">
				<LibraryImage id={id} alt={t("library.previewAlt")} />
			</div>
			<p className="mt-3 break-all text-bn-xs text-bn-text-tertiary">{id}</p>
			<div className="mt-4 flex justify-end">
				<span ref={close}>
					<Btn size="sm" variant="outline" onClick={onClose}>
						{t("library.close")}
					</Btn>
				</span>
			</div>
		</ModalShell>
	);
}
