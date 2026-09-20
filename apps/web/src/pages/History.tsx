import {
	Avatar,
	Btn,
	DisclosurePill,
	ErrorNote,
	Icon,
	IconButton,
	Input,
	LoadingBlock,
	Picker,
	Pill,
} from "@bilibili-notify/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
	familyTone,
	PUSH_KIND_META,
	PUSH_STATUS_META,
	PUSH_TONE,
	type PushFamily,
} from "../config/push-kinds";
import { api } from "../services/api";
import {
	type HistoryEntryView,
	type HistoryMessageView,
	type HistoryRepushResponse,
	type HistoryResponse,
	historyQueryKey,
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

/** 筛选胶囊 = 四个家族(见 PUSH_KIND_META 的 family)加一个「全部」。 */
type FilterId = "all" | PushFamily;

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

	// 每行的检索串只跟这一行有关,先算好:搜的是整行的每一条文案(总结正文就藏在后面
	// 几条里,可以有几 KB),挂在过滤那个 memo 里的话,每敲一个字都要把两百行重拼一遍。
	const haystacks = useMemo(() => {
		const m = new Map<string, string>();
		for (const e of entries) {
			const sub = subByUid.get(e.uid);
			m.set(
				e.id,
				[
					e.uid,
					sub ? displayName(sub) : "",
					e.targetId ? (targetById.get(e.targetId)?.name ?? "") : "",
					...e.messages.map((x) => x.text ?? ""),
				]
					.join("\n")
					.toLowerCase(),
			);
		}
		return m;
	}, [entries, subByUid, targetById]);

	const filtered = useMemo(() => {
		const ql = q.trim().toLowerCase();
		return entries.filter((e) => {
			if (filterId !== "all" && PUSH_KIND_META[e.kind].family !== filterId) return false;
			return !ql || (haystacks.get(e.id)?.includes(ql) ?? false);
		});
	}, [entries, filterId, q, haystacks]);

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
	const [repushOpen, setRepushOpen] = useState(false);
	const tone = familyTone(entry.kind);
	const status = PUSH_STATUS_META[entry.status];
	// 优先 entry 写入期的 snapshot,订阅事后被删也能稳定显示。
	const upName = entry.unameSnapshot ?? (sub ? displayName(sub) : entry.uid || "未知");
	const upAvatar = entry.uavatarSnapshot ?? sub?.cachedProfile?.avatar;
	const upColor = colorFromUid(entry.uid || entry.id);
	const headline = headlineOf(entry);
	const count = messageCountOf(entry);
	const expandable = hasDetails(entry);
	const targetLabel = targetLabelOf(entry, target);
	// 按钮长在 failed 与 partial 上(ADR-0017 决策 6)。**判据是行的状态,不是 `repush`
	// 字段在不在** —— WS 推来的新行不带那个字段,可它恰恰是最该能补的那一种。
	const canOfferRepush = entry.status === "failed" || entry.status === "partial";
	// 不能补时按钮灰掉**并写上原因**,不是藏起来(决策 9)。字段缺省按「能补」处理。
	const repushBlocked = entry.repush && !entry.repush.can ? entry.repush.reason : null;
	const repushCounts = entry.repush?.can ? entry.repush : null;

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
						// 多条时写条数,单条(带图 / 带错)写「详情」。
						<DisclosurePill
							open={open}
							onToggle={() => setOpen((v) => !v)}
							color={tone}
							title={open ? "收起" : "展开逐条查看"}
							className="shrink-0 text-bn-2xs leading-4"
						>
							<span>{count > 1 ? `${count} 条` : "详情"}</span>
							<span aria-hidden="true">{open ? " ▴" : " ▾"}</span>
						</DisclosurePill>
					) : null}
				</div>
				<span className="truncate text-bn-xs text-bn-text-secondary" title={targetLabel}>
					→ {targetLabel}
				</span>
				<div className="flex min-w-0 items-center gap-1">
					<Pill color={status.tone} subtle size="sm">
						{status.label}
					</Pill>
					{canOfferRepush ? (
						<IconButton
							size="sm"
							icon={<Icon.refresh size={12} />}
							label="补一次"
							title={repushBlocked ?? "没送到的，让女仆再补一次"}
							disabled={repushBlocked !== null}
							ariaExpanded={repushOpen}
							onClick={() => setRepushOpen((v) => !v)}
						/>
					) : null}
				</div>
			</div>
			{repushOpen && canOfferRepush && repushBlocked === null ? (
				<RepushBar entry={entry} counts={repushCounts} onClose={() => setRepushOpen(false)} />
			) : null}
			{open ? <MessageList entry={entry} /> : null}
		</div>
	);
}

