import { Btn, Icon, NoticeCard, NoticeStack, Pill } from "@bilibili-notify/ui";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { FEATURE_DESCRIPTORS, PUSH_STATUS_META } from "../config/push-features";
import { useSources } from "../hooks/useSources";
import { useT } from "../i18n";
import { subscriptionPlatformOf } from "../pages/subscriptions/subscription-source";
import {
	AUTO_DISMISS_MS,
	type PushEventView,
	type ToastItem,
	useToastStore,
} from "../store/notifications";
import { historyRowIdentity } from "../utils/creator-display";
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
	const tx = useT();
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
	const meta = FEATURE_DESCRIPTORS[view.feature];
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
			// 推送家族色是逐特性的内容语义色,动态染色走 style(站规允许的那一种)。
			tileStyle={{
				background: `color-mix(in srgb, ${meta.tone} 12%, transparent)`,
				color: meta.tone,
			}}
			title={
				<>
					{meta.eventLabel}
					{marked ? (
						<span className="ml-1.5 text-bn-2xs font-semibold" style={{ color: status.tone }}>
							{view.status === "failed"
								? tx("sourceUi.components.toast.shell.title.1")
								: status.label}
						</span>
					) : null}
				</>
			}
			time={formatHm(view.createdAt)}
			onClose={() => dismiss(item.id)}
			style={marked ? { borderColor: edge } : undefined}
		>
			<div className="mt-0.5 flex items-center gap-1.5 text-bn-xs text-bn-text-secondary">
				<ExtensionRowWho view={view} />
				{count > 1 ? (
					<Pill color={meta.tone} subtle size="sm">
						{count}
						{tx("sourceUi.components.toast.shell.ToastCard.2")}
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
							{tx("sourceUi.components.toast.shell.ToastCard.3")}
						</Btn>
					</Link>
				</div>
			) : null}
		</NoticeCard>
	);
}

/**
 * 拓展行「这是谁」那行小字:「平台名 · 外部 id」(ADR-0019 决策 73)。平台名照来源表(取自已装拓展的清单);
 * 两张表没回来、或拓展卸载了取不到,写拓展 id。单拆一个组件:只有拓展行要去读来源表,B 站行不白问一次。
 */
function ExtensionRowWho({ view }: { view: PushEventView }) {
	const sources = useSources().data?.sources;
	return (
		// 外部 id 可以很长(抖音的 sec_uid 七八十个字符),截断而不是把「N 条」胶囊挤出卡外。
		<span className="min-w-0 truncate">
			{historyRowIdentity(view, subscriptionPlatformOf(view.identity, sources))}
		</span>
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
