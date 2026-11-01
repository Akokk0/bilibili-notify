import {
	displayNameOf,
	type ExtensionDTO,
	type SourceEntry,
	subscriptionIdentityLabel,
} from "@bilibili-notify/contract";
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
	FEATURE_DESCRIPTORS,
	familyTone,
	PUSH_STATUS_META,
	PUSH_TONE,
	type PushFamily,
} from "../config/push-features";
import { useExtensions } from "../hooks/useExtensions";
import { useCoreSettings } from "../hooks/useSettings";
import { useSources } from "../hooks/useSources";
import { i18n, useT } from "../i18n";
import { api } from "../services/api";
import {
	type HistoryEntryView,
	type HistoryMessageView,
	type HistoryRepushResponse,
	type HistoryResponse,
	historyQueryKey,
} from "../services/dashboard";
import type { PushTarget, Subscription } from "../types/domain";
import { imageUrl } from "../utils/image-url";
import { hasDetails, headlineOf, messageCountOf } from "../utils/push-row";
import { historyRowAvatarUrl, historyRowColor } from "../utils/up-display";
import { displayName } from "./up/helpers";
import { RelativeTime } from "./up/relative-time";
import { createSubscriptionLookup, type SubscriptionLookup } from "./up/subscription-lookup";
import { subscriptionPlatformOf } from "./up/subscription-source";

/**
 * `/history` — 1:1 port of `.bn-design/variation-a-tabs.jsx#HistoryTab`,
 * backed by the live `/api/history` route + jsonl-by-day store.
 *
 * 一行 = 一次推送 × 一个目标:首条本体当文案,多条挂「N 条」胶囊,行可展开逐条看
 * (文案 / 图缩略 / 结果);状态四态。八把特性键折进四个家族筛选(直播 / 动态 /
 * SC / 舰长),与 `services/dashboard.ts` 同吃 `FEATURE_DESCRIPTORS` 的 family,和概览趋势图对得上。
 *
 * The "重发" column from the design source is intentionally not ported:
 * POST /api/targets/:id/test sends a dummy text payload, so a button labelled
 * "重发" would mislead users into thinking the original message goes
 * back out. That route lands when the server gains a re-deliver path
 * that replays a recorded NotificationPayload.
 */

/** 筛选胶囊 = 四个家族(见 FEATURE_DESCRIPTORS 的 family)加一个「全部」。 */
type FilterId = "all" | PushFamily;

const filtersOf = (): ReadonlyArray<{ id: FilterId; label: string; tone: string }> => [
	{ id: "all", label: i18n.t("subs.tags.all"), tone: "var(--color-bn-inactive)" },
	{ id: "live", label: i18n.t("extension.reportDiscrepancies.kindLive"), tone: PUSH_TONE.live },
	{ id: "post", label: i18n.t("sourceUi.pages.Dashboard.TrendPanel.3"), tone: PUSH_TONE.post },
	{ id: "superchat", label: "SC", tone: PUSH_TONE.superchat },
	{
		id: "membership",
		label: i18n.t("sourceUi.pages.Dashboard.TrendPanel.4"),
		tone: PUSH_TONE.membership,
	},
];