/**
 * **第二下**(ADR-0017 决策 8)。点了那颗钮之后在行下面展开的一条 —— 不是模态框:
 * 一屏十几行,每行一个弹窗太重;但也不能点一下就发,误触的代价是群里多一条撤不回
 * 的消息。
 *
 * `failed` 行只给一个选项:那一行本来就全没到,「整行重发」与「只补没到的」在这儿是
 * 同一件事。条数是服务端按身份号算好交下来的,面板不自己算(自己算就是第二份实现)。
 */
function RepushBar({
	entry,
	counts,
	onClose,
}: {
	entry: HistoryEntryView;
	counts: { total: number; missing: number } | null;
	onClose: () => void;
}) {
	const repush = useMutation<HistoryRepushResponse, Error, "all" | "missing">({
		mutationFn: (mode) =>
			api.post<HistoryRepushResponse>(`/api/history/${entry.id}/repush`, { ts: entry.ts, mode }),
	});
	const n = (v: number | undefined) => (v === undefined ? "" : `（${v} 条）`);

	// 服务端回的是「收下了」,消息一条都还没发出去 —— 所以说「去补」不说「补好了」。
	// 真正的结果随后经 WS 一条条回来,这一行会自己变。
	if (repush.isSuccess) {
		return (
			<div className="flex items-center gap-2 border-t border-bn-border-subtle bg-bn-surface-muted/50 px-4 py-2 pl-38 text-bn-xs text-bn-text-secondary">
				<span>女仆去补{n(repush.data.count)}啦，好了这一行会自己更新～ (｡･ω･｡)ﾉ</span>
				<Btn size="sm" variant="ghost" onClick={onClose}>
					知道啦
				</Btn>
			</div>
		);
	}

	const busy = repush.isPending;
	return (
		<div className="border-t border-bn-border-subtle bg-bn-surface-muted/50 px-4 py-2 pl-38">
			<div className="flex flex-wrap items-center gap-2 text-bn-xs text-bn-text-secondary">
				<span>{busy ? "女仆这就去～" : "要女仆补哪些呀？"}</span>
				{entry.status === "failed" ? (
					<Btn size="sm" variant="primary" disabled={busy} onClick={() => repush.mutate("missing")}>
						重新推送{n(counts?.total)}
					</Btn>
				) : (
					<>
						<Btn
							size="sm"
							variant="primary"
							disabled={busy}
							onClick={() => repush.mutate("missing")}
						>
							只补没到的{n(counts?.missing)}
						</Btn>
						<Btn size="sm" variant="outline" disabled={busy} onClick={() => repush.mutate("all")}>
							整行重发{n(counts?.total)}
						</Btn>
					</>
				)}
				<Btn size="sm" variant="ghost" disabled={busy} onClick={onClose}>
					先不用了
				</Btn>
			</div>
			{repush.isError ? (
				<ErrorNote size="sm" className="mt-1.5">
					{repush.error.message}
				</ErrorNote>
			) : null}
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
				/>
			))}
		</ol>
	);
}

function MessageItem({ index, message }: { index: number; message: HistoryMessageView }) {
	// 没有结果 = 没发出去(无目标那行的每一条都是这样);有结果就跟整行状态同一份词表。
	const result =
		message.ok === undefined
			? { label: "未发送", tone: "var(--color-bn-inactive)" }
			: PUSH_STATUS_META[message.ok ? "delivered" : "failed"];
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
