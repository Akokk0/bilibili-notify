import type { ComponentProps, ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { errorDetails } from "../api/client";

export interface ConfirmOptions {
	readonly title?: string;
	readonly message: string;
	readonly confirmText?: string;
	readonly cancelText?: string;
	readonly danger?: boolean;
}

type ConfirmRequest = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmRequest | null>(null);

export function ConfirmProvider({ children }: { readonly children: ReactNode }) {
	const [options, setOptions] = useState<ConfirmOptions | null>(null);
	const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

	const requestConfirmation = useCallback<ConfirmRequest>((nextOptions) => {
		resolverRef.current?.(false);
		return new Promise<boolean>((resolve) => {
			resolverRef.current = resolve;
			setOptions(nextOptions);
		});
	}, []);

	const settle = useCallback((confirmed: boolean) => {
		const resolve = resolverRef.current;
		resolverRef.current = null;
		setOptions(null);
		resolve?.(confirmed);
	}, []);

	useEffect(() => {
		return () => {
			resolverRef.current?.(false);
			resolverRef.current = null;
		};
	}, []);

	return (
		<ConfirmContext.Provider value={requestConfirmation}>
			{children}
			<ConfirmDialog
				options={options}
				onCancel={() => settle(false)}
				onConfirm={() => settle(true)}
			/>
		</ConfirmContext.Provider>
	);
}

export function useConfirm(): ConfirmRequest {
	const requestConfirmation = useContext(ConfirmContext);
	if (!requestConfirmation) throw new Error("useConfirm must be used within ConfirmProvider");
	return requestConfirmation;
}

export function Card({
	title,
	description,
	children,
	action,
}: {
	readonly title?: string;
	readonly description?: string;
	readonly children: ReactNode;
	readonly action?: ReactNode;
}) {
	return (
		<section className="bn-glass-strong rounded-bn-card p-5 shadow-bn-card">
			{title ? (
				<header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div>
						<h2 className="font-semibold text-lg text-bn-text-primary">{title}</h2>
						{description ? (
							<p className="mt-1 text-bn-text-secondary text-sm">{description}</p>
						) : null}
					</div>
					{action ? <div className="shrink-0">{action}</div> : null}
				</header>
			) : null}
			{children}
		</section>
	);
}

export function Button({
	tone = "secondary",
	className = "",
	...props
}: ComponentProps<"button"> & {
	readonly tone?: "primary" | "secondary" | "danger" | "ghost";
}) {
	const toneClass = {
		primary: "bg-bn-pink text-white shadow-sm hover:bg-[#f45f8b] disabled:bg-pink-200",
		secondary:
			"bg-white text-bn-text-primary ring-1 ring-black/10 hover:bg-bn-blue-soft disabled:text-bn-text-secondary",
		danger: "bg-red-500 text-white hover:bg-red-600 disabled:bg-red-200",
		ghost: "bg-transparent text-bn-text-tertiary hover:bg-white/70",
	}[tone];
	return (
		<button
			{...props}
			className={`inline-flex items-center justify-center rounded-bn-pill px-4 py-2 font-medium text-sm transition disabled:cursor-not-allowed disabled:opacity-70 ${toneClass} ${className}`}
		/>
	);
}

export function ConfirmDialog({
	options,
	onCancel,
	onConfirm,
}: {
	readonly options: ConfirmOptions | null;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	const titleId = useId();
	const messageId = useId();
	const confirmRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!options) return;
		confirmRef.current?.focus();
	}, [options]);

	useEffect(() => {
		if (!options) return;
		const handler = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onCancel();
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				onConfirm();
			}
		};
		globalThis.addEventListener("keydown", handler);
		return () => globalThis.removeEventListener("keydown", handler);
	}, [onCancel, onConfirm, options]);

	if (!options) return null;

	const title = options.title ?? "确认操作";
	const confirmText = options.confirmText ?? "确定";
	const cancelText = options.cancelText ?? "取消";

	return (
		<div className="fixed inset-0 z-50 grid place-items-center bg-black/35 px-4 py-6">
			<div
				aria-describedby={messageId}
				aria-labelledby={titleId}
				aria-modal="true"
				className="bn-glass-strong w-full max-w-md rounded-bn-card p-5 shadow-bn-elev"
				role="dialog"
			>
				<h2 className="font-semibold text-bn-text-primary text-lg" id={titleId}>
					{title}
				</h2>
				<p
					className="mt-3 whitespace-pre-wrap text-bn-text-tertiary text-sm leading-relaxed"
					id={messageId}
				>
					{options.message}
				</p>
				<div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
					<Button onClick={onCancel}>{cancelText}</Button>
					<Button ref={confirmRef} tone={options.danger ? "danger" : "primary"} onClick={onConfirm}>
						{confirmText}
					</Button>
				</div>
			</div>
		</div>
	);
}

