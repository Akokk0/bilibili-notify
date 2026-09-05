import { Avatar, ErrorNote, Icon, Input, LoadingBlock, Picker, Pill } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { PUSH_KIND_META, PUSH_STATUS_META, PUSH_TONE } from "../config/push-kinds";
import { api } from "../services/api";
import {
	type HistoryEntryView,
	type HistoryMessageView,
	type HistoryResponse,
	historyQueryKey,
	type PushKind,
} from "../services/dashboard";
import type { PushTarget, Subscription } from "../types/domain";
import type { GlobalConfig } from "../types/globals";
import { hasDetails, headlineOf, messageCountOf } from "../utils/push-row";
import { colorFromUid, displayName, relativeTime } from "./up/helpers";

/**
 * `/history` — 1:1 port of `.bn-design/variation-a-tabs.jsx#HistoryTab`,
 * backed by the live `/api/history` route + jsonl-by-day store.
 *
 * 一行 = 一次推送 × 一个目标:首条本体当文案,多条挂「N 条」胶囊,行可展开逐条看
 * (文案 / 图缩略 / 结果);状态四态。八种推送类型折进四个家族筛选(直播 / 动态 /
 * SC / 舰长),与 `services/dashboard.ts#FAMILY` 同一张表,和概览趋势图对得上。
 *
 * The "重发" column from the design source is intentionally not ported:
 * /api/push/test sends a dummy text payload, so a button labelled
 * "重发" would mislead users into thinking the original message goes
 * back out. That route lands when the server gains a re-deliver path
 * that replays a recorded NotificationPayload.
 */

type FilterId = "all" | "live" | "dynamic" | "sc" | "guard";

const FAMILY: Record<PushKind, Exclude<FilterId, "all">> = {
	live: "live",
	"live-ongoing": "live",
	"live-end": "live",
	"special-enter": "live",
	"special-danmaku": "live",
	dynamic: "dynamic",
	sc: "sc",
	guard: "guard",
};

const FILTERS: ReadonlyArray<{ id: FilterId; label: string; tone: string }> = [
	{ id: "all", label: "全部", tone: "var(--color-bn-inactive)" },
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
			if (filterId !== "all" && FAMILY[e.kind] !== filterId) return false;
			if (!ql) return true;
			const sub = subByUid.get(e.uid);
			const upName = sub ? displayName(sub).toLowerCase() : "";
			const target = (e.targetId ? (targetById.get(e.targetId)?.name ?? "") : "").toLowerCase();
			// 搜整行的每一条文案,不只搜标题那句 —— 总结正文就藏在后面几条里。
			const texts = e.messages
				.map((m) => m.text ?? "")
				.join("\n")
				.toLowerCase();
			return e.uid.includes(ql) || upName.includes(ql) || texts.includes(ql) || target.includes(ql);
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
				{/*
				 * 段选而不是一排散胶囊(2026-08-24 主人真机指出「都看不清」):描边胶囊
				 * 浮在页面背景上,而背景是皮肤说了算的 —— 花底一铺,组和选中态就都读不出来。
				 * Picker 自带实底轨道,选中那段抬起来,不吃背景的亏。
				 */}
				<Picker<FilterId>
					value={filterId}
					onChange={setFilterId}
					options={FILTERS.map((f) => ({ value: f.id, label: f.label, color: f.tone }))}
				/>
				<div className="flex-1" />
				<span className="text-bn-xs text-bn-text-tertiary">
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
				className="grid items-center gap-2.5 border-b border-bn-border-subtle bg-bn-surface-muted/70 px-4 py-2.5 text-bn-xs font-bold tracking-wide text-bn-text-tertiary"
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
				<div className="px-4 py-10 text-center text-bn-sm text-bn-text-tertiary">
					没有符合条件的推送记录
				</div>
			) : (
				entries.map((e, i) => (
					<HistoryRow
						key={e.id}
						entry={e}
						sub={subByUid.get(e.uid)}
						target={e.targetId ? targetById.get(e.targetId) : undefined}
						isLast={i === entries.length - 1}
					/>
				))
			)}
		</div>
	);
}

const HISTORY_GRID = "100px 28px 64px 1fr 200px 100px";

/** 目标列:无目标行写「—」;目标事后被删写「已删除目标」。 */
function targetLabelOf(entry: HistoryEntryView, target: PushTarget | undefined): string {
	if (entry.targetId === null) return "—";
	return target?.name ?? "已删除目标";
}

