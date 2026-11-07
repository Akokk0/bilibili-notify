import type { ExtensionEntryView, SourceEntry } from "@bilibili-notify/contract";
import { displayNameOf } from "@bilibili-notify/contract";
import { formatAgo, formatCount } from "@bilibili-notify/internal/format";
import { needsLiveMonitor } from "@bilibili-notify/internal/live-monitor";
import {
	Avatar,
	Btn,
	EmptyNote,
	ErrorNote,
	GlassPanel,
	GlassStatCard,
	Icon,
	LoadingBlock,
	Pill,
	StatsBar,
} from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { HeroStrip } from "../components/hero-strip";
import { SystemHealthCard } from "../components/system-health-card";
import { SystemResourceCard } from "../components/system-resource-card";
import { useUpdateStatus } from "../components/update/status";
import {
	FEATURE_DESCRIPTORS,
	familyTone,
	PUSH_STATUS_META,
	PUSH_TONE,
} from "../config/push-features";
import { HEALTH_QUERY_OPTIONS, useBackendReachable } from "../hooks/useBackendReachable";
import { useExtensions } from "../hooks/useExtensions";
import { useResourcesChannel } from "../hooks/useResourcesChannel";
import { useCoreSettings } from "../hooks/useSettings";
import { useSources } from "../hooks/useSources";
import { useT } from "../i18n";
import { api } from "../services/api";
import {
	type DailyHistoryCountView,
	FOLLOWERS_QUERY_KEY,
	type FollowersRefreshEntry,
	type FollowersResponse,
	foldDailyBuckets,
	HISTORY_DAILY_DAYS,
	HISTORY_DAILY_QUERY_KEY,
	type HistoryDailyResponse,
	type HistoryEntryView,
	type HistoryResponse,
	historyDailyPath,
	historyQueryKey,
	type LiveListeningEntry,
	localDayKey,
} from "../services/overview";
import {
	type FeatureFlagValues,
	identityColor,
	type PushTarget,
	type Subscription,
} from "../types/domain";
import { historyRowAvatarUrl, historyRowColor, historyRowIdentity } from "../utils/creator-display";
import { headlineOf, messageCountOf } from "../utils/push-row";
import { DeltaTag, Sparkline } from "./stats/charts";
import { displayName, profileAvatarUrl, subscribedFeatures } from "./subscriptions/helpers";
import {
	createSubscriptionLookup,
	type SubscriptionLookup,
} from "./subscriptions/subscription-lookup";
import { subscriptionPlatformOf } from "./subscriptions/subscription-source";

/** 「正在直播」那一列的人数:精确数排成「1.2万」(`formatCount`),没有数是「—」。0 是真数,写「0」。 */
function formatViewers(n: number | undefined): string {
	return n === undefined ? "—" : formatCount(n);
}

/**
 * 在播那一行画成什么样。名字对不上订阅时照 `historyRowIdentity`(B 站写「UID x」、拓展写平台名加外部 id),
 * 颜色照 `identityColor` 跟着人走(ADR-0019 决策 73),拓展订阅的在播另带一枚平台徽章。在播快照带着订阅的
 * 身份,订阅列表还没回来时这些也都能画。
 *
 * 人数那一列是**本场累计观看**(决策 75),精确数、走 `formatViewers`。来源只报了此刻在线的话这一列是
 * 「—」,不拿在线冒充。
 */
function liveRowFace(
	r: LiveListeningEntry,
	lookup: SubscriptionLookup,
	sources: readonly SourceEntry[] | undefined,
	_extensions: readonly ExtensionEntryView[] | undefined,
): {
	name: string;
	color: string;
	avatar?: string;
	viewers: string;
	platform?: { label: string; color?: string };
} {
	const sub = lookup.byId(r.subscriptionId);
	const avatar = profileAvatarUrl(sub?.cachedProfile);
	const base = {
		color: identityColor(r.identity, subscriptionPlatformOf(r.identity, sources)),
		avatar,
		viewers: formatViewers(r.totalViewers),
	};
	const platform = subscriptionPlatformOf(r.identity, sources);
	return {
		...base,
		name: sub ? displayName(sub, platform) : historyRowIdentity(r, platform),
		platform: platform.showBadge
			? { label: platform.shortLabel ?? platform.label, color: platform.color }
			: undefined,
	};
}

