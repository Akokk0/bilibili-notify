import { Avatar, ErrorNote, Icon, Input, LoadingBlock, Pill, ToneChip } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { PUSH_KIND_META, PUSH_TONE } from "../config/push-kinds";
import { api } from "../services/api";
import {
	type HistoryEntryView,
	type HistoryResponse,
	type HistorySource,
	historyQueryKey,
} from "../services/dashboard";
import type { PushTarget, Subscription } from "../types/domain";
import type { GlobalConfig } from "../types/globals";
import { colorFromUid, displayName, relativeTime } from "./up/helpers";

/**
 * `/history` — 1:1 port of `.bn-design/variation-a-tabs.jsx#HistoryTab`,
 * backed by the live `/api/history` route + jsonl-by-day store.
 *
 * Source families collapse onto four primary pill filters (live / 动态 /
 * SC / 舰长). The seven HistorySource buckets fan into the four families
 * the same way `services/dashboard.ts#FAMILY` does, so per-family counts
 * line up with the Dashboard trend chart.
 *
 * The "重发" column from the design source is intentionally not ported:
 * /api/push/test sends a dummy text payload, so a button labelled
 * "重发" would mislead users into thinking the original message goes
 * back out. That route lands when the server gains a re-deliver path
 * that replays a recorded NotificationPayload.
 */

type FilterId = "all" | "live" | "dynamic" | "sc" | "guard";

const FAMILY: Record<HistorySource, Exclude<FilterId, "all">> = {
	live: "live",
	"live-summary": "live",
	"special-enter": "live",
	"special-danmaku": "live",
	dynamic: "dynamic",
	sc: "sc",
	guard: "guard",
};

const FILTERS: ReadonlyArray<{ id: FilterId; label: string; tone: string }> = [
	{ id: "all", label: "全部", tone: "#666" },
	{ id: "live", label: "直播", tone: PUSH_TONE.live },
	{ id: "dynamic", label: "动态", tone: PUSH_TONE.dynamic },
	{ id: "sc", label: "SC", tone: PUSH_TONE.sc },
	{ id: "guard", label: "舰长", tone: PUSH_TONE.guard },
];

export default function History() {
	const [filterId, setFilterId] = useState<FilterId>("all");
	const [q, setQ] = useState("");

	// Cache is kept fresh by `usePushEventsChannel` (WS push-events → setQueryData),
	// so the page renders new entries within ~1s of delivery without polling.
	const historyQuery = useQuery({
		// HI1:按 limit 区分缓存键(单一来源 historyQueryKey)。与 Dashboard 的
		// limit:100 不再撞同一缓存(否则两份数据集随导航顺序互相覆盖,非确定)。
		queryKey: historyQueryKey(200),
		queryFn: () => api.get<HistoryResponse>("/api/history?limit=200"),
	});
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const globalsQuery = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const retentionDays = globalsQuery.data?.app.historyRetentionDays;

	const subByUid = useMemo(() => {
		const m = new Map<string, Subscription>();
		for (const s of subsQuery.data ?? []) m.set(s.uid, s);
		return m;
	}, [subsQuery.data]);
	const targetById = useMemo(() => {
		const m = new Map<string, PushTarget>();
		for (const t of targetsQuery.data ?? []) m.set(t.id, t);
		return m;
	}, [targetsQuery.data]);

	const entries = historyQuery.data?.entries ?? [];

	const filtered = useMemo(() => {
		const ql = q.trim().toLowerCase();
		return entries.filter((e) => {
			if (filterId !== "all" && FAMILY[e.source] !== filterId) return false;
			if (!ql) return true;
			const sub = subByUid.get(e.uid);
			const upName = sub ? displayName(sub).toLowerCase() : "";
			const targets = e.targetIds
				.map((id) => targetById.get(id)?.name ?? "")
				.join(" ")
				.toLowerCase();
			return (
				e.uid.includes(ql) ||
				upName.includes(ql) ||
				(e.text ?? "").toLowerCase().includes(ql) ||
				targets.includes(ql)
			);
		});
	}, [entries, filterId, q, subByUid, targetById]);

	return (
		<div className="bn-anim-page-in space-y-3.5">
			<div className="flex flex-wrap items-center gap-2.5">
				<Input
					value={q}
					onChange={setQ}
					placeholder="按 UP 主、内容、目标搜索..."
					icon={<Icon.search size={14} />}
				/>
				<div className="flex gap-1">
					{FILTERS.map((f) => (
						<ToneChip
							key={f.id}
							tone={f.tone}
							active={filterId === f.id}
							onClick={() => setFilterId(f.id)}
						>
							{f.label}
						</ToneChip>
					))}
				</div>
				<div className="flex-1" />
				<span className="text-[11px] text-bn-text-tertiary">
					共 {filtered.length} 条{retentionDays != null ? ` · 保留近 ${retentionDays} 天` : ""}
				</span>
			</div>

			{historyQuery.isLoading ? (
				<LoadingBlock label="正在读取推送历史" hint="女仆正在翻记录本,一条条对过去 (｡･ω･｡)ﾉ" />
			) : historyQuery.error ? (
				<ErrorNote>加载失败：{String((historyQuery.error as Error).message)}</ErrorNote>
			) : (
				<HistoryTable entries={filtered} subByUid={subByUid} targetById={targetById} />
			)}
		</div>
	);
}

