import { Btn, Icon, NoticeCard, NoticeStack, Pill } from "@bilibili-notify/ui";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { PUSH_KIND_META, PUSH_STATUS_META } from "../config/push-kinds";
import { AUTO_DISMISS_MS, type ToastItem, useToastStore } from "../store/notifications";
import { headlineOf, messageCountOf } from "../utils/push-row";

/**
 * 推送 toast 层(右下角)。卡与栈的壳子在 ui 的 NoticeCard / NoticeStack;
 * 这里只管从 {@link useToastStore} 取数、逐 kind 染色与 {@link AUTO_DISMISS_MS} 计时。
 *
 * 同一条队列也装「通知卡」(目前只有应用内更新的「有新版」):同壳同栈,区别只有
 * 两点 —— 它带一个跳转按钮,而且**不自己消失**。推送 toast 是流水,五秒走人没关系;
 * 「有新版」一年也就几回,错过了就得等下次打开面板。
 *
 * Mounted once at App root.
 */

export function ToastShell(): React.ReactElement | null {
	const items = useToastStore((s) => s.items);
	return (
		<NoticeStack corner="bottom-right" ariaLive="polite" className="w-80">
			{items.map((item) => (
				<ToastCard key={item.id} item={item} />
			))}
		</NoticeStack>
	);
}

function ToastCard({ item }: { item: ToastItem }) {
	const dismiss = useToastStore((s) => s.dismiss);
	const sticky = item.kind === "notice";
	useEffect(() => {
		if (sticky) return;
		const t = setTimeout(() => dismiss(item.id), AUTO_DISMISS_MS);
		return () => clearTimeout(t);
	}, [item.id, dismiss, sticky]);

	if (item.kind === "notice") {
		return (
			<NoticeCard
				icon={<Icon.sparkle size={16} />}
				tileStyle={{
					background: "color-mix(in srgb, var(--color-bn-pink) 12%, transparent)",
					color: "var(--color-bn-pink)",
				}}
				title={item.title}
				onClose={() => dismiss(item.id)}
			>
				{item.body ? (
					<div className="mt-1 whitespace-pre-line text-bn-xs leading-snug text-bn-text-secondary">
						{item.body}
					</div>
				) : null}
				{item.action ? (
					<div className="mt-2">
						{/* 同概览「查看全部」:Link 包 Btn,按钮观感归库、跳转归路由。 */}
						<Link to={item.action.to}>
							<Btn size="sm" variant="primary" onClick={() => dismiss(item.id)}>
								{item.action.label}
							</Btn>
						</Link>
					</div>
				) : null}
			</NoticeCard>
		);
	}

	const view = item.view;
	const meta = PUSH_KIND_META[view.kind];
	const status = PUSH_STATUS_META[view.status];
	const IconCmp = Icon[meta.icon];
	const headline = headlineOf(view);
	const count = messageCountOf(view);
	// 失败是红的;部分失败 / 无目标是警示色 —— 卡边与标题旁的小字同一口径。
	const marked = view.status !== "delivered";
	const edge = view.status === "failed" ? "var(--color-bn-danger-border)" : status.tone;
	return (
		<NoticeCard
			icon={<IconCmp size={16} />}
			// 推送家族色是逐 kind 的内容语义色,动态染色走 style(站规允许的那一种)。
			tileStyle={{
				background: `color-mix(in srgb, ${meta.tone} 12%, transparent)`,
				color: meta.tone,
			}}
			title={
				<>
					{meta.eventLabel}
					{marked ? (
						<span className="ml-1.5 text-bn-2xs font-semibold" style={{ color: status.tone }}>
							{view.status === "failed" ? "推送失败" : status.label}
						</span>
					) : null}
				</>
			}
			time={formatHm(view.ts)}
			onClose={() => dismiss(item.id)}
			style={marked ? { borderColor: edge } : undefined}
		>
			<div className="mt-0.5 flex items-center gap-1.5 text-bn-xs text-bn-text-secondary">
				<span className="tabular-nums">UID {view.uid}</span>
				{count > 1 ? (
					<Pill color={meta.tone} subtle size="sm">
						{count} 条
					</Pill>
				) : null}
			</div>
			{headline ? (
				<div className="mt-1 line-clamp-2 text-bn-xs leading-snug text-bn-text-primary">
					{headline}
				</div>
			) : null}
			{view.status === "no-targets" ? (
				<div className="mt-2">
					{/* 这类推送没有任何可用目标:直达该 UP 抽屉的「推送目标」一节。Link 包 Btn,同通知卡。 */}
					<Link to={`/subs?open=${encodeURIComponent(view.subscriptionId)}`}>
						<Btn size="sm" variant="primary" onClick={() => dismiss(item.id)}>
							去配置
						</Btn>
					</Link>
				</div>
			) : null}
		</NoticeCard>
	);
}

/** toast 只到分 —— 告警那边到秒,精度差异是语义(错误要能对时序),不是漂移。 */
function formatHm(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	return `${h}:${m}`;
}