export default function History() {
	const tx = useT();
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
		queryFn: () => api.get<Subscription[]>("/api/subscriptions"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const globalsQuery = useCoreSettings();
	const retentionDays = globalsQuery.data?.history.retentionDays;
	// 拓展行的平台徽章照来源表里的描述符画(取自已装拓展的清单,ADR-0019 决策 9)。读不到就当没回来,徽章退拓展 id。
	const extensionsQuery = useExtensions({ retry: false });
	const sources = useSources().data?.sources;

	// 行先按 `subscriptionId` 对订阅,不在了再按身份找(B 站行按 uid、拓展行按拓展 id + 外部 id,
	// ADR-0019 决策 50 / 73,与服务端重推同一条规矩)—— 删了又重加的 UP,旧行照样按现在那条的名字
	// 搜得到;同一个 UP 的几条订阅各认各的行。
	const subs = useMemo(() => createSubscriptionLookup(subsQuery.data ?? []), [subsQuery.data]);
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
			const sub = subs.forRow(e);
			m.set(
				e.id,
				[
					e.identity.externalId,
					sub ? displayName(sub, subscriptionPlatformOf(sub.identity, sources)) : "",
					e.targetId ? (targetById.get(e.targetId)?.name ?? "") : "",
					...e.messages.map((x) => x.text ?? ""),
				]
					.join("\n")
					.toLowerCase(),
			);
		}
		return m;
	}, [entries, subs, targetById, sources]);

	const filtered = useMemo(() => {
		const ql = q.trim().toLowerCase();
		return entries.filter((e) => {
			if (filterId !== "all" && FEATURE_DESCRIPTORS[e.feature].family !== filterId) return false;
			return !ql || (haystacks.get(e.id)?.includes(ql) ?? false);
		});
	}, [entries, filterId, q, haystacks]);

	return (
		<div className="bn-anim-page-in space-y-3.5">
			<div className="flex flex-wrap items-center gap-2.5">
				<Input
					value={q}
					onChange={setQ}
					placeholder={tx("sourceUi.pages.History.placeholder.1")}
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
					options={filtersOf().map((f) => ({ value: f.id, label: f.label, color: f.tone }))}
				/>
				<div className="flex-1" />
				<span className="text-bn-xs text-bn-text-tertiary">
					{tx("sourceUi.pages.History.History.2")}
					{filtered.length}
					{tx("sourceUi.components.toast.shell.ToastCard.2")}
					{retentionDays != null
						? tx("sourceUi.pages.History.History.3", { value1: retentionDays })
						: ""}
				</span>
			</div>

			{historyQuery.isLoading ? (
				<LoadingBlock
					label={tx("sourceUi.pages.History.label.4")}
					hint={tx("sourceUi.pages.History.hint.5")}
				/>
			) : historyQuery.error ? (
				<ErrorNote>
					{tx("sourceUi.pages.History.History.6")}
					{String((historyQuery.error as Error).message)}
				</ErrorNote>
			) : (
				<HistoryTable
					entries={filtered}
					subs={subs}
					targetById={targetById}
					sources={sources}
					extensions={extensionsQuery.data?.extensions}
				/>
			)}
		</div>
	);
}

function HistoryTable({
	entries,
	subs,
	targetById,
	sources,
	extensions,
}: {
	entries: HistoryEntryView[];
	subs: SubscriptionLookup;
	targetById: Map<string, PushTarget>;
	sources: readonly SourceEntry[] | undefined;
	extensions: readonly ExtensionDTO[] | undefined;
}) {
	const tx = useT();
	return (
		<div className="bn-glass overflow-hidden rounded-bn-sm shadow-bn-card">
			<div
				className="grid items-center gap-2.5 border-b border-bn-border-subtle bg-bn-surface-muted/70 px-4 py-2.5 text-bn-xs font-bold tracking-wide text-bn-text-tertiary"
				style={{ gridTemplateColumns: HISTORY_GRID }}
			>
				<span>{tx("sourceUi.pages.History.HistoryTable.7")}</span>
				<span></span>
				<span>{tx("sourceUi.pages.History.HistoryTable.8")}</span>
				<span>{tx("sourceUi.pages.History.HistoryTable.9")}</span>
				<span>{tx("stats.push.target")}</span>
				<span>{tx("sourceUi.pages.History.HistoryTable.10")}</span>
			</div>

			{entries.length === 0 ? (
				<div className="px-4 py-10 text-center text-bn-sm text-bn-text-tertiary">
					{tx("sourceUi.pages.History.HistoryTable.11")}
				</div>
			) : (
				entries.map((e, i) => (
					<HistoryRow
						key={e.id}
						entry={e}
						sub={subs.forRow(e)}
						target={e.targetId ? targetById.get(e.targetId) : undefined}
						sources={sources}
						extensions={extensions}
						isLast={i === entries.length - 1}
					/>
				))
			)}
		</div>
	);
}