function HistoryTable({
	entries,
	subByUid,
	targetById,
}: {
	entries: HistoryEntryView[];
	subByUid: Map<string, Subscription>;
	targetById: Map<string, PushTarget>;
}) {
	return (
		<div className="bn-glass overflow-hidden rounded-bn-sm shadow-bn-card">
			<div
				className="grid items-center gap-2.5 border-b border-bn-border-subtle bg-bn-surface-muted/70 px-4 py-2.5 text-[11px] font-bold tracking-wide text-bn-text-tertiary"
				style={{ gridTemplateColumns: HISTORY_GRID }}
			>
				<span>时间</span>
				<span></span>
				<span>类型</span>
				<span>内容</span>
				<span>推送目标</span>
				<span>状态</span>
			</div>

			{entries.length === 0 ? (
				<div className="px-4 py-10 text-center text-[12.5px] text-bn-text-tertiary">
					没有符合条件的推送记录
				</div>
			) : (
				entries.map((e, i) => (
					<HistoryRow
						key={e.id}
						entry={e}
						sub={subByUid.get(e.uid)}
						targets={e.targetIds.map((id) => targetById.get(id)).filter(Boolean) as PushTarget[]}
						isLast={i === entries.length - 1}
					/>
				))
			)}
		</div>
	);
}

const HISTORY_GRID = "100px 28px 64px 1fr 200px 100px";

function HistoryRow({
	entry,
	sub,
	targets,
	isLast,
}: {
	entry: HistoryEntryView;
	sub: Subscription | undefined;
	targets: PushTarget[];
	isLast: boolean;
}) {
	const family = FAMILY[entry.source];
	const tone = PUSH_TONE[family];
	// 优先 entry 写入期的 snapshot,订阅事后被删也能稳定显示。
	const upName = entry.unameSnapshot ?? (sub ? displayName(sub) : entry.uid || "未知");
	const upAvatar = entry.uavatarSnapshot ?? sub?.cachedProfile?.avatar;
	const upColor = colorFromUid(entry.uid || entry.id);
	const targetLabel =
		targets.length === 0
			? entry.targetIds.length === 0
				? "—"
				: `${entry.targetIds.length} 个已删除目标`
			: targets.map((t) => t.name).join(", ");

	return (
		<div
			className={`grid items-center gap-2.5 px-4 py-3 text-[12.5px] ${
				isLast ? "" : "border-b border-bn-border-subtle"
			}`}
			style={{ gridTemplateColumns: HISTORY_GRID }}
		>
			<span className="font-mono text-[11.5px] text-bn-text-tertiary">
				{relativeTime(entry.ts)}
			</span>
			<Avatar name={upName} color={upColor} size={24} url={upAvatar} />
			<Pill color={tone} subtle size="sm">
				{PUSH_KIND_META[entry.source].label}
			</Pill>
			<div className="min-w-0 truncate" title={entry.text}>
				<span className="font-bold text-bn-text-primary">{upName}</span>
				{entry.text ? (
					<span className="ml-1.5 text-bn-text-secondary">{entry.text}</span>
				) : (
					<span className="ml-1.5 text-bn-text-tertiary">（无内容）</span>
				)}
			</div>
			<span
				className="truncate text-[11.5px] text-bn-text-secondary"
				title={targets.map((t) => t.name).join(", ")}
			>
				→ {targetLabel}
			</span>
			{entry.ok ? (
				<Pill color="var(--color-bn-success)" subtle size="sm">
					已送达
				</Pill>
			) : (
				<Pill color="var(--color-bn-danger)" subtle size="sm">
					失败
				</Pill>
			)}
		</div>
	);
}