export function Field({
	label,
	hint,
	children,
}: {
	readonly label: string;
	readonly hint?: string;
	readonly children: ReactNode;
}) {
	return (
		<div className="grid gap-1.5 text-sm">
			<span className="font-medium text-bn-text-tertiary">{label}</span>
			{children}
			{hint ? <span className="text-bn-text-secondary text-xs leading-relaxed">{hint}</span> : null}
		</div>
	);
}

export function Input(props: ComponentProps<"input">) {
	return (
		<input
			{...props}
			className={`rounded-xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-bn-pink focus:ring-2 focus:ring-bn-pink/15 ${props.className ?? ""}`}
		/>
	);
}

export function Select(props: ComponentProps<"select">) {
	return (
		<select
			{...props}
			className={`rounded-xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-bn-pink focus:ring-2 focus:ring-bn-pink/15 ${props.className ?? ""}`}
		/>
	);
}

export function TextArea(props: ComponentProps<"textarea">) {
	return (
		<textarea
			{...props}
			className={`min-h-24 rounded-xl border border-black/10 bg-white/80 px-3 py-2 outline-none transition focus:border-bn-pink focus:ring-2 focus:ring-bn-pink/15 ${props.className ?? ""}`}
		/>
	);
}

export function Toggle({
	checked,
	onChange,
	label,
	hint,
}: {
	readonly checked: boolean;
	readonly onChange: (checked: boolean) => void;
	readonly label: string;
	readonly hint?: string;
}) {
	return (
		<button
			type="button"
			onClick={() => onChange(!checked)}
			className="flex w-full items-center justify-between gap-4 rounded-2xl bg-white/70 px-4 py-3 text-left ring-1 ring-black/5 transition hover:bg-white"
		>
			<span>
				<span className="block font-medium text-bn-text-primary text-sm">{label}</span>
				{hint ? <span className="mt-0.5 block text-bn-text-secondary text-xs">{hint}</span> : null}
			</span>
			<span
				className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? "bg-bn-pink" : "bg-gray-300"}`}
			>
				<span
					className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition ${checked ? "left-6" : "left-1"}`}
				/>
			</span>
		</button>
	);
}

export function Badge({
	children,
	tone = "neutral",
}: {
	readonly children: ReactNode;
	readonly tone?: "neutral" | "success" | "warn" | "danger" | "info";
}) {
	const toneClass = {
		neutral: "bg-gray-100 text-bn-text-tertiary",
		success: "bg-emerald-50 text-emerald-700",
		warn: "bg-amber-50 text-amber-700",
		danger: "bg-red-50 text-red-700",
		info: "bg-bn-blue-soft text-bn-blue",
	}[tone];
	return (
		<span className={`inline-flex rounded-bn-pill px-2.5 py-1 font-medium text-xs ${toneClass}`}>
			{children}
		</span>
	);
}

export function ErrorBanner({ error }: { readonly error: unknown }) {
	if (!error) return null;
	const details = errorDetails(error);
	return (
		<div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-red-700 text-sm">
			<div className="font-medium">{details.summary}</div>
			{details.detail ? (
				<details className="mt-2 whitespace-pre-wrap text-red-600 text-xs">
					<summary className="cursor-pointer">展开详情</summary>
					{details.detail}
				</details>
			) : null}
		</div>
	);
}

export function EmptyState({ children }: { readonly children: ReactNode }) {
	return (
		<div className="rounded-2xl border border-dashed border-black/10 bg-white/45 p-6 text-center text-bn-text-secondary text-sm">
			{children}
		</div>
	);
}

export function ConfirmButton({
	confirmText,
	onConfirm,
	children,
	onClick,
	tone,
	...props
}: ComponentProps<typeof Button> & {
	readonly confirmText: string;
	readonly onConfirm: () => void | Promise<void>;
}) {
	const requestConfirmation = useConfirm();
	return (
		<Button
			{...props}
			tone={tone}
			onClick={async (event) => {
				onClick?.(event);
				if (event.defaultPrevented) return;
				const confirmed = await requestConfirmation({
					title: tone === "danger" ? "确认危险操作" : "确认操作",
					message: confirmText,
					danger: tone === "danger",
				});
				if (confirmed) await onConfirm();
			}}
		>
			{children}
		</Button>
	);
}

export function SectionGrid({ children }: { readonly children: ReactNode }) {
	return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}
