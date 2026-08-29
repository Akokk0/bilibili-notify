import type { LogLevel } from "@bilibili-notify/contract";
import {
	Avatar,
	Btn,
	EmptyNote,
	ErrorNote,
	GlassBox,
	GlassPanel,
	GlassStatCard,
	Icon,
	Pill,
	StatsBar,
	StatusDot,
} from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router-dom";
import { HeroStrip } from "../components/hero-strip";
import { OnboardingCard } from "../components/onboarding/onboarding-card";
import { LOG_LEVEL_TONE, logLevelTint } from "../config/log-levels";
import { familyTone, PUSH_KIND_META, PUSH_TONE } from "../config/push-kinds";
import {
	HEALTH_QUERY_KEY,
	HEALTH_QUERY_OPTIONS,
	useBackendReachable,
} from "../hooks/useBackendReachable";
import { api } from "../services/api";
import {
	type DailyHistoryCountView,
	type FansEntry,
	type FansResponse,
	foldDailyBuckets,
	HISTORY_DAILY_DAYS,
	HISTORY_DAILY_QUERY_KEY,
	type HistoryDailyResponse,
	type HistoryEntryView,
	type HistoryResponse,
	historyDailyPath,
	historyQueryKey,
	type LiveListenerSnapshot,
	localDayKey,
} from "../services/dashboard";
import { useAuthStore } from "../store/auth";
import { BiliLoginStatus } from "../types/auth";
import type { PushTarget, Subscription } from "../types/domain";
import type { GlobalConfig, ModuleLogLevels } from "../types/globals";
import { DeltaTag, Sparkline } from "./stats/charts";
import { colorFromUid, displayName } from "./up/helpers";

interface HealthSnapshot {
	status: string;
	version: string;
	/** 每个模块自己的 package.json#version,由 /api/health 在启动期一次读出。 */
	moduleVersions?: Record<
		"api" | "storage" | "subscription" | "push" | "dynamic" | "live" | "image" | "ai",
		string
	>;
	uptime: number;
	startedAt: string;
	modules?: {
		dynamic: boolean;
		live: boolean;
		image: boolean;
		ai: boolean;
	};
}

