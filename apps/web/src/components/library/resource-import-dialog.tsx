import { Btn, ErrorNote, HintNote, ModalShell, WarnNote } from "@bilibili-notify/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { errorTextOf } from "../../services/error-text";

/** 六类资源共用的确认、错误与焦点边界；具体格式与可编辑字段仍由调用方提供。 */
export function ResourceImportDialog({
	title,
	file,
	name,
	conflict,
	warnings = [],
	pending,
	error,
	onCancel,
	onConfirm,
	children,
	confirmDisabled = false,
}: {
	title?: string;
	file?: File;
	name?: string;
	conflict?: boolean;
	warnings?: string[];
	pending: boolean;
	error?: unknown;
	onCancel: () => void;
	onConfirm: () => void;
	children?: ReactNode;
	confirmDisabled?: boolean;
}) {
	const t = useT(),
		body = useRef<HTMLDivElement>(null);
	const [image, setImage] = useState<string | null>(null);
	const [imageFailed, setImageFailed] = useState(false);
	useEffect(() => {
		setImageFailed(false);
		if (!file?.type.startsWith("image/")) return;
		const url = URL.createObjectURL(file);
		setImage(url);
		return () => URL.revokeObjectURL(url);
	}, [file]);
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null,
			node = body.current;
		const selector = "input:not([disabled]),textarea:not([disabled]),button:not([disabled])";
		node?.querySelector<HTMLElement>(selector)?.focus();
		const trap = (event: KeyboardEvent) => {
			if (event.key !== "Tab") return;
			const controls = node?.querySelectorAll<HTMLElement>(selector),
				first = controls?.[0],
				last = controls?.[controls.length - 1];
			if (!controls?.length) {
				event.preventDefault();
				node?.focus();
				return;
			}
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		node?.addEventListener("keydown", trap);
		return () => {
			node?.removeEventListener("keydown", trap);
			previous?.focus();
		};
	}, []);
	useEffect(() => {
		if (pending) body.current?.focus();
	}, [pending]);
	return (
		<ModalShell
			width={720}
			title={title ?? t("resourceImport.title")}
			description={t("resourceImport.hint")}
			onCancel={() => {
				if (!pending) onCancel();
			}}
		>
			<div ref={body} tabIndex={-1} className="space-y-4">
				{name ? <p className="break-words text-bn-sm font-semibold">{name}</p> : null}
				{file ? (
					<p className="break-words text-bn-xs text-bn-text-secondary">
						{t("resourceImport.file", { name: file.name, kb: (file.size / 1024).toFixed(1) })}
					</p>
				) : null}
				{imageFailed ? (
					<WarnNote>{t("resourceImport.imageFailed")}</WarnNote>
				) : image ? (
					<img
						src={image}
						alt={t("resourceImport.imagePreview")}
						onError={() => setImageFailed(true)}
						className="max-h-60 w-full rounded-bn-card object-contain"
					/>
				) : null}
				{conflict ? <WarnNote>{t("resourceImport.conflict")}</WarnNote> : null}
				{[...new Set(warnings)].map((warning) => (
					<HintNote key={warning}>{warning}</HintNote>
				))}
				{children}
				{error ? <ErrorNote>{errorTextOf(error)}</ErrorNote> : null}
				<div className="flex justify-end gap-2">
					<Btn variant="outline" disabled={pending} onClick={onCancel}>
						{t("library.cancel")}
					</Btn>
					<Btn variant="primary" disabled={pending || confirmDisabled} onClick={onConfirm}>
						{pending ? t("resourceImport.importing") : t("resourceImport.confirm")}
					</Btn>
				</div>
			</div>
		</ModalShell>
	);
}
