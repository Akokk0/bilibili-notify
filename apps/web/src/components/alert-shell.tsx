import { Icon, NoticeCard, NoticeStack } from "@bilibili-notify/ui";
import { type AlertItem, useAlertStore } from "../store/alerts";

/**
 * 右上角红色告警面板。被 `engine-error` WS 事件喂养。
 *
 * 与 ToastShell 区分：
 *   - 不自动消失（错误需要主人主动确认）
 *   - 红色 + 警告 icon
 *   - 顶部一行 "组件告警 (N)" + "全部清除" 按钮
 *
 * 卡与栈的壳子在 ui 的 NoticeCard / NoticeStack。Mounted once at App root（与
 * ToastShell 并列）。
 */
export function AlertShell(): React.ReactElement | null {
	const items = useAlertStore((s) => s.items);
	const clear = useAlertStore((s) => s.clear);
	if (items.length === 0) return null;
	return (
		<NoticeStack corner="top-right" ariaLive="assertive" className="w-96">
			<div className="bn-anim-fade-in pointer-events-auto flex items-center justify-between rounded-bn-card border border-bn-danger-border bg-bn-danger-soft px-3 py-1.5 text-bn-xs font-bold text-bn-danger-text shadow-bn-elev backdrop-blur-sm">
				<span>组件告警 ({items.length})</span>
				<button
					type="button"
					onClick={clear}
					data-bn="btn"
					className="cursor-pointer rounded-sm px-2 py-0.5 text-bn-2xs font-semibold text-bn-danger-text hover:bg-bn-danger/10"
				>
					全部清除
				</button>
			</div>
			{items.map((item) => (
				<AlertCard key={item.id} item={item} />
			))}
		</NoticeStack>
	);
}

function AlertCard({ item }: { item: AlertItem }) {
	const dismiss = useAlertStore((s) => s.dismiss);
	return (
		<NoticeCard
			icon={<Icon.warning size={18} />}
			tileClassName="bg-bn-danger-soft text-bn-danger-text"
			title={item.source}
			titleClassName="text-bn-danger-text"
			time={formatHms(item.receivedAt)}
			onClose={() => dismiss(item.id)}
			style={{
				borderColor: "var(--color-bn-danger-border)",
				borderLeft: "3px solid var(--color-bn-danger)",
			}}
		>
			<div className="mt-1 text-bn-xs leading-snug text-bn-text-primary">{item.message}</div>
		</NoticeCard>
	);
}

/** 告警到秒 —— 排查错误要能对时序;toast 那边只到分。 */
function formatHms(ms: number): string {
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "";
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	const s = String(d.getSeconds()).padStart(2, "0");
	return `${h}:${m}:${s}`;
}
