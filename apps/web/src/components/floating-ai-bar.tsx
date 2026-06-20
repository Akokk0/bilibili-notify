import { useLocation, useNavigate } from "react-router-dom";
import { useAiBarStore } from "../store/aiBar";
import { Icon } from "./icons";

/**
 * Bottom-anchored AI suggestion dock — port of `FloatingAiBar` from
 * `.bn-design/bilibili-notify-console-ui/project/variation-ac.jsx`.
 *
 * The exact `SUGGESTIONS` map mirrors the design's tab-keyed copy. Routes
 * the dashboard owns map onto those keys; unrelated routes fall back to
 * the dashboard tip. Dismissing collapses to a 44px floating gem; clicking
 * it re-opens the strip.
 */

type SuggestionKey =
	| "dashboard"
	| "subscriptions"
	| "targets"
	| "history"
	| "rules"
	| "preview"
	| "ai";

interface AiAction {
	label: string;
	primary?: boolean;
	to?: string;
}

interface AiSuggestion {
	msg: React.ReactNode;
	actions: AiAction[];
}

const SUGGESTIONS: Record<SuggestionKey, AiSuggestion> = {
	dashboard: {
		msg: (
			<>
				主人，先去 <b>系统</b> 完成扫码登录，<b>推送目标</b> 配好通道，再来 <b>订阅</b> 添加 UP
				主即可开始接收推送。
			</>
		),
		actions: [{ label: "前往系统", primary: true, to: "/system" }, { label: "稍后再说" }],
	},
	subscriptions: {
		msg: (
			<>
				为新订阅勾选 <b>推送特性 × 目标</b> 矩阵后保存，女仆才能把内容投递到正确的群～
			</>
		),
		actions: [
			{ label: "查看推送目标", primary: true, to: "/targets" },
			{ label: "查看建议", to: "/ai" },
		],
	},
	targets: {
		msg: (
			<>
				配置完目标记得回 <b>订阅</b> 页给每位 UP 选要推送到哪些通道。
			</>
		),
		actions: [{ label: "前往订阅", primary: true, to: "/subs" }, { label: "稍后" }],
	},
	history: {
		msg: <>这里会按时间轴展示最近的推送动作；失败条目会高亮，方便回查原因。</>,
		actions: [{ label: "查看失败筛选", primary: true }, { label: "导出 CSV" }],
	},
	rules: {
		msg: (
			<>
				检测到您还未配置 <b>关键词过滤</b>。开启后可减少 ~ 40% 的无效推送。
			</>
		),
		actions: [{ label: "一键启用推荐规则", primary: true }, { label: "手动配置" }],
	},
	preview: {
		msg: (
			<>
				当前卡片样式较为紧凑，反馈 <b>大字号样式</b> 可读性更佳。要试试吗？
			</>
		),
		actions: [{ label: "切换为大字号", primary: true }, { label: "保持当前" }],
	},
	ai: {
		msg: <>女仆已就绪——配好 OpenAI baseUrl/key 后，即可生成动态总结与直播日报。</>,
		actions: [{ label: "查看示例", primary: true }, { label: "导出 Markdown" }],
	},
};

const ROUTE_TO_KEY: Record<string, SuggestionKey> = {
	"/": "dashboard",
	"/subs": "subscriptions",
	"/targets": "targets",
	"/history": "history",
	"/rules": "rules",
	"/cards": "preview",
	"/ai": "ai",
	"/system": "dashboard",
};

export function FloatingAiBar() {
	const location = useLocation();
	const navigate = useNavigate();
	const dismissed = useAiBarStore((s) => s.dismissed);
	const expanded = useAiBarStore((s) => s.expanded);
	const setDismissed = useAiBarStore((s) => s.setDismissed);
	const setExpanded = useAiBarStore((s) => s.setExpanded);

	if (dismissed) {
		return (
			<button
				type="button"
				onClick={() => setDismissed(false)}
				aria-label="展开 AI 助手"
				className="fixed bottom-5 right-5 z-30 grid h-11 w-11 cursor-pointer place-items-center rounded-full text-white shadow-[0_8px_24px_rgba(108,92,231,0.4)]"
				style={{ background: "linear-gradient(135deg, #a29bfe, #6c5ce7)" }}
			>
				<Icon.ai size={20} />
			</button>
		);
	}

	const key = ROUTE_TO_KEY[location.pathname] ?? "dashboard";
	const s = SUGGESTIONS[key];

	return (
		<div className="bn-anim-fade-in fixed bottom-4 left-5 right-5 z-30">
			<div
				className={`bn-glass-strong flex items-center gap-3 rounded-bn-card shadow-bn-elev ${
					expanded ? "px-4 py-3.5" : "px-3.5 py-2.5"
				}`}
			>
				<div
					className="relative grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-white shadow-bn-card"
					style={{ background: "linear-gradient(135deg, #a29bfe, #6c5ce7)" }}
					aria-hidden="true"
				>
					<Icon.ai size={18} />
					<span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-white bg-emerald-500" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="mb-0.5 flex items-center gap-1.5">
						<span className="text-[10.5px] font-bold tracking-wider text-[#6c5ce7]">
							女仆 AI · 给主人的建议
						</span>
						<span className="text-[10px] text-bn-text-secondary">· 刚刚</span>
					</div>
					<div
						className={`text-[12.5px] leading-relaxed text-bn-text-tertiary ${
							expanded ? "" : "truncate"
						}`}
					>
						{s.msg}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{s.actions.map((a) => (
						<button
							key={a.label}
							type="button"
							onClick={() => {
								if (a.to) navigate(a.to);
							}}
							className={`whitespace-nowrap rounded-md px-3 py-1.5 text-[11.5px] font-semibold transition ${
								a.primary
									? "text-white shadow-[0_2px_8px_rgba(108,92,231,0.3)]"
									: "bg-bn-code-bg text-bn-text-tertiary hover:bg-bn-hover-muted"
							}`}
							style={
								a.primary ? { background: "linear-gradient(135deg, #a29bfe, #6c5ce7)" } : undefined
							}
						>
							{a.label}
						</button>
					))}
					<button
						type="button"
						onClick={() => setExpanded((v) => !v)}
						title={expanded ? "收起" : "展开"}
						aria-label={expanded ? "收起" : "展开"}
						className="grid h-[26px] w-[26px] cursor-pointer place-items-center rounded text-sm text-bn-text-secondary hover:bg-bn-hover-muted"
					>
						{expanded ? "⌃" : "⌄"}
					</button>
					<button
						type="button"
						onClick={() => setDismissed(true)}
						title="收起为悬浮按钮"
						aria-label="收起"
						className="grid h-[26px] w-[26px] cursor-pointer place-items-center rounded text-base text-bn-text-secondary hover:bg-bn-hover-muted"
					>
						×
					</button>
				</div>
			</div>
		</div>
	);
}