const HISTORY_GRID = "100px 28px 64px 1fr 200px 100px";

/**
 * 被过滤的作品是被哪一类规则挡下的(行上的 `filteredBy`),展开后写在那条消息的结果位置上。
 * 前五种是屏蔽规则命中,最后一种是设了白名单而没命中。
 */
const filterReasonLabelOf = (): Record<NonNullable<HistoryEntryView["filteredBy"]>, string> => ({
	"blocked-keyword": i18n.t("sourceUi.pages.History.blockedkeyword.12"),
	"blocked-reposts": i18n.t("sourceUi.pages.History.blockedreposts.13"),
	"blocked-articles": i18n.t("sourceUi.pages.History.blockedarticles.14"),
	"blocked-images": i18n.t("sourceUi.pages.History.blockedimages.15"),
	"blocked-videos": i18n.t("sourceUi.pages.History.blockedvideos.16"),
	"allowlist-unmatched": i18n.t("sourceUi.pages.History.allowlistunmatched.17"),
});

/** 目标列:没有目标的行(无目标行、被过滤的行)写「—」;目标事后被删写「已删除目标」。 */
function targetLabelOf(entry: HistoryEntryView, target: PushTarget | undefined): string {
	if (entry.targetId === null) return "—";
	return target?.name ?? i18n.t("sourceUi.pages.History.targetLabelOf.18");
}