function HistoryRow({
	entry,
	sub,
	target,
	isLast,
}: {
	entry: HistoryEntryView;
	sub: Subscription | undefined;
	target: PushTarget | undefined;
	isLast: boolean;
}) {
	const [open, setOpen] = useState(false);
	const family = FAMILY[entry.kind];
	const tone = PUSH_TONE[family];
	const status = PUSH_STATUS_META[entry.status];
	// 优先 entry 写入期的 snapshot,订阅事后被删也能稳定显示。
	const upName = entry.unameSnapshot ?? (sub ? displayName(sub) : entry.uid || "未知");
	const upAvatar = entry.uavatarSnapshot ?? sub?.cachedProfile?.avatar;
	const upColor = colorFromUid(entry.uid || entry.id);
	const headline = headlineOf(entry);
	const count = messageCountOf(entry);
	const expandable = hasDetails(entry);
	const targetLabel = targetLabelOf(entry, target);

	return (
		<div className={isLast ? "" : "border-b border-bn-border-subtle"}>
			<div
				className="grid items-center gap-2.5 px-4 py-3 text-bn-sm"
				style={{ gridTemplateColumns: HISTORY_GRID }}
			>
				<span className="tabular-nums text-bn-xs text-bn-text-tertiary">
					{relativeTime(entry.ts)}
				</span>
				<Avatar name={upName} color={upColor} size={24} url={upAvatar} />
				<Pill color={tone} subtle size="sm">
					{PUSH_KIND_META[entry.kind].label}
				</Pill>
				<div className="flex min-w-0 items-center gap-2">
					<div className="min-w-0 flex-1 truncate" title={headline}>
						<span className="font-bold text-bn-text-primary">{upName}</span>
						{headline ? (
							<span className="ml-1.5 text-bn-text-secondary">{headline}</span>
						) : (
							<span className="ml-1.5 text-bn-text-tertiary">（无内容）</span>
						)}
					</div>
					{expandable ? (
						// 展开钮借 Pill 的形制:多条时写条数,单条(带图 / 带错)写「详情」。
						// 不用 ToneChip:那是「一排里选一个」的胶囊,这里是 aria-expanded 的展开钮;
						// 挂点沿用 chip 那套词,皮肤描边时认得出它是一颗小胶囊。
						<button
							type="button"
							aria-expanded={open}
							data-bn={open ? "chip chip-active" : "chip"}
							onClick={() => setOpen((v) => !v)}
							className="shrink-0 rounded-md text-bn-2xs leading-4 transition hover:opacity-80"
							title={open ? "收起" : "展开逐条查看"}
						>
							<Pill color={tone} subtle size="sm">
								<span>{count > 1 ? `${count} 条` : "详情"}</span>
								<span aria-hidden="true">{open ? " ▴" : " ▾"}</span>
							</Pill>
						</button>
					) : null}
				</div>
				<span className="truncate text-bn-xs text-bn-text-secondary" title={targetLabel}>
					→ {targetLabel}
				</span>
				<Pill color={status.tone} subtle size="sm">
					{status.label}
				</Pill>
			</div>
			{open ? <MessageList entry={entry} /> : null}
		</div>
	);
}

/** 展开后的逐条明细:序号 / 本体还是附加项 / 文案 / 图缩略 / 这条的结果。 */
function MessageList({ entry }: { entry: HistoryEntryView }) {
	return (
		<ol className="space-y-1.5 border-t border-bn-border-subtle bg-bn-surface-muted/50 px-4 py-2.5 pl-38">
			{entry.messages.map((m, i) => (
				<MessageItem
					// biome-ignore lint/suspicious/noArrayIndexKey: 行内消息按序追加、从不重排删除,序号就是它的身份
					key={`${entry.id}-${i}`}
					index={i}
					message={m}
					noTargets={entry.targetId === null}
				/>
			))}
		</ol>
	);
}

function MessageItem({
	index,
	message,
	noTargets,
}: {
	index: number;
	message: HistoryMessageView;
	noTargets: boolean;
}) {
	const result = noTargets
		? { label: "未发送", tone: "var(--color-bn-inactive)" }
		: message.ok === undefined
			? { label: "未发送", tone: "var(--color-bn-inactive)" }
			: message.ok
				? { label: "已送达", tone: "var(--color-bn-success)" }
				: { label: "失败", tone: "var(--color-bn-danger)" };
	return (
		<li className="flex items-start gap-2.5 text-bn-xs">
			<span className="w-4 shrink-0 tabular-nums text-bn-text-tertiary">{index + 1}</span>
			<span className="w-10 shrink-0 text-bn-text-tertiary">
				{message.role === "main" ? "本体" : "附加"}
			</span>
			{message.imageRef ? (
				<img
					src={`/api/history/img/${message.imageRef}`}
					alt={message.text ?? "图片"}
					className="h-12 w-12 shrink-0 rounded-md object-cover"
					loading="lazy"
				/>
			) : null}
			<span className="min-w-0 flex-1 break-words text-bn-text-secondary">
				{message.text ?? <span className="text-bn-text-tertiary">（无内容）</span>}
				{message.err ? <span className="ml-1.5 text-bn-danger">{message.err}</span> : null}
			</span>
			<Pill color={result.tone} subtle size="sm">
				{result.label}
			</Pill>
		</li>
	);
}