// 与服务端同一个判定(internal 的 `needsLiveMonitor`,ADR-0027 决策 1):折好的直播类开关(订阅覆盖压过全局默认)
// 任一开着,或某把特别开关开着且名单上有人带它,该订阅就需要直播监听。这里只判断订阅的设置,
// 不表示来源或账号已经就绪,也不看有没有推送目标。
function isLiveMonitored(sub: Subscription, globalFeatures?: FeatureFlagValues): boolean {
	const on = new Set(subscribedFeatures(sub, globalFeatures));
	return needsLiveMonitor({
		features: {
			liveStart: on.has("liveStart"),
			liveStreaming: on.has("liveStreaming"),
			liveEnd: on.has("liveEnd"),
			membership: on.has("membership"),
			superchat: on.has("superchat"),
			viewerChat: on.has("viewerChat"),
			viewerEnter: on.has("viewerEnter"),
		},
		specialViewers: sub.specialViewers,
	});
}

export function LiveNowPanel({
	live,
	liveStatus = "success",
	countStatus = "success",
	subs,
	sources,
	extensions,
	globalFeatures,
}: {
	live: LiveListeningEntry[];
	liveStatus?: "pending" | "error" | "success";
	countStatus?: "pending" | "error" | "success";
	subs: Subscription[];
	/** 来源表 —— 拓展订阅那几行的平台徽章照描述符画(取自清单)。没回来时徽章退拓展名或拓展 id。 */
	sources?: readonly SourceEntry[];
	/** 装着的拓展 —— 来源表里没有时退它的名字。 */
	extensions?: readonly ExtensionEntryView[];
	/** 全局特性开关(`core.defaults.features`),订阅覆盖压过它;未读取时countStatus不得成功。 */
	globalFeatures?: FeatureFlagValues;
}) {
	const tx = useT();
	// 在播快照带着订阅自己的 id(ADR-0019 决策 50),按它对订阅 —— 同一个 UP 配了几条订阅时,
	// 按身份对不出这间直播间是替哪一条开的。
	const lookup = useMemo(() => createSubscriptionLookup(subs), [subs]);
	// 按启用中的订阅项数关闭的直播监听设置,不合并身份,也不代表来源的运行状态。
	// empty state 里露出 hint 让用户知道该去哪开。「开着」只看开关,不看有没有推送目标。
	const unmonitoredCount = useMemo(
		() =>
			countStatus === "success"
				? subs.filter((s) => s.enabled && !isLiveMonitored(s, globalFeatures)).length
				: undefined,
		[subs, globalFeatures, countStatus],
	);
	return (
		<GlassPanel
			accent="var(--color-bn-pink)"
			icon={<Icon.live width={15} height={15} />}
			title={tx("dashboard.live.title")}
			subtitle={tx("dashboard.live.refresh")}
			right={
				<Pill color="var(--color-bn-pink)" size="sm">
					{liveStatus === "success" ? tx("dashboard.live.count", { count: live.length }) : "—"}
				</Pill>
			}
		>
			{liveStatus === "pending" ? (
				<LoadingBlock
					label={tx("dashboard.live.refresh")}
					hint={tx("dashboard.live.loading")}
					variant="inset"
				/>
			) : liveStatus === "error" ? (
				<ErrorNote>{tx("dashboard.live.readFailed")}</ErrorNote>
			) : live.length === 0 ? (
				<EmptyNote>
					{tx("dashboard.live.empty")}
					{countStatus === "success" && subs.length > 0 ? (
						<>
							<br />
							<span className="text-bn-xs text-bn-text-secondary/80">
								{tx("dashboard.live.hint")}
							</span>
						</>
					) : null}
					{countStatus === "pending" ? (
						<LoadingBlock
							label={tx("dashboard.live.refresh")}
							hint={tx("dashboard.live.countLoading")}
							variant="inset"
						/>
					) : countStatus === "error" ? (
						<ErrorNote>{tx("dashboard.live.countFailed")}</ErrorNote>
					) : subs.length === 0 ? (
						<Link
							to="/subs"
							className="mt-1 block text-bn-xs text-bn-pink underline-offset-2 hover:underline"
						>
							{tx("dashboard.live.noSubscriptions")}
						</Link>
					) : unmonitoredCount !== undefined && unmonitoredCount > 0 ? (
						<>
							<br />
							<Link
								to="/subs"
								className="mt-1 inline-block text-bn-xs text-bn-pink underline-offset-2 hover:underline"
							>
								{tx("dashboard.live.unmonitored", { count: unmonitoredCount })}
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
						const { name, color, avatar, viewers, platform } = liveRowFace(
							r,
							lookup,
							sources,
							extensions,
						);
						// 数据小卡同款视觉语法(淡染色渐变 + 同色细描边),单层直接画在
						// 区块玻璃上 —— 旧的「渐变包裹 + 白底内层」在行条透明化后会整块露色。
						return (
							<Link
								key={r.subscriptionId}
								to="/subs"
								className="flex items-center gap-3 rounded-xl border p-2.5"
								style={{
									background: `linear-gradient(135deg, color-mix(in srgb, ${color} 12%, transparent), color-mix(in srgb, ${color} 4%, transparent))`,
									borderColor: `color-mix(in srgb, ${color} 20%, transparent)`,
								}}
							>
								<Avatar name={name} color={color} size={44} status="living" url={avatar} />
								<div className="min-w-0 flex-1">
									<div className="mb-0.5 flex items-center gap-2">
										<span className="text-bn-base font-bold text-bn-text-primary">{name}</span>
										{/* 拓展订阅的在播标一枚平台徽章(同订阅卡),B 站房间不标。 */}
										{platform ? (
											<Pill size="sm" subtle color={platform.color ?? "var(--color-bn-inactive)"}>
												{platform.label}
											</Pill>
										) : null}
										{r.category ? (
											<Pill color="var(--color-bn-pink)" subtle size="sm">
												{r.category}
											</Pill>
										) : null}
									</div>
									<div className="truncate text-bn-sm text-bn-text-tertiary">
										{r.title ?? tx("dashboard.live.noTitle")}
									</div>
								</div>
								<div className="flex flex-col items-end gap-1">
									<span className="inline-flex items-center gap-1 text-bn-xs font-bold text-bn-pink">
										<Icon.eye size={11} />
										{viewers}
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
	const tx = useT();
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
		<GlassPanel
			title={tx("sourceUi.pages.Dashboard.title.1")}
			subtitle={tx("sourceUi.pages.Dashboard.subtitle.2")}
			accent="var(--color-bn-blue)"
			icon={<Icon.chart width={15} height={15} />}
		>
			{/* TimelinePanel 6 条 history × 单行 ~50px + padding ≈ 320px;StatsBar 抬高
			    到 280 让同行 TrendPanel 视觉对齐,不至于半空。 */}
			{/* 柱子与下面的图例走同一份家族色 —— 此前柱子在库里写死,和图例只是碰巧同色。 */}
			<StatsBar
				data={data}
				height={280}
				colors={{
					live: PUSH_TONE.live,
					dyn: PUSH_TONE.post,
					sc: PUSH_TONE.superchat,
					guard: PUSH_TONE.membership,
				}}
			/>
			<div className="mt-3.5 flex flex-wrap items-center gap-3 text-bn-xs text-bn-text-tertiary">
				{[
					[tx("extension.reportDiscrepancies.kindLive"), PUSH_TONE.live],
					[tx("sourceUi.pages.Dashboard.TrendPanel.3"), PUSH_TONE.post],
					["SC", PUSH_TONE.superchat],
					[tx("sourceUi.pages.Dashboard.TrendPanel.4"), PUSH_TONE.membership],
				].map(([label, c]) => (
					<span key={label} className="inline-flex items-center gap-1.5">
						<span className="block h-2 w-2 rounded-sm" style={{ background: c }} />
						{label}
					</span>
				))}
				<span className="ml-auto tabular-nums text-bn-xs text-bn-text-secondary">
					{tx("sourceUi.pages.Dashboard.TrendPanel.5")}
					{total}
					{tx("sourceUi.pages.Dashboard.TrendPanel.6")}
				</span>
			</div>
		</GlassPanel>
	);
}

function AiInsightStrip({ tip }: { tip: React.ReactNode }) {
	const tx = useT();
	return (
		<HeroStrip
			compact
			icon={<Icon.ai size={20} />}
			right={
				<Btn size="sm" variant="ghost">
					{tx("sourceUi.pages.Dashboard.right.7")}
				</Btn>
			}
		>
			<div className="text-bn-sm leading-relaxed text-bn-text-tertiary">
				<span className="font-bold text-(--bn-ai-purple)">
					{tx("sourceUi.pages.Dashboard.AiInsightStrip.8")}
				</span>
				{tip}
			</div>
		</HeroStrip>
	);
}

export function TimelinePanel({
	entries,
	subs,
	targets,
	sources,
	extensions: _extensions,
}: {
	entries: HistoryEntryView[];
	subs: Subscription[];
	targets: PushTarget[];
	/** 来源表 —— 拓展行对不上名字时写「平台名 · 外部 id」,平台名照描述符(取自清单)。没回来时写拓展 id。 */
	sources?: readonly SourceEntry[];
	/** 装着的拓展 —— 来源表里没有时退它的名字。 */
	extensions?: readonly ExtensionEntryView[];
}) {
	const tx = useT();
	// 历史行先按 `subscriptionId` 对订阅,不在了再按身份找(B 站行按 uid、拓展行按拓展 id + 外部 id,
	// ADR-0019 决策 50 / 73,与服务端重推同一条规矩)—— 删了又重加的 UP,旧行照样对得上现在那条。
	const lookup = useMemo(() => createSubscriptionLookup(subs), [subs]);
	const targetById = useMemo(() => {
		const m = new Map<string, PushTarget>();
		for (const t of targets) m.set(t.id, t);
		return m;
	}, [targets]);
	const platformFor = (identity: { sourceKey: string }) =>
		subscriptionPlatformOf(identity, sources);
	// 这一栏说的是发出去的推送:被静音 / 免扰挡下的行、被过滤的作品留的行都不算推送,不列(历史页照列),
	// 也不占这六个位子。
	const recent = entries
		.filter((h) => h.status !== "silenced" && h.status !== "filtered")
		.slice(0, 6);
	return (
		<GlassPanel
			title={tx("sourceUi.pages.Dashboard.title.9")}
			subtitle={tx("sourceUi.pages.Dashboard.subtitle.10")}
			// 与 KPI 行的「今日推送」同一抹紫 —— 讲的是同一件事(发出去的推送)。
			accent="var(--color-bn-purple)"
			icon={<Icon.bell width={15} height={15} />}
			right={
				<Link to="/history">
					<Btn size="sm" variant="ghost">
						{tx("sourceUi.pages.Dashboard.right.11")}
					</Btn>
				</Link>
			}
		>
			{recent.length === 0 ? (
				<EmptyNote>
					{tx("sourceUi.pages.Dashboard.TimelinePanel.12")}
					<br />
					<span className="text-bn-xs text-bn-text-secondary/80">
						{tx("sourceUi.pages.Dashboard.TimelinePanel.13")}
					</span>
				</EmptyNote>
			) : (
				<div className="relative pl-1">
					<div
						// 竖线的横位置跟着左列(下面 `w-14`)的宽度走:左列从 w-11 加宽到 w-14(+12px)以放下
						// 带空格的「59 分钟前」,线同步从 left-15 右移到 left-18。
						className="absolute left-18 top-2 bottom-2 w-0.5 opacity-25"
						style={{
							background:
								"linear-gradient(to bottom, var(--color-bn-pink), var(--color-bn-blue), transparent)",
						}}
					/>
					{recent.map((h) => {
						const sub = lookup.forRow(h);
						// 优先 entry 自带的写入期 snapshot —— 订阅后续被删除仍能正确显示。都对不上就写身份:
						// B 站行「UID xxx」,拓展行「平台名 · 外部 id」(决策 73)。
						const name = displayNameOf(
							{ profileName: h.nameSnapshot },
							sub
								? displayName(sub, platformFor(sub.identity))
								: historyRowIdentity(h, platformFor(h.identity)),
						);
						// 头像快照是图库引用(只有拓展行有);没有快照 / 过了保留期就退到订阅现在的头像,再没有就是默认占位。
						const avatar = historyRowAvatarUrl(h, sub?.cachedProfile);
						// 颜色跟着人走,与订阅卡同一个颜色(决策 73)。
						const color = historyRowColor(h, platformFor(h.identity));
						// 平台徽章显隐沿用来源投影：已知单来源且命中当前项时隐藏。
						const platform = platformFor(h.identity);
						const tone = familyTone(h.feature);
						const status = PUSH_STATUS_META[h.status];
						const marked = h.status !== "delivered";
						const targetName =
							h.targetId === null
								? "—"
								: (targetById.get(h.targetId)?.name ?? h.targetId.slice(0, 6));
						const headline = headlineOf(h);
						const count = messageCountOf(h);
						return (
							<div key={h.id} className="mb-2.5 flex items-center gap-3">
								<div className="w-14 whitespace-nowrap text-right tabular-nums text-bn-xs text-bn-text-secondary">
									{formatAgo(h.createdAt) ?? "—"}
								</div>
								<div className="relative z-bn-raised">
									<span
										className="block h-3 w-3 rounded-full border-[2.5px] border-bn-surface"
										style={{ background: tone, boxShadow: "0 0 0 1.5px rgba(0,0,0,0.04)" }}
									/>
								</div>
								<div
									className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-bn-list-row-border bg-bn-list-row px-3 py-2 text-bn-sm"
									// 状态标记用 inset 阴影而非 border-left:不占 box 宽度,内容不被挤右、与其它行对齐,
									// 且被 rounded-lg 圆角裁成左侧细色条,比硬边框精致。失败红、部分失败 / 无目标警示色。
									style={marked ? { boxShadow: `inset 3px 0 0 ${status.tone}` } : undefined}
								>
									<Avatar name={name} color={color} size={24} url={avatar} />
									<Pill color={tone} subtle size="sm">
										{FEATURE_DESCRIPTORS[h.feature].label}
									</Pill>
									{platform.showBadge ? (
										<Pill size="sm" subtle color={platform.color ?? "var(--color-bn-inactive)"}>
											{platform.shortLabel ?? platform.label}
										</Pill>
									) : null}
									<div className="min-w-0 flex-1 truncate text-bn-text-tertiary">
										<span className="font-bold text-bn-text-primary">{name}</span>
										{headline ? ` · ${headline}` : ""}
									</div>
									{count > 1 ? (
										<Pill color={tone} subtle size="sm">
											{count}
											{tx("sourceUi.components.toast.shell.ToastCard.2")}
										</Pill>
									) : null}
									<span className="text-bn-xs text-bn-text-secondary">→ {targetName}</span>
									<Pill color={status.tone} subtle size="sm">
										{status.label}
									</Pill>
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

/**
 * 粉丝面板那一行画成什么样(ADR-0020 决策 8)。条目按订阅 id 对订阅:名字走订阅卡那条链
 * (`displayName`:资料里的名字 → B 站「UID xxx」/ 拓展的外部 id),头像是那条订阅的;订阅列表还没回来时
 * 名字照 `historyRowIdentity`(B 站写「UID x」、拓展写平台名加外部 id)。颜色照 `identityColor` 跟着人走
 * (与订阅卡、历史页、统计页同一个颜色)。拓展行另带一枚平台徽章(同「正在直播」)。条目带着订阅的身份,
 * 订阅列表还没回来时这些也都能画。
 */
function fansRowFace(
	e: FollowersRefreshEntry,
	lookup: SubscriptionLookup,
	sources: readonly SourceEntry[] | undefined,
	_extensions: readonly ExtensionEntryView[] | undefined,
): { name: string; color: string; avatar?: string; platform?: { label: string; color?: string } } {
	const sub = lookup.byId(e.subscriptionId);
	const base = {
		color: identityColor(e.identity, subscriptionPlatformOf(e.identity, sources)),
		avatar: profileAvatarUrl(sub?.cachedProfile),
	};
	const platform = subscriptionPlatformOf(e.identity, sources);
	return {
		...base,
		name: sub ? displayName(sub, platform) : historyRowIdentity(e, platform),
		platform: platform.showBadge
			? { label: platform.shortLabel ?? platform.label, color: platform.color }
			: undefined,
	};
}

function FansDeltaCol({ label, value }: { label: string; value: number | null }) {
	const isNull = value == null;
	const text = isNull ? "—" : formatCount(value, { signed: true });
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

export function FansPanel({
	subs,
	sources,
	extensions,
}: {
	subs: Subscription[];
	/** 来源表 —— 拓展行的平台徽章照描述符(取自清单);没回来时徽章写拓展名或拓展 id。 */
	sources?: readonly SourceEntry[];
	/** 装着的拓展 —— 来源表里没有时退它的名字。 */
	extensions?: readonly ExtensionEntryView[];
}) {
	const tx = useT();
	// 不轮询 — 由 usePushEventsChannel 的 `followers-refreshed` 覆盖式刷新缓存。
	const fansQuery = useQuery({
		queryKey: FOLLOWERS_QUERY_KEY,
		queryFn: () => api.get<FollowersResponse>("/api/stats/followers"),
	});
	// 条目按订阅 id 记(ADR-0020 决策 8):B 站订阅与有粉丝时序的拓展订阅各一行。按 uid 对的话,拓展行对不上、
	// 同一个 uid 的两条订阅也分不开。
	const lookup = useMemo(() => createSubscriptionLookup(subs), [subs]);

	const entries: FollowersRefreshEntry[] = fansQuery.data?.entries ?? [];
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
			title={tx("sourceUi.pages.Dashboard.title.14")}
			subtitle={tx("sourceUi.pages.Dashboard.subtitle.15")}
			accent="var(--color-bn-pink)"
			icon={<Icon.heart width={15} height={15} />}
			right={
				<Pill color="var(--color-bn-pink)" size="sm">
					● {entries.length}
					{tx("sourceUi.pages.Dashboard.right.16")}
				</Pill>
			}
		>
			{entries.length === 0 ? (
				<EmptyNote>
					{tx("sourceUi.pages.Dashboard.FansPanel.17")}
					<br />
					<span className="text-bn-xs text-bn-text-secondary/80">
						{tx("sourceUi.pages.Dashboard.FansPanel.18")}
					</span>
				</EmptyNote>
			) : (
				// 单列布局,max-h 上限 ≈ 3 行行卡(每行 ~62px + 8px gap);N 多时走
				// 内滚动,bn-no-scrollbar 隐藏滚动条不破坏卡片视觉。N 少时高度自然撑,
				// 跟同行「正在直播」由 grid row-stretch 拉到等高。
				<div className="bn-no-scrollbar grid max-h-60 grid-cols-1 gap-2 overflow-y-auto">
					{sorted.map((e) => {
						const { name, color, avatar, platform } = fansRowFace(e, lookup, sources, extensions);
						return (
							<div
								key={e.subscriptionId}
								className="flex items-center gap-3 rounded-lg border border-bn-list-row-border bg-bn-list-row px-3 py-2.5 text-bn-sm"
							>
								<Avatar name={name} color={color} size={32} url={avatar} />
								<div className="min-w-0 flex-1">
									<div className="flex min-w-0 items-center gap-1.5">
										<span className="truncate font-bold text-bn-text-primary">{name}</span>
										{platform ? (
											<Pill size="sm" subtle color={platform.color ?? "var(--color-bn-inactive)"}>
												{platform.label}
											</Pill>
										) : null}
									</div>
									<div className="tabular-nums text-bn-xs text-bn-text-tertiary">
										{formatCount(e.current)}
										{tx("sourceUi.pages.Dashboard.FansPanel.19")}
									</div>
								</div>
								<FansDeltaCol
									label={tx("sourceUi.pages.Dashboard.label.20")}
									value={e.deltaSubscribed}
								/>
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

export { SystemHealthCard } from "../components/system-health-card";

export default function Overview() {
	const tx = useT();
	const [healthHeight, setHealthHeight] = useState(0);
	const [resourceHeight, setResourceHeight] = useState(0);

	const reachable = useBackendReachable();

	const health = useQuery(HEALTH_QUERY_OPTIONS);

	const updateQuery = useUpdateStatus();
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subscriptions"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const liveQuery = useQuery({
		queryKey: ["live", "listening"],
		queryFn: () => api.get<LiveListeningEntry[]>("/api/live/listening"),
		// 不再轮询；usePushEventsChannel 监听 WS `live-session-changed`:进表 / 出表就 invalidate 重取,
		// 在播中的标题 / 分区 / 累计观看随 `live-session-changed` 与 `live-viewers-changed` 就地补。
	});
	// 拓展订阅那几行的平台徽章照来源表画(取自清单);只是锦上添花,拓展列表拿不到就不重试(同订阅页)。
	const extensionsQuery = useExtensions({ retry: false });
	const sources = useSources().data?.sources;
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
	const globalsQuery = useCoreSettings();
	// 只在这一页订 `resources`:服务端据此决定还量不量浏览器子树(那一步要起子进程)。
	const resources = useResourcesChannel();

	const subs = subsQuery.data ?? [];
	const targets = targetsQuery.data ?? [];
	const live = liveQuery.data ?? [];
	const countStatus = !subsQuery.isSuccess
		? subsQuery.status
		: subs.length === 0
			? "success"
			: !globalsQuery.isSuccess
				? globalsQuery.status
				: globalsQuery.data?.defaults?.features
					? "success"
					: "error";
	// 小贴士说谁:优先挑支持直播回顾的在播来源，其余按快照顺序。
	const tipLive =
		live.find((r) =>
			subscriptionPlatformOf(r.identity, sources).supportedExtras.includes("liveSummary"),
		) ?? live[0];
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

	const aiTip = liveQuery.isSuccess ? (
		live.length > 0 ? (
			<>
				<b>
					{(() => {
						// 与「正在直播」那块同一口径:按快照里的订阅 id 对(ADR-0019 决策 50)。
						const sub = subs.find((s) => s.id === tipLive?.subscriptionId);
						if (sub) return displayName(sub, subscriptionPlatformOf(sub.identity, sources));
						// 订阅还没回来时按来源描述符展示身份(同「正在直播」那块)。
						if (!tipLive) return "";
						return historyRowIdentity(tipLive, subscriptionPlatformOf(tipLive.identity, sources));
					})()}
				</b>{" "}
				{/* 按来源声明决定是否提示直播回顾。 */}
				{tipLive &&
				!subscriptionPlatformOf(tipLive.identity, sources).supportedExtras.includes("liveSummary")
					? tx("sourceUi.pages.Dashboard.Dashboard.54")
					: tx("sourceUi.pages.Dashboard.Dashboard.55")}
			</>
		) : (
			<>
				{tx("sourceUi.pages.Dashboard.Dashboard.56")}
				<b>{tx("extensions.provides.subscription")}</b>
				{tx("sourceUi.pages.Dashboard.Dashboard.57")}
				<b>{tx("stats.push.target")}</b>
				{tx("sourceUi.pages.Dashboard.Dashboard.58")}
			</>
		)
	) : (
		tx("healthCard.insightUnknown")
	);

	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			{/* KPI grid(构图对齐统计页:gap-3、带 footer 的卡定行高,其余同行等高)*/}
			<div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
				<GlassStatCard
					label={tx("dashboard.live.title")}
					value={liveQuery.isSuccess ? live.length : "—"}
					suffix={`/ ${subsQuery.isSuccess ? subs.length : "—"}`}
					color="var(--color-bn-pink)"
					pulse={liveQuery.isSuccess && live.length > 0}
				/>
				<GlassStatCard
					label={tx("sourceUi.pages.Dashboard.label.62")}
					value={enabledSubs}
					suffix={`/ ${subs.length}`}
					color="var(--color-bn-blue)"
				/>
				<GlassStatCard
					label={tx("sourceUi.pages.Dashboard.label.63")}
					value={todayPushes}
					suffix={tx("sourceUi.pages.Dashboard.suffix.64")}
					color="var(--color-bn-purple)"
					footer={
						<>
							<DeltaTag v={pushDelta} size={11.5} />
							<span className="text-bn-2xs text-bn-text-secondary">
								{tx("sourceUi.pages.Dashboard.footer.65")}
							</span>
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
					label={tx("sourceUi.pages.Dashboard.label.66")}
					value={todayFailed}
					suffix={tx("sourceUi.pages.Dashboard.suffix.64")}
					color={todayFailed > 0 ? "var(--color-bn-danger)" : "var(--color-bn-success)"}
					pulse={todayFailed > 0}
				/>
			</div>

			{/* row 2: 正在直播(宽) + 粉丝数变化(窄) */}
			<div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1.3fr_1fr]">
				<LiveNowPanel
					live={live}
					liveStatus={liveQuery.status}
					countStatus={countStatus}
					subs={subs}
					sources={sources}
					extensions={extensionsQuery.data?.extensions}
					globalFeatures={globalsQuery.data?.defaults?.features}
				/>
				<FansPanel subs={subs} sources={sources} extensions={extensionsQuery.data?.extensions} />
			</div>

			{/* AI insight strip */}
			<AiInsightStrip tip={aiTip} />

			{/* row 4: 推送趋势(窄) + 最近推送活动(宽) —— 跟 row 2 的列比反向,视觉错位 */}
			<div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1fr_1.3fr]">
				<TrendPanel daily={daily} />
				<TimelinePanel
					entries={history}
					subs={subs}
					targets={targets}
					sources={sources}
					extensions={extensionsQuery.data?.extensions}
				/>
			</div>

			{/* 资源在左，状态占主要宽度；仅默认高度对齐，状态展开独立增高。 */}
			<div
				className="@container/system-row"
				style={
					{
						"--system-default-height": `${Math.max(healthHeight, resourceHeight)}px`,
					} as CSSProperties
				}
			>
				<div className="grid grid-cols-1 items-start gap-3.5 @min-[1104px]/system-row:grid-cols-[minmax(520px,min(680px,48%))_minmax(560px,1fr)]">
					<SystemResourceCard
						state={resources}
						reachable={reachable}
						onContentHeightChange={setResourceHeight}
					/>
					<SystemHealthCard
						health={health.data}
						reachable={reachable}
						update={updateQuery.data}
						onDefaultHeightChange={setHealthHeight}
					/>
				</div>
			</div>
		</div>
	);
}