function HistoryRow({
	entry,
	sub,
	target,
	sources,
	extensions: _extensions,
	isLast,
}: {
	entry: HistoryEntryView;
	sub: Subscription | undefined;
	target: PushTarget | undefined;
	sources: readonly SourceEntry[] | undefined;
	extensions: readonly ExtensionDTO[] | undefined;
	isLast: boolean;
}) {
	const tx = useT();
	const [open, setOpen] = useState(false);
	const [repushOpen, setRepushOpen] = useState(false);
	const tone = familyTone(entry.feature);
	const status = PUSH_STATUS_META[entry.status];
	// 优先 entry 写入期的 snapshot,订阅事后被删也能稳定显示。都没有就写身份的外部 id:B 站行就是
	// uid(ADR-0019 决策 73)。
	const upName = displayNameOf(
		{ eventName: entry.nameSnapshot, profileName: sub?.cachedProfile?.name },
		subscriptionIdentityLabel(entry.identity, subscriptionPlatformOf(entry.identity, sources)),
	);
	// 头像快照是图库引用(只有拓展行有);没有快照 / 过了保留期就退到订阅现在的头像,再没有就是默认占位。
	const upAvatar = historyRowAvatarUrl(entry, sub?.cachedProfile);
	// 颜色跟着人走,与订阅卡同一个颜色(决策 73)。
	const creatorColor = historyRowColor(entry);
	// 拓展行带一枚平台徽章(决策 9:订阅删了也看得出是哪个平台的),画法同首页「正在直播」;B 站行不画。
	const platform = subscriptionPlatformOf(entry.identity, sources);
	const headline = headlineOf(entry);
	const count = messageCountOf(entry);
	const expandable = hasDetails(entry);
	const targetLabel = targetLabelOf(entry, target);
	// 画不画按钮**只看这一行带没带 `repush`**(ADR-0017 决策 6):服务端给「有目标、且行里还有没送到的
	// 或被挡下的消息」的行带这一格,REST 与 WS 来的都带。不看行的状态 —— 本体补完、附加项还没发的行
	// 状态已是「已送达」,可它还得能补;面板也不自己数消息(那是第二份实现)。
	const repush = entry.repush;
	// 不能补时按钮灰掉**并写上原因**,不是藏起来(决策 9)。
	const repushBlocked = repush && !repush.can ? repush.message : null;
	const repushCounts = repush?.can ? repush : null;

	return (
		<div className={isLast ? "" : "border-b border-bn-border-subtle"}>
			<div
				className="grid items-center gap-2.5 px-4 py-3 text-bn-sm"
				style={{ gridTemplateColumns: HISTORY_GRID }}
			>
				<span className="tabular-nums text-bn-xs text-bn-text-tertiary">
					<RelativeTime at={entry.createdAt} />
				</span>
				<Avatar name={upName} color={creatorColor} size={24} url={upAvatar} />
				<Pill color={tone} subtle size="sm">
					{FEATURE_DESCRIPTORS[entry.feature].label}
				</Pill>
				<div className="flex min-w-0 items-center gap-2">
					{platform.showBadge ? (
						<Pill size="sm" subtle color={platform.color ?? "var(--color-bn-inactive)"}>
							{platform.shortLabel ?? platform.label}
						</Pill>
					) : null}
					<div className="min-w-0 flex-1 truncate" title={headline}>
						<span className="font-bold text-bn-text-primary">{upName}</span>
						{headline ? (
							<span className="ml-1.5 text-bn-text-secondary">{headline}</span>
						) : (
							<span className="ml-1.5 text-bn-text-tertiary">
								{tx("sourceUi.pages.History.HistoryRow.19")}
							</span>
						)}
					</div>
					{expandable ? (
						// 多条时写条数,单条(带图 / 带错)写「详情」。
						<DisclosurePill
							open={open}
							onToggle={() => setOpen((v) => !v)}
							color={tone}
							title={
								open ? tx("sourceUi.pages.History.title.20") : tx("sourceUi.pages.History.title.21")
							}
							className="shrink-0 text-bn-2xs leading-4"
						>
							<span>
								{count > 1
									? tx("sourceUi.pages.History.HistoryRow.22", { value1: count })
									: tx("sourceUi.pages.History.HistoryRow.23")}
							</span>
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
					{repush ? (
						<IconButton
							size="sm"
							icon={<Icon.refresh size={12} />}
							label={tx("sourceUi.pages.History.label.24")}
							title={repushBlocked ?? tx("sourceUi.pages.History.title.25")}
							disabled={repushBlocked !== null}
							ariaExpanded={repushOpen}
							onClick={() => setRepushOpen((v) => !v)}
						/>
					) : null}
				</div>
			</div>
			{repushOpen && repushCounts ? (
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
 * 给几个选项照决策 8 按行的状态分(画不画按钮不看状态,那是上面 `repush` 的事):`partial` 行给
 * 「只补没到的」「整行重发」两个;别的行只给一颗、发的是 `missing` —— `failed` 行叫「重新推送」,
 * 被挡下的行与「状态已送达、可还有没发的」行叫「补发」。条数是服务端按身份号算好交下来的,
 * 面板不自己算(自己算就是第二份实现)。
 */
function RepushBar({
	entry,
	counts,
	onClose,
}: {
	entry: HistoryEntryView;
	counts: { total: number; missing: number };
	onClose: () => void;
}) {
	const tx = useT();
	const repush = useMutation<{ count: number }, Error, "all" | "missing">({
		mutationFn: async (mode) => {
			const res = await api.post<HistoryRepushResponse>(`/api/history/${entry.id}/repush`, {
				createdAt: entry.createdAt,
				mode,
			});
			// 拒了(没这一行 / 现在补不了 / 请求不成形)是非 2xx,由 `api` 抛成 `ApiError`、
			// `message` 就是服务端的原话;走到这儿的只可能是 202。
			return { count: res.count };
		},
	});
	const n = (v: number) => tx("sourceUi.pages.History.RepushBar.26", { value1: v });
	// 服务端回的是「收下了」,消息一条都还没发出去 —— 所以说「去补」不说「补好了」。
	// 真正的结果随后经 WS 一条条回来,这一行会自己变。
	if (repush.isSuccess) {
		return (
			<div className="flex items-center gap-2 border-t border-bn-border-subtle bg-bn-surface-muted/50 px-4 py-2 pl-38 text-bn-xs text-bn-text-secondary">
				<span>
					{tx("sourceUi.pages.History.RepushBar.27")}
					{repush.data.count}
					{tx("sourceUi.pages.History.RepushBar.28")}
				</span>
				<Btn size="sm" variant="ghost" onClick={onClose}>
					{tx("sourceUi.pages.History.RepushBar.29")}
				</Btn>
			</div>
		);
	}

	const busy = repush.isPending;
	return (
		<div className="border-t border-bn-border-subtle bg-bn-surface-muted/50 px-4 py-2 pl-38">
			<div className="flex flex-wrap items-center gap-2 text-bn-xs text-bn-text-secondary">
				<span>
					{busy
						? tx("sourceUi.pages.History.RepushBar.30")
						: tx("sourceUi.pages.History.RepushBar.31")}
				</span>
				{entry.status === "partial" ? (
					<>
						<Btn
							size="sm"
							variant="primary"
							disabled={busy}
							onClick={() => repush.mutate("missing")}
						>
							{tx("sourceUi.pages.History.RepushBar.32")}
							{n(counts.missing)}
						</Btn>
						<Btn size="sm" variant="outline" disabled={busy} onClick={() => repush.mutate("all")}>
							{tx("sourceUi.pages.History.RepushBar.33")}
							{n(counts.total)}
						</Btn>
					</>
				) : (
					// 只一颗,发的是 `missing`,印的数也是 missing。`failed` 判的是**本体那一号**没 ok,
					// 不是全没到:@全体先落地且成功、本体失败的行就是 failed(total=2、missing=1)。给它
					// 「整行重发」会把已经到了的 @全体再发一遍,群里多 @ 一次全体,撤不回 —— 所以不给。
					// 被挡下的行、状态已送达可还有附加项没发的行同理:只补还没发的那几条。
					<Btn size="sm" variant="primary" disabled={busy} onClick={() => repush.mutate("missing")}>
						{entry.status === "failed"
							? tx("sourceUi.pages.History.RepushBar.34")
							: tx("sourceUi.pages.History.RepushBar.35")}
						{n(counts.missing)}
					</Btn>
				)}
				<Btn size="sm" variant="ghost" disabled={busy} onClick={onClose}>
					{tx("sourceUi.pages.History.RepushBar.36")}
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

/**
 * 展开后的逐条明细:序号 / 本体还是附加项 / 文案 / 图缩略 / 这条的结果。
 *
 * **号不是数组下标,是 `repushOf ?? 下标`**(ADR-0017 决策 15 与「后果」那一节)。重推
 * 是追加进原行的(决策 14),3 条的行补过之后展开是 6 条 —— 按位置印 1..6 的话,后三条
 * 看上去就是三条凭空多出来的新消息,既看不出是谁的重投,也看不出前三条已经作废。
 * 印它补的**那一号**、再标一句「女仆补的」,那份可追溯才落到界面上;`repushOf` 就是
 * 这个标记的来源,不另开第二个字段。
 *
 * ⚠️ 「每一号只认它**最后那次**尝试」的判定**只在服务端有一份**(决策 16),面板不重做
 * 一遍。「这条被顶掉了」用的是本地就看得见的那件事:**后面还有一条补这一号的**。
 */
function MessageList({ entry }: { entry: HistoryEntryView }) {
	return (
		<ol className="space-y-1.5 border-t border-bn-border-subtle bg-bn-surface-muted/50 px-4 py-2.5 pl-38">
			{entry.messages.map((m, i) => {
				const no = m.repushOf ?? i;
				return (
					<MessageItem
						// biome-ignore lint/suspicious/noArrayIndexKey: 行内消息按序追加、从不重排删除,位置就是它在这一行里的身份
						key={`${entry.id}-${i}`}
						no={no}
						message={m}
						superseded={entry.messages.some((o, j) => j > i && o.repushOf === no)}
						pastRetention={entry.isPastRetention === true}
						filteredBy={entry.filteredBy}
					/>
				);
			})}
		</ol>
	);
}

/**
 * `no` = 这条顶的是哪一号(从 0 数,印出来 +1);`superseded` = 后面还有一条补这一号的,
 * 也就是这条已经作废了 —— 压暗它,让「这条没成、下面那条是它的重投」一眼看得出来。
 * `pastRetention` = 这一行过了保留期,图已经清掉:原来画图的位置写「图已清理」,不去请求那张不在了的图。
 * `filteredBy` = 这一行是被过滤的作品留的痕:那条消息没发、也不是「未发送」,结果位置写它被哪一类规则挡的。
 */
function MessageItem({
	no,
	message,
	superseded,
	pastRetention,
	filteredBy,
}: {
	no: number;
	message: HistoryMessageView;
	superseded: boolean;
	pastRetention: boolean;
	filteredBy: HistoryEntryView["filteredBy"];
}) {
	const tx = useT();
	// 本来有图:是图消息,或者带着图库引用。过了保留期的老行迁移时图格被拿掉了,只剩 `kind: "image"`(composite 拿掉后看不出,
	// 只画文字)。
	const hadImage = message.kind === "image" || message.image !== undefined;
	// 没有结果 = 没发出去(无目标那行的每一条都是这样),其中被静音 / 免扰挡下的、被过滤的各自单说;
	// 有结果就跟整行状态同一份词表。
	const result =
		message.ok === undefined
			? message.isSilenced
				? PUSH_STATUS_META.silenced
				: filteredBy !== undefined
					? { label: filterReasonLabelOf()[filteredBy], tone: PUSH_STATUS_META.filtered.tone }
					: { label: tx("sourceUi.pages.History.label.37"), tone: "var(--color-bn-inactive)" }
			: PUSH_STATUS_META[message.ok ? "delivered" : "failed"];
	return (
		<li className={`flex items-start gap-2.5 text-bn-xs${superseded ? " opacity-60" : ""}`}>
			<span className="w-4 shrink-0 tabular-nums text-bn-text-tertiary">{no + 1}</span>
			<span className="w-10 shrink-0 text-bn-text-tertiary">
				{message.role === "main"
					? tx("sourceUi.pages.History.MessageItem.38")
					: tx("sourceUi.pages.History.MessageItem.39")}
			</span>
			{hadImage && pastRetention ? (
				<span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-bn-surface-muted text-center leading-tight text-bn-text-tertiary">
					{tx("sourceUi.pages.History.MessageItem.40")}
				</span>
			) : message.image ? (
				<img
					src={imageUrl(message.image)}
					alt={message.text ?? tx("sourceUi.pages.History.alt.41")}
					className="h-12 w-12 shrink-0 rounded-md object-cover"
					loading="lazy"
				/>
			) : null}
			<span className="min-w-0 flex-1 break-words text-bn-text-secondary">
				{message.text ?? (
					<span className="text-bn-text-tertiary">
						{tx("sourceUi.pages.History.HistoryRow.19")}
					</span>
				)}
				{message.ok === false && message.message ? (
					<span className="ml-1.5 text-bn-danger">{message.message}</span>
				) : null}
				{superseded ? (
					<span className="ml-1.5 text-bn-text-tertiary">
						{tx("sourceUi.pages.History.MessageItem.42")}
					</span>
				) : null}
			</span>
			{message.repushOf !== undefined ? (
				// 这一条是女仆补的那次,不是当时发出去的那次。
				<Pill subtle size="sm">
					{tx("sourceUi.pages.History.MessageItem.43")}
				</Pill>
			) : null}
			<Pill color={result.tone} subtle size="sm">
				{result.label}
			</Pill>
		</li>
	);
}
