import { useEffect } from "react";
import { createPortal } from "react-dom";
import {
	AUTO_DISMISS_MS,
	type PushEventSource,
	type ToastItem,
	useToastStore,
} from "../store/notifications";
import { Icon, type IconName } from "./icons";

/**
 * Notification-center toast surface. Rendered into a portal so the fixed
 * stack lives at the viewport regardless of any transformed page-level
 * ancestor (same gotcha that bit ModalShell). Items are pulled from
 * {@link useToastStore}; each auto-dismisses after {@link AUTO_DISMISS_MS}.
 *
 * Mounted once at App root.
 */
const SOURCE_META: Record<PushEventSource, { icon: IconName; tint: string; label: string }> = {
	dynamic: { icon: "dyn", tint: "#00AEEC", label: "动态" },
	live: { icon: "live", tint: "#FB7299", label: "开播" },
	sc: { icon: "sc", tint: "#FFB454", label: "SC" },
	guard: { icon: "guard", tint: "#7A5AF8", label: "上舰" },
	"special-danmaku": { icon: "mic", tint: "#10B981", label: "特别弹幕" },
	"special-enter": { icon: "user", tint: "#06B6D4", label: "特别进房" },
	"live-summary": { icon: "sparkle", tint: "#F472B6", label: "直播总结" },
};

export function ToastShell(): React.ReactElement | null {
	const items = useToastStore((s) => s.items);
	if (typeof document === "undefined") return null;
	return createPortal(
		<div
			aria-live="polite"
			className="pointer-events-none fixed bottom-4 right-4 z-200 flex w-80 flex-col gap-2"
		>
			{items.map((item) => (
				<ToastCard key={item.id} item={item} />
			))}
		</div>,
		document.body,
	);
}

function ToastCard({ item }: { item: ToastItem }) {
	const dismiss = useToastStore((s) => s.dismiss);
	useEffect(() => {
		const t = setTimeout(() => dismiss(item.id), AUTO_DISMISS_MS);
		return () => clearTimeout(t);
	}, [item.id, dismiss]);

	const meta = SOURCE_META[item.source];
	const IconCmp = Icon[meta.icon];
	const time = formatHm(item.ts);
	return (
		<div
			className="bn-anim-fade-in pointer-events-auto flex gap-2.5 rounded-bn-card border border-white/60 bg-white p-3 shadow-bn-elev"
			style={item.ok ? undefined : { borderColor: "#fecaca" }}
		>
			<div
				className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
				style={{ background: `${meta.tint}1f`, color: meta.tint }}
			>
				<IconCmp size={16} />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center justify-between gap-2">
					<span className="text-[12.5px] font-bold text-bn-text-primary">
						{meta.label}
						{item.ok ? null : (
							<span className="ml-1.5 text-[10.5px] font-semibold text-red-500">推送失败</span>
						)}
					</span>
					<span className="font-mono text-[10.5px] text-bn-text-tertiary">{time}</span>
				</div>
				<div className="mt-0.5 text-[11px] text-bn-text-secondary">
					<span className="font-mono">UID {item.uid}</span>
				</div>
				{item.text ? (
					<div className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-bn-text-primary">
						{item.text}
					</div>
				) : null}
			</div>
			<button
				type="button"
				onClick={() => dismiss(item.id)}
				className="h-5 w-5 shrink-0 cursor-pointer rounded text-bn-text-tertiary hover:bg-black/5 hover:text-bn-text-primary"
				aria-label="关闭"
			>
				<Icon.close size={11} />
			</button>
		</div>
	);
}

function formatHm(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	return `${h}:${m}`;
}
