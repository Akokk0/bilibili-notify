import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Avatar, Btn, Pill, StatsBar } from "../components/atoms";
import { GlassPanel, GlassStatCard, PulseDot } from "../components/glass";
import { Icon } from "../components/icons";
import { api } from "../services/api";
import {
	bucketByDay,
	type HistoryEntryView,
	type HistoryResponse,
	type LiveListenerSnapshot,
} from "../services/dashboard";
import { useAuthStore } from "../store/auth";
import { BiliLoginStatus } from "../types/auth";
import type { PushTarget, Subscription } from "../types/domain";
import { colorFromUid, displayName } from "./up/helpers";

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

function formatViewers(n: number | undefined): string {
	if (n == null) return "—";
	return n >= 10_000 ? `${(n / 10_000).toFixed(1)}万` : `${n}`;
}

function relativeTimeFromNow(iso: string): string {
	const ts = new Date(iso).getTime();
	if (Number.isNaN(ts)) return "—";
	const delta = Date.now() - ts;
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}小时前`;
	return `${Math.floor(delta / 86_400_000)}天前`;
}

function LiveNowPanel({ live, subs }: { live: LiveListenerSnapshot[]; subs: Subscription[] }) {
	const subByUid = useMemo(() => {
		const m = new Map<string, Subscription>();
		for (const s of subs) m.set(s.uid, s);
		return m;
	}, [subs]);
	return (
		<GlassPanel
			accent="#fb7299"
			title="正在直播"
			subtitle="实时刷新"
			right={
				<Pill color="#FF6699" size="sm">
					● {live.length} 人在播
				</Pill>
			}
		>
			{live.length === 0 ? (
				<div className="rounded-lg border border-dashed border-gray-200 p-6 text-center text-[12.5px] text-bn-text-secondary">
					当前没有订阅 UP 主在直播
					<br />
					<span className="text-[11px] text-bn-text-secondary/80">
						女仆会在直播开始时第一时间推送 (｡•̀ᴗ-)✧
					</span>
				</div>
			) : (
				<div className="flex flex-col gap-2.5">
					{live.map((r) => {
						const sub = subByUid.get(r.uid);
						const name = sub ? displayName(sub) : `UID ${r.uid}`;
						const color = colorFromUid(r.uid);
						return (
							<Link
								key={r.uid}
								to="/subs"
								className="block overflow-hidden rounded-xl p-px"
								style={{ background: "linear-gradient(135deg, #FB7299, #00AEEC)" }}
							>
								<div className="flex items-center gap-3 rounded-[10px] bg-white/95 p-2.5 backdrop-blur-sm">
									<Avatar name={name} color={color} size={44} status="living" />
									<div className="min-w-0 flex-1">
										<div className="mb-0.5 flex items-center gap-2">
											<span className="text-[13.5px] font-bold text-bn-text-primary">{name}</span>
											{r.areaName ? (
												<Pill color="#FB7299" subtle size="sm">
													{r.areaName}
												</Pill>
											) : null}
										</div>
										<div className="truncate text-xs text-bn-text-tertiary">
											{r.title ?? "（未拉取到房间标题）"}
										</div>
									</div>
									<div className="flex flex-col items-end gap-1">
										<span className="inline-flex items-center gap-1 text-[11px] font-bold text-bn-pink">
											<Icon.eye size={11} />
											{formatViewers(r.viewers)}
										</span>
									</div>
								</div>
							</Link>
						);
					})}
				</div>
			)}
		</GlassPanel>
	);
}

function TrendPanel({ entries }: { entries: HistoryEntryView[] }) {
	const data = useMemo(() => bucketByDay(entries, 7), [entries]);
	const total = entries.length;
	return (
		<GlassPanel title="本周推送趋势" subtitle="按推送类型分布" accent="#00aeec">
			<StatsBar data={data} height={130} />
			<div className="mt-3.5 flex flex-wrap items-center gap-3 text-[11px] text-bn-text-tertiary">
				{[
					["直播", "#FB7299"],
					["动态", "#00AEEC"],
					["SC", "#fdcb6e"],
					["舰长", "#f2a053"],
				].map(([label, c]) => (
					<span key={label} className="inline-flex items-center gap-1.5">
						<span className="block h-2 w-2 rounded-sm" style={{ background: c }} />
						{label}
					</span>
				))}
				<span className="ml-auto font-mono text-[11px] text-bn-text-secondary">
					近 7 天共 {total} 次
				</span>
			</div>
		</GlassPanel>
	);
}

function AiInsightStrip({ tip }: { tip: React.ReactNode }) {
	return (
		<div
			className="flex items-center gap-3.5 rounded-bn-card border p-4"
			style={{
				background: "linear-gradient(135deg, rgba(162,155,254,0.18), rgba(0,174,236,0.08))",
				borderColor: "rgba(162,155,254,0.3)",
			}}
		>
			<div
				className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white shadow-bn-card"
				style={{ background: "linear-gradient(135deg, #a29bfe, #6c5ce7)" }}
			>
				<Icon.ai size={20} />
			</div>
			<div className="flex-1 text-[12.5px] leading-relaxed text-bn-text-tertiary">
				<span className="font-bold text-[#6c5ce7]">AI 直播洞察 · </span>
				{tip}
			</div>
			<Btn size="sm" variant="ghost">
				查看完整总结 →
			</Btn>
		</div>
	);
}

const TIMELINE_TONE: Record<string, string> = {
	live: "#FB7299",
	"live-summary": "#FB7299",
	"special-enter": "#FB7299",
	"special-danmaku": "#FB7299",
	dynamic: "#00AEEC",
	sc: "#fdcb6e",
	guard: "#f2a053",
};
const TIMELINE_LABEL: Record<string, string> = {
	live: "直播",
	"live-summary": "总结",
	"special-enter": "进房",
	"special-danmaku": "弹幕",
	dynamic: "动态",
	sc: "SC",
	guard: "舰长",
};

function TimelinePanel({
	entries,
	subs,
	targets,
}: {
	entries: HistoryEntryView[];
	subs: Subscription[];
	targets: PushTarget[];
}) {
	const subByUid = useMemo(() => {
		const m = new Map<string, Subscription>();
		for (const s of subs) m.set(s.uid, s);
		return m;
	}, [subs]);
	const targetById = useMemo(() => {
		const m = new Map<string, PushTarget>();
		for (const t of targets) m.set(t.id, t);
		return m;
	}, [targets]);
	const recent = entries.slice(0, 6);
	return (
		<GlassPanel
			title="最近推送活动"
			subtitle="时间轴视图"
			right={
				<Link to="/history">
					<Btn size="sm" variant="ghost">
						查看全部
					</Btn>
				</Link>
			}
		>
			{recent.length === 0 ? (
				<div className="rounded-lg border border-dashed border-gray-200 p-6 text-center text-[12.5px] text-bn-text-secondary">
					还没有推送活动
					<br />
					<span className="text-[11px] text-bn-text-secondary/80">
						先去「推送目标」配置好通道，订阅 UP 主以后就会出现在这里 ~
					</span>
				</div>
			) : (
				<div className="relative pl-1">
					<div
						className="absolute left-[60px] top-2 bottom-2 w-0.5 opacity-25"
						style={{
							background: "linear-gradient(to bottom, #FB7299, #00AEEC, transparent)",
						}}
					/>
					{recent.map((h) => {
						const sub = subByUid.get(h.uid);
						const name = sub ? displayName(sub) : `UID ${h.uid}`;
						const color = colorFromUid(h.uid);
						const tone = TIMELINE_TONE[h.source] ?? "#999";
						const targetNames = h.targetIds
							.map((id) => targetById.get(id)?.name ?? id.slice(0, 6))
							.join(" / ");
						return (
							<div key={h.id} className="mb-2.5 flex items-center gap-3">
								<div className="w-11 text-right font-mono text-[11px] text-bn-text-secondary">
									{relativeTimeFromNow(h.ts)}
								</div>
								<div className="relative z-10">
									<span
										className="block h-3 w-3 rounded-full border-[2.5px] border-white"
										style={{ background: tone, boxShadow: "0 0 0 1.5px rgba(0,0,0,0.04)" }}
									/>
								</div>
								<div
									className="flex flex-1 items-center gap-2.5 rounded-lg bg-white/70 px-3 py-2 text-[12.5px]"
									style={!h.ok ? { borderLeft: "3px solid #ef4444" } : undefined}
								>
									<Avatar name={name} color={color} size={24} />
									<Pill color={tone} subtle size="sm">
										{TIMELINE_LABEL[h.source] ?? h.source}
									</Pill>
									<div className="flex-1 truncate text-bn-text-tertiary">
										<span className="font-bold text-bn-text-primary">{name}</span>
										{h.text ? ` · ${h.text}` : ""}
									</div>
									<span className="text-[11px] text-bn-text-secondary">→ {targetNames}</span>
									{h.ok ? (
										<Pill color="#22c55e" subtle size="sm">
											已送达
										</Pill>
									) : (
										<Pill color="#ef4444" subtle size="sm">
											失败
										</Pill>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}
		</GlassPanel>
	);
}

function SystemHealthCard({
	health,
	loggedIn,
	loginMsg,
	subsCount,
	enabledSubs,
	targetsCount,
	enabledTargets,
}: {
	health: HealthSnapshot | undefined;
	loggedIn: boolean;
	loginMsg: string;
	subsCount: number;
	enabledSubs: number;
	targetsCount: number;
	enabledTargets: number;
}) {
	return (
		<GlassPanel
			accent="#22c55e"
			title="系统状态"
			subtitle={health ? `自 ${new Date(health.startedAt).toLocaleString()} 起运行` : "拉取中…"}
		>
			<dl className="space-y-2 text-sm">
				<div className="flex items-center justify-between">
					<dt className="text-bn-text-secondary">健康</dt>
					<dd>
						<Pill color={health?.status === "ok" ? "#22c55e" : "#ef4444"} subtle>
							<PulseDot color={health?.status === "ok" ? "#22c55e" : "#ef4444"} />
							{health?.status ?? "—"}
						</Pill>
					</dd>
				</div>
				<div className="flex items-center justify-between">
					<dt className="text-bn-text-secondary">登录态</dt>
					<dd>
						<Pill color={loggedIn ? "#22c55e" : "#fbbf24"} subtle>
							{loginMsg}
						</Pill>
					</dd>
				</div>
				<div className="flex items-center justify-between">
					<dt className="text-bn-text-secondary">订阅 / 推送</dt>
					<dd className="font-mono text-xs text-bn-text-tertiary">
						{enabledSubs}/{subsCount} subs · {enabledTargets}/{targetsCount} targets
					</dd>
				</div>
				{health ? (
					<div className="flex items-center justify-between">
						<dt className="text-bn-text-secondary">运行时间</dt>
						<dd className="font-mono text-xs text-bn-text-tertiary">
							{formatUptime(health.uptime)} · v{health.version}
						</dd>
					</div>
				) : null}
			</dl>
		</GlassPanel>
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
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const liveQuery = useQuery({
		queryKey: ["live", "listening"],
		queryFn: () => api.get<LiveListenerSnapshot[]>("/api/live/listening"),
		refetchInterval: 30_000,
	});
	const historyQuery = useQuery({
		queryKey: ["history"],
		queryFn: () => api.get<HistoryResponse>("/api/history"),
		refetchInterval: 30_000,
	});

	const subs = subsQuery.data ?? [];
	const targets = targetsQuery.data ?? [];
	const live = liveQuery.data ?? [];
	const history = historyQuery.data?.entries ?? [];

	const enabledSubs = subs.filter((s) => s.enabled).length;
	const enabledTargets = targets.filter((t) => t.enabled).length;
	const todayPushes = history.filter(
		(h) => h.ts.slice(0, 10) === new Date().toISOString().slice(0, 10),
	).length;
	const failed = history.filter((h) => !h.ok).length;

	const aiTip = loggedIn ? (
		live.length > 0 ? (
			<>
				<b>
					{(() => {
						const sub = subs.find((s) => s.uid === live[0].uid);
						return sub ? displayName(sub) : `UID ${live[0].uid}`;
					})()}
				</b>{" "}
				正在直播，建议在结束后推送总结到游戏交流群～
			</>
		) : (
			<>
				当前没有 UP 主在直播。可以前往 <b>订阅</b> 调整推送策略，或先去 <b>推送目标</b> 配置通道。
			</>
		)
	) : (
		<>
			女仆暂未登录 B 站账号。前往 <b>账号</b> 完成扫码后即可开启动态/直播推送。
		</>
	);

	return (
		<div className="bn-anim-fade-in flex flex-col gap-4">
			{/* KPI grid */}
			<div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
				<GlassStatCard
					label="正在直播"
					value={live.length}
					suffix={`/ ${subs.length}`}
					color="#FB7299"
					pulse={live.length > 0}
				/>
				<GlassStatCard
					label="已启用订阅"
					value={enabledSubs}
					suffix={`/ ${subs.length}`}
					color="#00AEEC"
				/>
				<GlassStatCard label="今日推送" value={todayPushes} suffix="次" color="#a29bfe" />
				<GlassStatCard
					label="推送失败"
					value={failed}
					suffix="次"
					color={failed > 0 ? "#ef4444" : "#22c55e"}
					pulse={failed > 0}
				/>
			</div>

			{/* live + trend */}
			<div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1.3fr_1fr]">
				<LiveNowPanel live={live} subs={subs} />
				<TrendPanel entries={history} />
			</div>

			{/* AI insight strip */}
			<AiInsightStrip tip={aiTip} />

			{/* timeline + health */}
			<div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1.4fr_1fr]">
				<TimelinePanel entries={history} subs={subs} targets={targets} />
				<SystemHealthCard
					health={health.data}
					loggedIn={loggedIn}
					loginMsg={loggedIn ? snapshot?.msg || "LOGGED_IN" : snapshot?.msg || "等待登录"}
					subsCount={subs.length}
					enabledSubs={enabledSubs}
					targetsCount={targets.length}
					enabledTargets={enabledTargets}
				/>
			</div>
		</div>
	);
}