function formatViewers(n: string | undefined): string {
	if (!n) return "—";
	return n;
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

// 跟后端 `LIVE_ROOM_MASTER_KEYS` 同集合 —— 只要任意一项的 routing 数组非空,
// LiveEngine 就会为该订阅开 B 站 WS 监听;反之 sub 即使 enabled 也不会出现
// 在「正在直播」面板里(needsLiveMonitor 返回 false)。
const LIVE_ROUTING_KEYS = [
	"live",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"wordcloud",
	"liveSummary",
] as const;

function hasAnyLiveTarget(sub: Subscription): boolean {
	return LIVE_ROUTING_KEYS.some((k) => (sub.routing[k]?.length ?? 0) > 0);
}

function LiveNowPanel({ live, subs }: { live: LiveListenerSnapshot[]; subs: Subscription[] }) {
	const subByUid = useMemo(() => {
		const m = new Map<string, Subscription>();
		for (const s of subs) m.set(s.uid, s);
		return m;
	}, [subs]);
	// 用户订阅了但没给 live 类 feature 配 target 的数量 —— 这些订阅的直播状态
	// 永远不会出现在面板里。empty state 里露出 hint 让用户知道该去哪配置。
	const unmonitoredCount = useMemo(
		() => subs.filter((s) => s.enabled && !hasAnyLiveTarget(s)).length,
		[subs],
	);
	return (
		<GlassPanel
			accent="var(--color-bn-pink)"
			title="正在直播"
			subtitle="实时刷新"
			right={
				<Pill color="var(--color-bn-pink)" size="sm">
					● {live.length} 人在播
				</Pill>
			}
		>
			{live.length === 0 ? (
				<EmptyNote>
					当前没有订阅 UP 主在直播
					<br />
					<span className="text-bn-xs text-bn-text-secondary/80">
						女仆会在直播开始时第一时间推送 (｡•̀ᴗ-)✧
					</span>
					{unmonitoredCount > 0 ? (
						<>
							<br />
							<Link
								to="/subs"
								className="mt-1 inline-block text-bn-xs text-bn-pink underline-offset-2 hover:underline"
							>
								有 {unmonitoredCount} 位订阅未配置直播推送目标,他们不会被监听 →
							</Link>
						</>
					) : null}
				</EmptyNote>
			) : (
				// auto-fit grid + max-h 上限 ≈ 3 行 chip(每 chip ~70px + 10px gap)。
				// chip 少时高度自然撑;chip ≥4 时超出部分被 overflow-hidden 裁掉,
				// header 的 「● N 人在播」 Pill 仍显示真实数量。
				<div className="grid max-h-60 grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-2.5 overflow-hidden">
					{live.map((r) => {
						const sub = subByUid.get(r.uid);
						const name = sub ? displayName(sub) : `UID ${r.uid}`;
						const color = colorFromUid(r.uid);
						// 数据小卡同款视觉语法(淡染色渐变 + 同色细描边),单层直接画在
						// 区块玻璃上 —— 旧的「渐变包裹 + 白底内层」在行条透明化后会整块露色。
						return (
							<Link
								key={r.uid}
								to="/subs"
								className="flex items-center gap-3 rounded-xl border p-2.5"
								style={{
									background: `linear-gradient(135deg, color-mix(in srgb, ${color} 12%, transparent), color-mix(in srgb, ${color} 4%, transparent))`,
									borderColor: `color-mix(in srgb, ${color} 20%, transparent)`,
								}}
							>
								<Avatar
									name={name}
									color={color}
									size={44}
									status="living"
									url={sub?.cachedProfile?.avatar}
								/>
								<div className="min-w-0 flex-1">
									<div className="mb-0.5 flex items-center gap-2">
										<span className="text-bn-base font-bold text-bn-text-primary">{name}</span>
										{r.areaName ? (
											<Pill color="var(--color-bn-pink)" subtle size="sm">
												{r.areaName}
											</Pill>
										) : null}
									</div>
									<div className="truncate text-xs text-bn-text-tertiary">
										{r.title ?? "（未拉取到房间标题）"}
									</div>
								</div>
								<div className="flex flex-col items-end gap-1">
									<span className="inline-flex items-center gap-1 text-bn-xs font-bold text-bn-pink">
										<Icon.eye size={11} />
										{formatViewers(r.viewers)}
									</span>
								</div>
							</Link>
						);
					})}
				</div>
			)}
		</GlassPanel>
	);
}

function TrendPanel({ daily }: { daily: DailyHistoryCountView[] }) {
	// 服务端已按日全量聚合(/api/history/daily),这里只做 4 源族折叠 —— 不再受
	// listing limit 截断影响,左侧柱子有多老的数据都数得到。
	// 加载期给零柱占位,保住日期轴不跳。
	const data = useMemo(() => {
		if (daily.length > 0) return foldDailyBuckets(daily);
		return Array.from({ length: HISTORY_DAILY_DAYS }, (_, i) => {
			const d = new Date();
			d.setDate(d.getDate() - (HISTORY_DAILY_DAYS - 1 - i));
			return { d: localDayKey(d).slice(5).replace("-", "/"), live: 0, dyn: 0, sc: 0, guard: 0 };
		});
	}, [daily]);
	const total = daily.reduce((sum, day) => sum + day.total, 0);
	return (
		<GlassPanel title="本周推送趋势" subtitle="按推送类型分布" accent="var(--color-bn-blue)">
			{/* TimelinePanel 6 条 history × 单行 ~50px + padding ≈ 320px;StatsBar 抬高
			    到 280 让同行 TrendPanel 视觉对齐,不至于半空。 */}
			{/* 柱子与下面的图例走同一份家族色 —— 此前柱子在库里写死,和图例只是碰巧同色。 */}
			<StatsBar
				data={data}
				height={280}
				colors={{
					live: PUSH_TONE.live,
					dyn: PUSH_TONE.dynamic,
					sc: PUSH_TONE.sc,
					guard: PUSH_TONE.guard,
				}}
			/>
			<div className="mt-3.5 flex flex-wrap items-center gap-3 text-bn-xs text-bn-text-tertiary">
				{[
					["直播", PUSH_TONE.live],
					["动态", PUSH_TONE.dynamic],
					["SC", PUSH_TONE.sc],
					["舰长", PUSH_TONE.guard],
				].map(([label, c]) => (
					<span key={label} className="inline-flex items-center gap-1.5">
						<span className="block h-2 w-2 rounded-sm" style={{ background: c }} />
						{label}
					</span>
				))}
				<span className="ml-auto tabular-nums text-bn-xs text-bn-text-secondary">
					近 7 天共 {total} 次
				</span>
			</div>
		</GlassPanel>
	);
}

function AiInsightStrip({ tip }: { tip: React.ReactNode }) {
	return (
		<HeroStrip
			compact
			icon={<Icon.ai size={20} />}
			right={
				<Btn size="sm" variant="ghost">
					查看完整总结 →
				</Btn>
			}
		>
			<div className="text-bn-sm leading-relaxed text-bn-text-tertiary">
				<span className="font-bold text-(--bn-ai-purple)">AI 直播洞察 · </span>
				{tip}
			</div>
		</HeroStrip>
	);
}

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
				<EmptyNote>
					还没有推送活动
					<br />
					<span className="text-bn-xs text-bn-text-secondary/80">
						先去「推送目标」配置好通道，订阅 UP 主以后就会出现在这里 ~
					</span>
				</EmptyNote>
			) : (
				<div className="relative pl-1">
					<div
						className="absolute left-15 top-2 bottom-2 w-0.5 opacity-25"
						style={{
							background:
								"linear-gradient(to bottom, var(--color-bn-pink), var(--color-bn-blue), transparent)",
						}}
					/>
					{recent.map((h) => {
						const sub = subByUid.get(h.uid);
						// 优先 entry 自带的写入期 snapshot —— 订阅后续被删除仍能正确显示。
						const name = h.unameSnapshot ?? (sub ? displayName(sub) : `UID ${h.uid}`);
						const avatar = h.uavatarSnapshot ?? sub?.cachedProfile?.avatar;
						const color = colorFromUid(h.uid);
						const tone = familyTone(h.source);
						const targetNames = h.targetIds
							.map((id) => targetById.get(id)?.name ?? id.slice(0, 6))
							.join(" / ");
						return (
							<div key={h.id} className="mb-2.5 flex items-center gap-3">
								<div className="w-11 text-right tabular-nums text-bn-xs text-bn-text-secondary">
									{relativeTimeFromNow(h.ts)}
								</div>
								<div className="relative z-bn-raised">
									<span
										className="block h-3 w-3 rounded-full border-[2.5px] border-bn-surface"
										style={{ background: tone, boxShadow: "0 0 0 1.5px rgba(0,0,0,0.04)" }}
									/>
								</div>
								<div
									className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-bn-list-row-border bg-bn-list-row px-3 py-2 text-bn-sm"
									// 失败标记用 inset 阴影而非 border-left:不占 box 宽度,内容不被挤右、与其它行对齐,
									// 且被 rounded-lg 圆角裁成左侧细红条,比硬边框精致。
									style={!h.ok ? { boxShadow: "inset 3px 0 0 var(--color-bn-danger)" } : undefined}
								>
									<Avatar name={name} color={color} size={24} url={avatar} />
									<Pill color={tone} subtle size="sm">
										{PUSH_KIND_META[h.source].label}
									</Pill>
									<div className="min-w-0 flex-1 truncate text-bn-text-tertiary">
										<span className="font-bold text-bn-text-primary">{name}</span>
										{h.text ? ` · ${h.text}` : ""}
									</div>
									<span className="text-bn-xs text-bn-text-secondary">→ {targetNames}</span>
									{h.ok ? (
										<Pill color="var(--color-bn-success)" subtle size="sm">
											已送达
										</Pill>
									) : (
										<Pill color="var(--color-bn-danger)" subtle size="sm">
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

// ── Fans deltas panel ─────────────────────────────────────────────────────

function formatFans(n: number): string {
	if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)}亿`;
	if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
	return n.toLocaleString();
}

function formatDeltaNumber(n: number): string {
	const abs = Math.abs(n);
	const sign = n > 0 ? "+" : "-";
	if (abs >= 10_000) return `${sign}${(abs / 10_000).toFixed(1)}万`;
	return `${n > 0 ? "+" : ""}${n.toLocaleString()}`;
}

function FansDeltaCol({ label, value }: { label: string; value: number | null }) {
	const isNull = value == null;
	const text = isNull ? "—" : value === 0 ? "±0" : formatDeltaNumber(value);
	// 无数据与持平共用静默档 —— 两者都是「这里没有变化可看」。
	const color =
		isNull || value === 0
			? "var(--color-bn-inactive)"
			: value > 0
				? "var(--color-bn-success)"
				: "var(--color-bn-danger)";
	return (
		<div className="w-16 text-right">
			<div className="tabular-nums text-bn-base font-bold" style={{ color }}>
				{text}
			</div>
			<div className="tabular-nums text-bn-2xs text-bn-text-tertiary">{label}</div>
		</div>
	);
}

function FansPanel({ subs }: { subs: Subscription[] }) {
	// 不轮询 — 由 usePushEventsChannel 的 `fans-refreshed` 覆盖式刷新缓存。
	const fansQuery = useQuery({
		queryKey: ["fans"],
		queryFn: () => api.get<FansResponse>("/api/fans"),
	});
	const subByUid = useMemo(() => {
		const m = new Map<string, Subscription>();
		for (const s of subs) m.set(s.uid, s);
		return m;
	}, [subs]);

	const entries: FansEntry[] = fansQuery.data?.entries ?? [];
	const sorted = useMemo(() => {
		// 按 |deltaSubscribed| 降序;null delta 沉底。
		return [...entries].sort((a, b) => {
			const ax = Math.abs(a.deltaSubscribed ?? -1);
			const bx = Math.abs(b.deltaSubscribed ?? -1);
			return bx - ax;
		});
	}, [entries]);

	return (
		<GlassPanel
			title="粉丝数变化"
			subtitle="自订阅起点 / 近 24h / 近 7d"
			accent="var(--color-bn-pink)"
			right={
				<Pill color="var(--color-bn-pink)" size="sm">
					● {entries.length} 位订阅
				</Pill>
			}
		>
			{entries.length === 0 ? (
				<EmptyNote>
					采样中…
					<br />
					<span className="text-bn-xs text-bn-text-secondary/80">
						FansPoller 第一轮 cron tick 完成后会填充(约 1–2 分钟)
					</span>
				</EmptyNote>
			) : (
				// 单列布局,max-h 上限 ≈ 3 行行卡(每行 ~62px + 8px gap);N 多时走
				// 内滚动,bn-no-scrollbar 隐藏滚动条不破坏卡片视觉。N 少时高度自然撑,
				// 跟同行「正在直播」由 grid row-stretch 拉到等高。
				<div className="bn-no-scrollbar grid max-h-60 grid-cols-1 gap-2 overflow-y-auto">
					{sorted.map((e) => {
						const sub = subByUid.get(e.uid);
						const name = sub ? displayName(sub) : `UID ${e.uid}`;
						const color = colorFromUid(e.uid);
						return (
							<div
								key={e.uid}
								className="flex items-center gap-3 rounded-lg border border-bn-list-row-border bg-bn-list-row px-3 py-2.5 text-bn-sm"
							>
								<Avatar name={name} color={color} size={32} url={sub?.cachedProfile?.avatar} />
								<div className="min-w-0 flex-1">
									<div className="truncate font-bold text-bn-text-primary">{name}</div>
									<div className="tabular-nums text-bn-xs text-bn-text-tertiary">
										{formatFans(e.current)} 粉丝
									</div>
								</div>
								<FansDeltaCol label="起点" value={e.deltaSubscribed} />
								<FansDeltaCol label="24h" value={e.delta24h} />
								<FansDeltaCol label="7d" value={e.delta7d} />
							</div>
						);
					})}
				</div>
			)}
		</GlassPanel>
	);
}

// ── Plugin matrix (mirrors .bn-design SystemHealthPanel) ──────────────────

type ModuleCellId =
	| "api"
	| "storage"
	| "subscription"
	| "push"
	| "dynamic"
	| "live"
	| "image"
	| "ai";

interface PluginCell {
	id: ModuleCellId;
	label: string;
	enabled: boolean;
	sub?: string;
	logLevel: string | undefined;
	logLevelSource: "global" | "module";
}

function pickLogTone(level: string | undefined): { fg: string; bg: string } {
	const key: LogLevel = level === "error" || level === "debug" || level === "warn" ? level : "info";
	return { fg: LOG_LEVEL_TONE[key], bg: logLevelTint(key) };
}

/** 等宽数字的版本小徽章(核心 / 面板)—— 收编前同一串 className 在 subtitle 里抄了两份。 */
function VersionBadge({ children }: { children: ReactNode }) {
	return (
		<span className="inline-block rounded-md bg-bn-code-bg px-1.5 py-px text-bn-2xs font-semibold tabular-nums tracking-tight text-bn-text-primary">
			{children}
		</span>
	);
}

function PluginMatrix({ cells }: { cells: PluginCell[] }) {
	return (
		<div
			className="grid gap-2"
			// minmax(220, 1fr) 保证最窄的列也容得下 "日志 INFO* puppeteer 就绪"
			// 这一行不折行;auto-fill + 1fr 让有空间时各列等宽撑满。
			style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
		>
			{cells.map((c) => {
				const tone = pickLogTone(c.logLevel);
				const levelLabel = c.logLevel ? c.logLevel.toUpperCase() : "—";
				const isOverride = c.logLevelSource === "module";
				return (
					<div key={c.id} className="rounded-lg px-3 py-2.5">
						<div className="mb-1.5 flex items-center justify-between">
							<span className="text-bn-sm font-bold text-bn-text-primary">{c.label}</span>
							<StatusDot size="sm" kind={c.enabled ? "ok" : "off"} />
						</div>
						<div className="flex items-center gap-1.5 whitespace-nowrap text-bn-xs text-bn-text-secondary">
							日志{" "}
							<span
								className="rounded-sm px-1.5 text-bn-2xs font-bold"
								style={{ background: tone.bg, color: tone.fg }}
								title={isOverride ? "按模块覆盖" : "继承全局"}
							>
								{levelLabel}
								{isOverride ? "*" : ""}
							</span>
							{c.sub ? <span className="ml-auto text-bn-2xs">{c.sub}</span> : null}
						</div>
					</div>
				);
			})}
		</div>
	);
}

function SystemHealthCard({
	health,
	reachable,
	logLevel,
	logLevels,
	loggedIn,
	subCount,
	targetCount,
	dynamicEnabled,
	liveEnabled,
	imageEnabled,
	aiEnabled,
}: {
	health: HealthSnapshot | undefined;
	reachable: boolean;
	logLevel: string | undefined;
	logLevels: ModuleLogLevels | undefined;
	loggedIn: boolean;
	subCount: number;
	targetCount: number;
	dynamicEnabled: boolean;
	liveEnabled: boolean;
	imageEnabled: boolean;
	aiEnabled: boolean;
}) {
	// ModuleLogLevels 当前只覆盖 core/dynamic/live/image/ai;infra 四件(api/storage/
	// subscription/push)没有 per-package override 槽位,这里直接回退到全局等级。
	const HAS_OVERRIDE_SLOT = new Set<ModuleCellId>(["dynamic", "live", "image", "ai"]);
	const effectiveLevel = (
		id: ModuleCellId,
	): { level: string | undefined; source: "global" | "module" } => {
		if (HAS_OVERRIDE_SLOT.has(id)) {
			const override = logLevels?.[id as "dynamic" | "live" | "image" | "ai"];
			if (override) return { level: override, source: "module" };
		}
		return { level: logLevel, source: "global" };
	};

	// When the backend is unreachable, all module status text falls back to
	// "—" — keeping the previous "运行中 / 已就绪" copy alive while the API is
	// dead would be lying to the user.
	const buildCell = (
		id: ModuleCellId,
		label: string,
		enabled: boolean,
		sub: string,
	): PluginCell => {
		const { level, source } = effectiveLevel(id);
		return {
			id,
			label,
			enabled: reachable && enabled,
			sub: reachable ? sub : "—",
			logLevel: level,
			logLevelSource: source,
		};
	};

	// Infra → Engine. 这 4 个 infra 包 boot 成功后 100% constructed,所以状态点跟
	// reachable 同步;子文案改填业务计数(api 显示登录态,storage 已加载,subscription
	// / push 分别显示订阅 / 目标数)以增加信息量。
	const cells: PluginCell[] = [
		buildCell("api", "接口 · api", true, loggedIn ? "已登录" : "未登录"),
		buildCell("storage", "持久化 · storage", true, "已加载"),
		buildCell("subscription", "订阅 · subscription", true, `${subCount} 个订阅`),
		buildCell("push", "推送 · push", true, `${targetCount} 个目标`),
		buildCell("dynamic", "动态 · dynamic", dynamicEnabled, dynamicEnabled ? "运行中" : "未启用"),
		buildCell("live", "直播 · live", liveEnabled, liveEnabled ? "运行中" : "无监听"),
		buildCell("image", "卡片 · image", imageEnabled, imageEnabled ? "puppeteer 就绪" : "未接入"),
		buildCell("ai", "AI · ai", aiEnabled, aiEnabled ? "运行中" : "未启用"),
	];

	return (
		<GlassBox
			title="系统状态 · 各模块"
			subtitle={
				<span className="inline-flex items-center gap-1.5">
					<span>核心</span>
					<VersionBadge>{health?.version ?? "—"}</VersionBadge>
					<span className="opacity-40">·</span>
					<span>面板</span>
					<VersionBadge>{__WEB_VERSION__}</VersionBadge>
				</span>
			}
			accent={reachable ? "var(--color-bn-success)" : "var(--color-bn-danger)"}
			icon={<Icon.check size={14} />}
			badge={!reachable ? "失联" : health?.status === "ok" ? "健康" : "—"}
			dense
		>
			{!reachable ? (
				<ErrorNote className="mb-2.5">
					后端 API 当前不可达 (apps/server 未运行 或
					网络中断),以下数据可能为最后一次成功拉取的快照。
				</ErrorNote>
			) : null}
			<PluginMatrix cells={cells} />
		</GlassBox>
	);
}

export default function Dashboard() {
	const snapshot = useAuthStore((s) => s.snapshot);
	const loggedIn = snapshot?.status === BiliLoginStatus.LOGGED_IN;
	const reachable = useBackendReachable();

	const health = useQuery({
		queryKey: HEALTH_QUERY_KEY,
		queryFn: () => api.get<HealthSnapshot>("/api/health"),
		...HEALTH_QUERY_OPTIONS,
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
		// 不再轮询；usePushEventsChannel 监听 WS `live-state-changed` 后 invalidate
		// 即可让该 query 重新 fetch 最新快照。
	});
	// Cache is kept fresh by `usePushEventsChannel` (WS push-events → setQueryData),
	// so KPI / recent list / trend chart update within ~1s without polling.
	const historyQuery = useQuery({
		// HI1:与 History 页(limit:200)用不同 limit-scoped 键(单一来源
		// historyQueryKey),避免共享单缓存导致数据集随导航顺序非确定。
		// 只喂「最近推送活动」时间线;趋势图与今日 KPI 走下面的按日聚合。
		queryKey: historyQueryKey(100),
		queryFn: () => api.get<HistoryResponse>("/api/history?limit=100"),
	});
	const dailyQuery = useQuery({
		// 本周推送趋势 + 今日 KPI 的数据源:服务端按日全量计数(客户端时区口径),
		// WS history-recorded 经 usePushEventsChannel 就地 +1 保实时。
		queryKey: HISTORY_DAILY_QUERY_KEY,
		queryFn: () => api.get<HistoryDailyResponse>(historyDailyPath()),
	});
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});

	const subs = subsQuery.data ?? [];
	const targets = targetsQuery.data ?? [];
	const live = liveQuery.data ?? [];
	const history = historyQuery.data?.entries ?? [];

	const enabledSubs = subs.filter((s) => s.enabled).length;
	// 「今日」= 按日聚合窗口的最后一个桶(客户端时区口径,后端聚合)。此前用
	// limit=100 的 listing 在前端数,单日推送超 100 条就会低估。
	const daily = dailyQuery.data?.days ?? [];
	const today = daily.at(-1);
	const todayPushes = today?.total ?? 0;
	const todayFailed = today?.failures ?? 0;
	// KPI 卡 footer 素材(与统计页同构:首张有素材的卡吃 footer,同行其余卡由
	// grid 等高拉齐):较昨日增减 + 近 7 日走势。窗口不足两天时徽章显「—」。
	const yesterday = daily.at(-2);
	const pushDelta = today && yesterday ? today.total - yesterday.total : null;
	const pushSeries = daily.map((d) => d.total);

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
		<div className="bn-anim-page-in flex flex-col gap-4">
			{/* 新手进度卡:未毕业时置顶;全绿收紧成横幅;用户收起后彻底让位(存 server)。*/}
			<OnboardingCard />
			{/* KPI grid(构图对齐统计页:gap-3、带 footer 的卡定行高,其余同行等高)*/}
			<div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
				<GlassStatCard
					label="正在直播"
					value={live.length}
					suffix={`/ ${subs.length}`}
					color="var(--color-bn-pink)"
					pulse={live.length > 0}
				/>
				<GlassStatCard
					label="已启用订阅"
					value={enabledSubs}
					suffix={`/ ${subs.length}`}
					color="var(--color-bn-blue)"
				/>
				<GlassStatCard
					label="今日推送"
					value={todayPushes}
					suffix="次"
					color="var(--color-bn-purple)"
					footer={
						<>
							<DeltaTag v={pushDelta} size={11.5} />
							<span className="text-bn-2xs text-bn-text-secondary">较昨日</span>
							<span className="ml-auto">
								<Sparkline
									data={pushSeries}
									color="var(--color-bn-purple)"
									width={64}
									height={20}
								/>
							</span>
						</>
					}
				/>
				<GlassStatCard
					label="今日失败"
					value={todayFailed}
					suffix="次"
					color={todayFailed > 0 ? "var(--color-bn-danger)" : "var(--color-bn-success)"}
					pulse={todayFailed > 0}
				/>
			</div>

			{/* row 2: 正在直播(宽) + 粉丝数变化(窄) */}
			<div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1.3fr_1fr]">
				<LiveNowPanel live={live} subs={subs} />
				<FansPanel subs={subs} />
			</div>

			{/* AI insight strip */}
			<AiInsightStrip tip={aiTip} />

			{/* row 4: 推送趋势(窄) + 最近推送活动(宽) —— 跟 row 2 的列比反向,视觉错位 */}
			<div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1fr_1.3fr]">
				<TrendPanel daily={daily} />
				<TimelinePanel entries={history} subs={subs} targets={targets} />
			</div>

			{/* system health (full width) */}
			<SystemHealthCard
				health={health.data}
				reachable={reachable}
				logLevel={globalsQuery.data?.app.logLevel}
				logLevels={globalsQuery.data?.app.logLevels}
				loggedIn={loggedIn}
				subCount={subs.length}
				targetCount={targets.length}
				dynamicEnabled={health.data?.modules?.dynamic ?? loggedIn}
				liveEnabled={health.data?.modules?.live ?? false}
				imageEnabled={health.data?.modules?.image ?? false}
				aiEnabled={health.data?.modules?.ai ?? false}
			/>
		</div>
	);
}
