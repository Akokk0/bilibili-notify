import { GlassPanel, Icon, IconButton, Pill, StatusDot } from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { HEALTH_QUERY_KEY, HEALTH_QUERY_OPTIONS } from "../../hooks/useBackendReachable";
import { api } from "../../services/api";
import { useAuthStore } from "../../store/auth";
import { BiliLoginStatus } from "../../types/auth";
import type { PushAdapter, PushTarget, Subscription } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";
import { deriveOnboarding, type OnboardingStepKey, type OnboardingTailKey } from "./derive";

/**
 * 新手进度卡(2026-08-29 grilling 定案)。三态:
 * - 五步未全绿 → 完整卡,active 步高亮给「去完成」入口,每步常驻「教程」链接;
 * - 全绿且未收起 → 紧凑完成横幅 + 收起钮;
 * - 收起(`globals.onboardingDismissed`,存 server)→ 不渲染,进度在 /guide 仍可见。
 *
 * 判据纯逻辑在 ./derive.ts;这里只做数据装配与渲染。所有 query 都复用站内
 * 既有 queryKey(subscriptions/targets/adapters/globals/health),与对应页面
 * 共享缓存 —— 进度卡不发独立轮询,health 的行为选项走 HEALTH_QUERY_OPTIONS
 * 单一权威(三处 observer 选项不一致会让可达性探测抖动,见 useBackendReachable)。
 */

interface HealthSnapshot {
	status: string;
	uptime: number;
	modules?: { dynamic: boolean; live: boolean; image: boolean; ai: boolean };
}

const STEP_META: Record<
	OnboardingStepKey,
	{ title: string; desc: string; ctaHref: string; guideHref: string }
> = {
	login: {
		title: "登录 B 站账号",
		desc: "扫码登录,BN 用它拉订阅动态与直播状态",
		ctaHref: "/system",
		guideHref: "/guide/login",
	},
	subs: {
		title: "订阅第一个 UP",
		desc: "搜索 UP 主并订阅,推送内容从这里来",
		ctaHref: "/subs",
		guideHref: "/guide/subs",
	},
	adapter: {
		title: "配置推送适配器",
		desc: "接上 QQ 机器人(或 webhook)并点「测试」验证连通",
		ctaHref: "/targets",
		guideHref: "/guide/push",
	},
	target: {
		title: "添加推送目标",
		desc: "选好消息发到哪个群 / 哪个人",
		ctaHref: "/targets",
		guideHref: "/guide/push",
	},
	graduate: {
		title: "发送测试推送",
		desc: "在目标上点「测试」,QQ 里收到消息就毕业啦",
		ctaHref: "/targets",
		guideHref: "/guide/push",
	},
};

const TAIL_META: Record<
	OnboardingTailKey,
	{ title: string; badge: string; ctaHref: string; guideHref: string }
> = {
	image: { title: "图片渲染", badge: "强烈推荐", ctaHref: "/cards", guideHref: "/guide/render" },
	ai: { title: "AI 能力", badge: "可选", ctaHref: "/ai", guideHref: "/guide/ai" },
};

