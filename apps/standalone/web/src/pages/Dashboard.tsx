import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { GlassPanel, GlassStatCard, Pill, PulseDot } from "../components/glass";
import { api } from "../services/api";
import { useAuthStore } from "../store/auth";
import { BiliLoginStatus } from "../types/auth";
import type { PushTarget, Subscription } from "../types/domain";

interface HealthSnapshot {
	status: string;
	version: string;
	uptime: number;
	startedAt: string;
}

function formatUptime(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const m = Math.floor(seconds / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ${m % 60}m`;
	const d = Math.floor(h / 24);
	return `${d}d ${h % 24}h`;
}

function QuickAction({
	to,
	label,
	hint,
	tone,
}: {
	to: string;
	label: string;
	hint: string;
	tone: "pink" | "blue" | "purple";
}) {
	const palette: Record<typeof tone, string> = {
		pink: "from-bn-pink/20 to-bn-pink/0 border-bn-pink/30 hover:border-bn-pink/60",
		blue: "from-bn-blue/20 to-bn-blue/0 border-bn-blue/30 hover:border-bn-blue/60",
		purple: "from-bn-purple/20 to-bn-purple/0 border-bn-purple/30 hover:border-bn-purple/60",
	};
	return (
		<Link
			to={to}
			className={`group block rounded-bn-card border bg-gradient-to-br p-4 transition ${palette[tone]}`}
		>
			<div className="text-sm font-bold text-bn-text-primary">{label}</div>
			<div className="mt-1 text-xs text-bn-text-secondary group-hover:text-bn-text-tertiary">
				{hint}
			</div>
		</Link>
	);
}

export default function Dashboard() {
	const snapshot = useAuthStore((s) => s.snapshot);
	const loggedIn = snapshot?.status === BiliLoginStatus.LOGGED_IN;

	const health = useQuery({
		queryKey: ["health"],
		queryFn: () => api.get<HealthSnapshot>("/api/health"),
		refetchInterval: 5_000,
	});
	const subs = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
	});
	const targets = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});

	const subsList = subs.data ?? [];
	const targetsList = targets.data ?? [];
	const enabledSubs = subsList.filter((s) => s.enabled).length;
	const enabledTargets = targetsList.filter((t) => t.enabled).length;

	return (
		<div className="bn-anim-fade-in flex flex-col gap-4">
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
				<GlassStatCard
					label="订阅 UP 主"
					value={enabledSubs}
					suffix={`/ ${subsList.length}`}
					color="#fb7299"
					pulse={enabledSubs > 0}
				/>
				<GlassStatCard
					label="推送目标"
					value={enabledTargets}
					suffix={`/ ${targetsList.length}`}
					color="#00aeec"
				/>
				<GlassStatCard
					label="账号状态"
					value={loggedIn ? "在线" : "未登录"}
					color={loggedIn ? "#22c55e" : "#fbbf24"}
					pulse={loggedIn}
				/>
				<GlassStatCard
					label="服务运行"
					value={health.data ? formatUptime(health.data.uptime) : "—"}
					suffix={health.data?.version ? `v${health.data.version}` : ""}
					color="#a29bfe"
				/>
			</div>

			<div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
				<GlassPanel accent="#fb7299" title="快速开始" subtitle="女仆为您打理一切～(*´∀`)~♡">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<QuickAction
							to="/auth"
							tone="pink"
							label="登录账号"
							hint="扫码登录获取 Cookie；登录后才能拉取动态与直播"
						/>
						<QuickAction
							to="/targets"
							tone="blue"
							label="管理推送目标"
							hint="OneBot / Webhook / Web Dashboard / Koishi 平台"
						/>
						<QuickAction
							to="/subs"
							tone="purple"
							label="订阅 UP 主"
							hint="按 UID 添加并为每个特性勾选推送目标"
						/>
						<QuickAction
							to="/rules"
							tone="pink"
							label="高级规则"
							hint="全局过滤 / 直播阈值 / 模板 / per-UP 覆盖"
						/>
					</div>
				</GlassPanel>

				<GlassPanel
					accent="#00aeec"
					title="服务器状态"
					subtitle={
						health.data
							? `自 ${new Date(health.data.startedAt).toLocaleString()} 起运行`
							: "拉取中…"
					}
				>
					{health.isLoading ? (
						<div className="text-sm text-bn-text-secondary">加载中…</div>
					) : health.error ? (
						<div className="text-sm text-red-600">
							健康检查失败：{String((health.error as Error).message)}
						</div>
					) : (
						<dl className="space-y-2 text-sm">
							<div className="flex items-center justify-between">
								<dt className="text-bn-text-secondary">健康</dt>
								<dd>
									<Pill color={health.data?.status === "ok" ? "green" : "red"} subtle>
										<PulseDot color={health.data?.status === "ok" ? "#22c55e" : "#ef4444"} />
										{health.data?.status ?? "—"}
									</Pill>
								</dd>
							</div>
							<div className="flex items-center justify-between">
								<dt className="text-bn-text-secondary">登录态</dt>
								<dd>
									<Pill color={loggedIn ? "green" : "amber"} subtle>
										{snapshot?.msg ? snapshot.msg : loggedIn ? "LOGGED_IN" : "等待登录"}
									</Pill>
								</dd>
							</div>
							<div className="flex items-center justify-between">
								<dt className="text-bn-text-secondary">订阅 / 推送</dt>
								<dd className="font-mono text-xs text-bn-text-tertiary">
									{enabledSubs}/{subsList.length} subs · {enabledTargets}/{targetsList.length}{" "}
									targets
								</dd>
							</div>
						</dl>
					)}
				</GlassPanel>
			</div>
		</div>
	);
}
