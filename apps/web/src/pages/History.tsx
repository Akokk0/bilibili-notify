import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Avatar, Input, Pill } from "../components/atoms";
import { Icon } from "../components/icons";
import { api } from "../services/api";
import type { HistoryEntryView, HistoryResponse, HistorySource } from "../services/dashboard";
import type { PushTarget, Subscription } from "../types/domain";
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

const SOURCE_LABEL: Record<HistorySource, string> = {
	dynamic: "动态",
	live: "直播",
	sc: "SC",
	guard: "舰长",
	"special-danmaku": "弹幕",
	"special-enter": "入场",
	"live-summary": "总结",
};

const FAMILY_TONE: Record<Exclude<FilterId, "all">, string> = {
	live: "#FB7299",
	dynamic: "#00AEEC",
	sc: "#fdcb6e",
	guard: "#f2a053",
};

const FILTERS: ReadonlyArray<{ id: FilterId; label: string; tone: string }> = [
	{ id: "all", label: "全部", tone: "#666" },
	{ id: "live", label: "直播", tone: FAMILY_TONE.live },
	{ id: "dynamic", label: "动态", tone: FAMILY_TONE.dynamic },
	{ id: "sc", label: "SC", tone: FAMILY_TONE.sc },
	{ id: "guard", label: "舰长", tone: FAMILY_TONE.guard },
];

export default function History() {
	const [filterId, setFilterId] = useState<FilterId>("all");
	const [q, setQ] = useState("");

	// Cache is kept fresh by `usePushEventsChannel` (WS push-events → setQueryData),
	// so the page renders new entries within ~1s of delivery without polling.
	const historyQuery = useQuery({
		queryKey: ["history"],
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
		<div className="space-y-3.5">
			<div className="flex flex-wrap items-center gap-2.5">
				<Input
					value={q}
					onChange={setQ}
					placeholder="按 UP 主、内容、目标搜索..."
					icon={<Icon.search size={14} />}
				/>
				<div className="flex gap-1">
					{FILTERS.map((f) => {
						const active = filterId === f.id;
						return (
							<button
								key={f.id}
								type="button"
								onClick={() => setFilterId(f.id)}
								className="rounded-full border px-3 py-1 text-[12px] font-semibold transition"
								style={
									active
										? {
												background: `${f.tone}1f`,
												color: f.tone,
												borderColor: `${f.tone}55`,
											}
										: { background: "transparent", color: "#666", borderColor: "#e0e0e0" }
								}
							>
								{f.label}
							</button>
						);
					})}
				</div>
				<div className="flex-1" />
				<span className="text-[11px] text-bn-text-tertiary">
					共 {filtered.length} 条 · 保留近 30 天
				</span>
			</div>

			{historyQuery.isLoading ? (
				<div className="text-sm text-bn-text-tertiary">加载中…</div>
			) : historyQuery.error ? (
				<div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
					加载失败：{String((historyQuery.error as Error).message)}
				</div>
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
		<div className="overflow-hidden rounded-[10px] border border-black/6 bg-white">
			<div
				className="grid items-center gap-2.5 border-b border-black/6 bg-[#fafafb] px-4 py-2.5 text-[11px] font-bold tracking-wide text-bn-text-tertiary"
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
	const tone = FAMILY_TONE[family];
	const upName = sub ? displayName(sub) : entry.uid || "未知";
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
				isLast ? "" : "border-b border-black/4"
			}`}
			style={{ gridTemplateColumns: HISTORY_GRID }}
		>
			<span className="font-mono text-[11.5px] text-bn-text-tertiary">
				{relativeTime(entry.ts)}
			</span>
			<Avatar name={upName} color={upColor} size={24} />
			<Pill color={tone} subtle size="sm">
				{SOURCE_LABEL[entry.source]}
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
				<Pill color="#22c55e" subtle size="sm">
					已送达
				</Pill>
			) : (
				<Pill color="#ef4444" subtle size="sm">
					失败
				</Pill>
			)}
		</div>
	);
}
