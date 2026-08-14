/**
 * ModalShell — overlay + centered card + ESC + click-outside.
 *
 * Renders into a portal at `document.body` so the `fixed` overlay is
 * positioned against the viewport, not whatever ancestor happens to have
 * a `transform` (e.g. page-level `bn-anim-fade-in` keeps a residual
 * `translateY(0)` via the animation's `both` fill mode, which would otherwise
 * make the overlay a child of that page-sized containing block and clip the
 * backdrop to the page width).
 *
 * Body padding is left to the caller so dialogs that need flush headers
 * (e.g. cover gradients) can opt out.
 */

import { type CSSProperties, type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";
import { Btn } from "./atoms";

export interface ModalShellProps {
	children: ReactNode;
	onCancel: () => void;
	width: number;
	/** Body className override; defaults to `"p-6"`. Pass `""` to opt out. */
	bodyClassName?: string;
	/** Optional inline style merged onto the inner card (e.g. maxHeight). */
	bodyStyle?: CSSProperties;
}

export function ModalShell({
	children,
	onCancel,
	width,
	bodyClassName = "p-6",
	bodyStyle,
}: ModalShellProps) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCancel();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onCancel]);
	if (typeof document === "undefined") return null;
	return createPortal(
		<div
			className="bn-anim-fade-in fixed inset-0 z-300 flex items-center justify-center bg-bn-overlay px-4 pb-4 pt-22 backdrop-blur-xs"
			role="presentation"
		>
			<button
				type="button"
				aria-label="关闭弹窗"
				onClick={onCancel}
				className="absolute inset-0 cursor-default border-0 bg-transparent"
			/>
			<div
				role="dialog"
				aria-modal="true"
				className={`relative max-h-full overflow-y-auto rounded-bn-card bg-bn-surface-strong text-bn-text-primary ${bodyClassName}`}
				style={{
					width,
					boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
					...bodyStyle,
				}}
			>
				{children}
			</div>
		</div>,
		document.body,
	);
}

export interface ConfirmDialogProps {
	/** 标题行(粗体)。省略则只显示 message。 */
	title?: string;
	message: ReactNode;
	/** 确认按钮文案,默认「确认」。 */
	confirmLabel?: string;
	/** 取消按钮文案,默认「取消」。 */
	cancelLabel?: string;
	/** confirm 按钮用 danger 红色样式 —— 销毁性操作(如丢弃修改)。 */
	danger?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

/**
 * ConfirmDialog — ModalShell 之上的轻量「确认 / 取消」对话框,替代浏览器原生
 * `window.confirm`,与应用 UI 风格一致。ESC / 点击遮罩 = onCancel。
 */
export function ConfirmDialog({
	title,
	message,
	confirmLabel = "确认",
	cancelLabel = "取消",
	danger = false,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	return (
		<ModalShell onCancel={onCancel} width={340} bodyClassName="p-5">
			{title ? (
				<div className="mb-1.5 text-[14px] font-bold text-bn-text-primary">{title}</div>
			) : null}
			<div className="text-[13px] leading-relaxed text-bn-text-secondary">{message}</div>
			<div className="mt-4 flex justify-end gap-2">
				<Btn variant="outline" size="sm" onClick={onCancel}>
					{cancelLabel}
				</Btn>
				<Btn variant={danger ? "danger" : "primary"} size="sm" onClick={onConfirm}>
					{confirmLabel}
				</Btn>
			</div>
		</ModalShell>
	);
}
