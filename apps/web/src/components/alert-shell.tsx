import { createPortal } from "react-dom";
import { type AlertItem, useAlertStore } from "../store/alerts";
import { Icon } from "./icons";

/**
 * 右上角红色告警面板。被 `engine-error` WS 事件喂养。
 *
 * 与 ToastShell 区分：
 *   - 不自动消失（错误需要主人主动确认）
 *   - 红色 + 警告 icon
 *   - 顶部一行 "组件告警 (N)" + "全部清除" 按钮
 *
 * Mounted once at App root（与 ToastShell 并列）。
 */
export function AlertShell(): React.ReactElement | null {
	const items = useAlertStore((s) => s.items);
	const clear = useAlertStore((s) => s.clear);
	if (typeof document === "undefined" || items.length === 0) return null;
	return createPortal(
		<div
			aria-live="assertive"
			className="pointer-events-none fixed right-4 top-4 z-200 flex w-96 flex-col gap-2"
		>
			<div className="bn-anim-fade-in pointer-events-auto flex items-center justify-between rounded-bn-card border border-bn-danger-border bg-bn-danger-soft px-3 py-1.5 text-[11.5px] font-bold text-bn-danger-text shadow-bn-elev backdrop-blur-sm">
				<span>组件告警 ({items.length})</span>
				<button
					type="button"
					onClick={clear}
					className="cursor-pointer rounded px-2 py-0.5 text-[10.5px] font-semibold text-bn-danger-text hover:bg-red-500/10"
				>
					全部清除
				</button>
			</div>
			{items.map((item) => (
				<AlertCard key={item.id} item={item} />
			))}
		</div>,
		document.body,
	);
}

function AlertCard({ item }: { item: AlertItem }) {
	const dismiss = useAlertStore((s) => s.dismiss);
	const time = formatHms(item.receivedAt);
	return (
		<div
			className="bn-anim-fade-in pointer-events-auto flex gap-2.5 rounded-bn-card border bg-bn-surface p-3 shadow-bn-elev"
			style={{ borderColor: "var(--color-bn-danger-border)", borderLeft: "3px solid #ef4444" }}
		>
			<div
				className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-bn-danger-text"
				style={{ background: "var(--color-bn-danger-soft)" }}
				aria-hidden="true"
			>
				{/* 三角警告 inline svg；不动 Icon 集 */}
				<svg
					role="img"
					aria-label="告警"
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<title>告警</title>
					<path d="M12 2 1 22h22L12 2z" />
					<path d="M12 9v6" />
					<circle cx="12" cy="18" r="0.9" fill="currentColor" stroke="none" />
				</svg>
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center justify-between gap-2">
					<span className="text-[12.5px] font-bold text-bn-danger-text">{item.source}</span>
					<span className="font-mono text-[10.5px] text-bn-text-tertiary">{time}</span>
				</div>
				<div className="mt-1 text-[11.5px] leading-snug text-bn-text-primary">{item.message}</div>
			</div>
			<button
				type="button"
				onClick={() => dismiss(item.id)}
				className="h-5 w-5 shrink-0 cursor-pointer rounded text-bn-text-tertiary hover:bg-bn-hover-muted hover:text-bn-text-primary"
				aria-label="关闭"
			>
				<Icon.close size={11} />
			</button>
		</div>
	);
}

function formatHms(ms: number): string {
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "";
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	const s = String(d.getSeconds()).padStart(2, "0");
	return `${h}:${m}:${s}`;
}