export function OnboardingCard() {
	const snapshot = useAuthStore((s) => s.snapshot);
	const qc = useQueryClient();
	const globalsQ = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const subsQ = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
	});
	const adaptersQ = useQuery({
		queryKey: ["adapters"],
		queryFn: () => api.get<PushAdapter[]>("/api/adapters"),
	});
	const targetsQ = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const healthQ = useQuery({
		queryKey: HEALTH_QUERY_KEY,
		queryFn: () => api.get<HealthSnapshot>("/api/health"),
		...HEALTH_QUERY_OPTIONS,
	});
	const dismiss = useMutation({
		mutationFn: () => api.patch<GlobalConfig>("/api/globals", { onboardingDismissed: true }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["globals"] }),
	});

	// 数据没齐先不出卡:半份数据画出来的进度是错的,闪一下再跳很难看。
	if (!globalsQ.data || !subsQ.data || !adaptersQ.data || !targetsQ.data) return null;
	if (globalsQ.data.onboardingDismissed) return null;

	const view = deriveOnboarding({
		biliLoggedIn: snapshot?.status === BiliLoginStatus.LOGGED_IN,
		subsCount: subsQ.data.length,
		adapters: adaptersQ.data,
		targets: targetsQ.data,
		modules: healthQ.data?.modules,
	});

	if (view.allDone) {
		return (
			<div className="bn-glass rounded-bn-card shadow-bn-card flex items-center gap-3 px-4 py-3">
				<span aria-hidden className="text-bn-lg">
					🎉
				</span>
				<div className="min-w-0 flex-1">
					<div className="text-bn-base font-semibold text-bn-text-primary">配置完成</div>
					<div className="text-bn-xs text-bn-text-tertiary">
						五步链路已全部打通,推送会自动送达。教程随时在
						<Link to="/guide" className="text-bn-pink hover:underline">
							新手指引
						</Link>
						可看。
					</div>
				</div>
				<IconButton
					icon={<Icon.close size={14} />}
					label="收起"
					title="收起(进度在新手指引页仍可见)"
					onClick={() => dismiss.mutate()}
				/>
			</div>
		);
	}

	return (
		<GlassPanel
			title="新手指引"
			subtitle="五步打通从 B 站到第一条推送"
			right={
				<Pill subtle>
					{view.doneCount}/{view.steps.length}
				</Pill>
			}
		>
			<ol className="flex flex-col gap-1.5">
				{view.steps.map((step) => {
					const meta = STEP_META[step.key];
					const active = view.activeKey === step.key;
					return (
						<li key={step.key} className="flex items-center gap-2.5">
							<StatusDot kind={step.done ? "ok" : "pending"} />
							<div className="min-w-0 flex-1">
								<span
									className={
										step.done
											? "text-bn-sm text-bn-text-tertiary"
											: active
												? "text-bn-sm font-medium text-bn-text-primary"
												: "text-bn-sm text-bn-text-secondary"
									}
								>
									{meta.title}
								</span>
								{active ? (
									<span className="ml-2 text-bn-xs text-bn-text-tertiary">{meta.desc}</span>
								) : null}
							</div>
							{active ? (
								<Link
									to={meta.ctaHref}
									data-bn="btn"
									className="shrink-0 rounded-bn-pill border border-bn-pink px-2.5 py-0.5 text-bn-xs font-medium text-bn-pink transition-colors hover:bg-bn-pink hover:text-bn-on-solid"
								>
									去完成
								</Link>
							) : null}
							<Link
								to={meta.guideHref}
								className="shrink-0 text-bn-xs text-bn-text-tertiary hover:text-bn-pink"
							>
								教程
							</Link>
						</li>
					);
				})}
			</ol>
			<div className="mt-3 flex flex-col gap-1.5 border-t border-bn-border-subtle pt-2.5">
				{view.tails.map((tail) => {
					const meta = TAIL_META[tail.key];
					return (
						<div key={tail.key} className="flex items-center gap-2.5">
							<StatusDot kind={tail.done ? "ok" : "off"} />
							<span className="text-bn-sm text-bn-text-secondary">{meta.title}</span>
							<Pill
								subtle
								size="sm"
								color={tail.key === "image" ? undefined : "var(--color-bn-inactive)"}
							>
								{meta.badge}
							</Pill>
							<span className="flex-1" />
							{tail.done ? null : (
								<Link
									to={meta.ctaHref}
									className="shrink-0 text-bn-xs text-bn-text-tertiary hover:text-bn-pink"
								>
									去开启
								</Link>
							)}
							<Link
								to={meta.guideHref}
								className="shrink-0 text-bn-xs text-bn-text-tertiary hover:text-bn-pink"
							>
								教程
							</Link>
						</div>
					);
				})}
			</div>
		</GlassPanel>
	);
}
