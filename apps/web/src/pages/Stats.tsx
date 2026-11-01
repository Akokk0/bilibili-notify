import {
	type ExtensionDTO,
	type SourceEntry,
	type SubscriptionDTO,
	sourceNounsOf,
} from "@bilibili-notify/contract";
import { type FormatCountOptions, formatAgo, formatCount } from "@bilibili-notify/internal/format";
import {
	Avatar,
	Btn,
	Donut,
	ErrorNote,
	GlassPanel,
	GlassStatCard,
	HintNote,
	Icon,
	LoadingBlock,
	MenuItem,
	Pill,
	PopoverShell,
} from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useExtensions } from "../hooks/useExtensions";
import { useSources } from "../hooks/useSources";
import { i18n, useT } from "../i18n";
import { api } from "../services/api";
import {
	activityLevel,
	computeTotals,
	coveredActivityTotal,
	coveredDayCount,
	cumulativeFans,
	dayAxis,
	fansKnownCount,
	localTzOffset,
	plainPostCount,
	type StatsOverviewResponse,
	sparseLabels,
	statsQueryKey,
	type UpStatsRow,
} from "../services/stats";
import { identityColor, type Subscription } from "../types/domain";
import { historyRowIdentity } from "../utils/up-display";
import type { SignTone } from "./stats/chart-utils";
import { dash, signTone } from "./stats/chart-utils";
import {
	ChartEmpty,
	DeltaTag,
	Heatmap,
	NetBars,
	RadarChart,
	ResponsiveChart,
	Sparkline,
	TrendChart,
} from "./stats/charts";
import { buildStatColumns, type StatColumnId, VIEWERS_HINT } from "./stats/columns";
import { buildCsv } from "./stats/csv";
import { netFromCumulative, sumNetPoints } from "./stats/gaps";
import { RoastCard } from "./stats/RoastCard";
import { RoastScheduleBox } from "./stats/RoastScheduleBox";
import { buildRadarAxes } from "./stats/radar";
import { STATS_RANGES } from "./stats/ranges";
import { SoloRoastCard } from "./stats/SoloRoastCard";
import { SoloRoastScheduleBox } from "./stats/SoloRoastScheduleBox";
import { displayName, profileAvatarUrl } from "./up/helpers";
import { createSubscriptionLookup } from "./up/subscription-lookup";
import { subscriptionPlatformOf } from "./up/subscription-source";

/**
 * 面板 / KPI 卡的主题色 —— 走 token,跟皮肤换装。
 *
 * 这里曾经写着「**必须是十六进制字面量**」,理由是 GlassPanel / GlassStatCard
 * 拼 alpha 后缀(`${color}1a`),拼上 CSS 变量会得到 `var(--color-bn-pink)1a`
 * 这种非法值、被浏览器静默丢弃。那两个组件现在用 `color-mix()` 造透明度,
 * 限制没了 —— 而它一直在的代价是:统计页的强调色被钉死在 B 站粉/蓝/紫上,
 * 装了别的皮肤,整站都换了,只有这几张卡还是原来的配色。
 */
const PINK = "var(--color-bn-pink)";
const BLUE = "var(--color-bn-blue)";
const PURPLE = "var(--color-bn-purple)";
/**
 * KPI 行的补充色相。品牌三色(粉/蓝/紫)在色轮上挨得太近,五张卡排一行时
 * 几乎糊成一片,分不出哪张讲的是哪件事。青与琥珀把色相拉开到另外两个象限,
 * 明暗两套主题下都还压得住 —— 卡片底色是半透明玻璃,饱和度不能再低了。
 */
const TEAL = "#00d1b2";
const AMBER = "#ffa726";
const GREEN = "var(--color-bn-success-text)";
const RED = "var(--color-bn-danger-text)";
/** 净增语气 → 颜色。`unknown` 走中性灰,绝不能借用绿色去表示「没有数据」。 */
const NET_TONE_COLOR: Record<SignTone, string> = {
	positive: GREEN,
	negative: RED,
	unknown: "var(--color-bn-text-secondary)",
};

/** 数值展示统一走这里:`null` 一律显示破折号,绝不用 0 顶替「没有记录」。 */
function num(v: number | null, opts?: FormatCountOptions): string {
	return v === null ? "—" : formatCount(v, { ...opts, compact: true });
}

function hours(h: number): string {
	return h >= 10 ? String(Math.round(h)) : h.toFixed(1).replace(/\.0$/, "");
}

/**
 * 一行统计在页面上「是谁」(ADR-0020 决策 1 / 3)。行以订阅 id 为键,这些都从它对上的订阅与行上带的身份来。
 */
interface UpMeta {
	/** 名字:订阅卡那条链(`displayName`:资料里的名字 → B 站「UID xxx」/ 拓展的别名 → 外部 id)。 */
	name: string;
	/** 跟着人走的颜色(`identityColor`):与订阅卡、历史页同一个颜色。 */
	color: string;
	/** 头像:B 站是 CDN 链接,拓展是同源相对地址。缺省时 Avatar 退回首字母块 —— 订阅刚建、资料还没到。 */
	avatar?: string;
	/**
	 * 单人页头「这是谁」那一小串:B 站「UID」+ uid(昵称会改、UID 不会,对着后台核对要的是它),拓展是平台名 +
	 * 外部 id(ADR-0020 决策 3,同历史页的 ADR-0019 决策 73)。
	 */
	identity: { label: string; id: string };
	/** 拓展行的平台(徽章与 CSV 的「平台」那一列);B 站行没有。平台名取不到(拓展卸载了)写拓展 id。 */
	platform?: { label: string; shortLabel?: string; color?: string };
}

/** 订阅列表还没回来(或对不上)时,也画得出一个认得出的人:B 站写 UID,拓展写外部 id。 */
function upMetaOf(
	r: UpStatsRow,
	sub: Subscription | undefined,
	sources: readonly SourceEntry[] | undefined,
	_extensions: readonly ExtensionDTO[] | undefined,
): UpMeta {
	const base = {
		color: identityColor(r.identity),
		avatar: profileAvatarUrl(sub?.cachedProfile),
	};
	const { externalId } = r.identity;
	const platform = subscriptionPlatformOf(r.identity, sources);
	return {
		...base,
		name: sub ? displayName(sub, platform) : historyRowIdentity(r, platform),
		identity: { label: platform.externalIdNoun?.trim() || platform.label, id: externalId },
		platform: platform.showBadge
			? { label: platform.label, shortLabel: platform.shortLabel, color: platform.color }
			: undefined,
	};
}

/** 拓展行名字旁边那枚平台徽章(同历史页、首页「正在直播」);B 站行不画。 */
function PlatformPill({ meta }: { meta: UpMeta }) {
	if (!meta.platform) return null;
	return (
		<Pill size="sm" subtle color={meta.platform.color ?? "var(--color-bn-inactive)"}>
			{meta.platform.shortLabel ?? meta.platform.label}
		</Pill>
	);
}

/**
 * 把当前对比表导出成 CSV。
 *
 * 列定义在 `stats/csv.ts` —— 表头与取值同源、有测试守着。这里只剩下载那几行:
 * 拼 BOM(否则 Excel 打开中文列名是乱码)、造 Blob、点一下虚拟链接。
 */
function exportCsv(
	rows: UpStatsRow[],
	metaOf: (r: UpStatsRow) => UpMeta,
	days: number,
	sources: readonly SourceEntry[] | undefined,
): void {
	const platforms = [...new Set(rows.map((row) => row.identity.sourceKey))].map((sourceKey) =>
		subscriptionPlatformOf({ sourceKey }, sources),
	);
	const nouns = sourceNounsOf(platforms, {
		creatorNoun: i18n.t("subs.new.creatorNoun"),
		postNoun: i18n.t("sourceUi.pages.Stats.postNoun.1"),
		sources: i18n.t("sourceUi.pages.Stats.sources.2"),
	});
	const csv = buildCsv(rows, days, {
		nameOf: (r) => metaOf(r).name,
		platformOf: (r) => subscriptionPlatformOf(r.identity, sources).label,
		creatorNoun: nouns.creatorNoun,
		identityNoun: platforms.length === 1 ? platforms[0]?.externalIdNoun?.trim() || "ID" : "ID",
	});
	const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `bilibili-notify-stats-${new Date().toISOString().slice(0, 10)}.csv`;
	a.click();
	URL.revokeObjectURL(url);
}

/** UP 选择器 —— 全部 / 单个 UP 的切换入口。值是订阅 id(行的键)。 */
function UpPicker({
	rows,
	metaOf,
	value,
	onChange,
}: {
	rows: UpStatsRow[];
	metaOf: (r: UpStatsRow) => UpMeta;
	value: string | null;
	onChange: (subscriptionId: string | null) => void;
}) {
	const tx = useT();
	const [open, setOpen] = useState(false);
	const curRow = value ? rows.find((r) => r.subscriptionId === value) : undefined;
	const cur = curRow ? metaOf(curRow) : undefined;
	return (
		<div className="relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				// 它与 TSelect 同语义:显示当前值、点开挑候选 —— 挂 input 不挂 btn,
				// 与库里下拉触发器的口径一致。
				data-bn="input"
				className="flex h-9 min-w-40 items-center gap-2 rounded-bn-card border border-bn-border bg-bn-surface px-2.5 text-left"
			>
				{/* 「全部 UP 主」不配头像 —— 汇总视图没有「一个人」可代表,
				    原来那颗粉蓝渐变圆只是个占位,反而像某位 UP 的头像。 */}
				{cur ? <Avatar name={cur.name} color={cur.color} size={22} url={cur.avatar} /> : null}
				<span className="text-bn-sm font-bold text-bn-text-primary">
					{cur?.name ?? tx("sourceUi.pages.Stats.UpPicker.3")}
				</span>
				<span className="ml-auto text-bn-sm text-bn-text-secondary">{open ? "▴" : "▾"}</span>
			</button>
			{open ? (
				<PopoverShell layer="overlay" className="max-h-80 min-w-56 overflow-y-auto">
					<MenuItem
						onClick={() => {
							onChange(null);
							setOpen(false);
						}}
					>
						<span className="text-bn-sm font-bold text-bn-text-primary">
							{tx("sourceUi.pages.Stats.UpPicker.3")}
						</span>
						<span className="ml-auto text-bn-sm text-bn-text-secondary">
							{tx("sourceUi.pages.Stats.UpPicker.4")}
						</span>
					</MenuItem>
					{rows.map((r) => {
						const m = metaOf(r);
						return (
							<MenuItem
								key={r.subscriptionId}
								ariaLabel={m.name}
								onClick={() => {
									onChange(r.subscriptionId);
									setOpen(false);
								}}
							>
								<Avatar
									name={m.name}
									color={m.color}
									size={26}
									url={m.avatar}
									status={r.live ? "living" : undefined}
								/>
								<span className="min-w-0 flex-1">
									<span className="flex min-w-0 items-center gap-1.5">
										<span className="truncate text-bn-sm font-bold text-bn-text-primary">
											{m.name}
										</span>
										<PlatformPill meta={m} />
									</span>
									<span className="block text-bn-2xs text-bn-text-secondary">
										{num(r.followers)} ·{" "}
										{(r.lastActivityAt ? formatAgo(r.lastActivityAt) : undefined) ??
											tx("sourceUi.pages.Stats.UpPicker.5")}
									</span>
								</span>
								<DeltaTag v={r.net7d} size={10.5} />
							</MenuItem>
						);
					})}
				</PopoverShell>
			) : null}
		</div>
	);
}

/** UP 对比表 —— 全局视图的主面板,点行进入单 UP 钻取(按订阅 id)。 */
function CompareTable({
	rows,
	metaOf,
	days,
	onPick,
}: {
	rows: UpStatsRow[];
	metaOf: (r: UpStatsRow) => UpMeta;
	days: number;
	onPick: (subscriptionId: string) => void;
}) {
	const tx = useT();
	const [sort, setSort] = useState<StatColumnId>("net7d");
	// 表头与单元格都从这一个数组出 —— 曾经它们是两份手写的平行名单,插一列就
	// 会整体错位(详见 columns.ts 的说明)。
	const cols = useMemo(
		() => buildStatColumns(days, { blue: BLUE, pink: PINK, purple: PURPLE }, { hours, num }),
		[days],
	);
	const sorted = useMemo(() => {
		const pick = cols.find((c) => c.id === sort)?.value;
		return [...rows].sort((a, b) => {
			// null 恒排在后面 —— 没有记录的 UP 不该因为「视作 0」而挤进榜首。
			const an = pick?.(a) ?? null;
			const bn = pick?.(b) ?? null;
			return (bn ?? Number.NEGATIVE_INFINITY) - (an ?? Number.NEGATIVE_INFINITY);
		});
	}, [rows, sort, cols]);

	if (!rows.length) return <ChartEmpty hint={tx("sourceUi.pages.Stats.hint.6")} />;

	return (
		<div className="overflow-x-auto">
			<table className="w-full border-collapse text-bn-sm">
				<thead>
					<tr className="border-b border-bn-border">
						<th className="px-2.5 py-2 text-left text-bn-xs font-bold text-bn-text-secondary">
							{tx("sourceUi.pages.Stats.CompareTable.7")}
						</th>
						<th className="px-2.5 py-2 text-right text-bn-xs font-bold text-bn-text-secondary">
							{tx("sourceUi.pages.Stats.CompareTable.8")}
						</th>
						<th className="px-2.5 py-2 text-center text-bn-xs font-bold text-bn-text-secondary">
							{tx("sourceUi.pages.Stats.CompareTable.9")}
						</th>
						{cols.map((c) => (
							<th
								key={c.id}
								className="whitespace-nowrap px-2.5 py-2 text-right text-bn-xs font-bold"
								style={{ color: sort === c.id ? PINK : "var(--color-bn-text-secondary)" }}
							>
								<button type="button" onClick={() => setSort(c.id)} title={c.hint}>
									{c.label}
									{sort === c.id ? " ▾" : ""}
								</button>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{sorted.map((r) => {
						const m = metaOf(r);
						const color = m.color;
						return (
							<tr
								key={r.subscriptionId}
								onClick={() => onPick(r.subscriptionId)}
								className="cursor-pointer border-b border-bn-border-subtle hover:bg-bn-hover-muted"
							>
								<td className="px-2.5 py-2">
									<div className="flex items-center gap-2">
										<Avatar
											name={m.name}
											color={color}
											size={28}
											url={m.avatar}
											status={r.live ? "living" : undefined}
										/>
										<div className="min-w-0">
											<div className="flex min-w-0 items-center gap-1.5">
												<span className="truncate text-bn-sm font-bold text-bn-text-primary">
													{m.name}
												</span>
												<PlatformPill meta={m} />
											</div>
											<div className="text-bn-2xs text-bn-text-secondary">
												{(r.lastActivityAt ? formatAgo(r.lastActivityAt) : undefined) ??
													tx("sourceUi.pages.Stats.UpPicker.5")}
												{r.live ? tx("sourceUi.pages.Stats.CompareTable.10") : ""}
											</div>
										</div>
									</div>
								</td>
								<td className="px-2.5 py-2 text-right tabular-nums font-bold text-bn-text-primary">
									{num(r.followers)}
								</td>
								<td className="px-2.5 py-2 text-center">
									<div className="inline-block">
										<Sparkline data={r.series.slice(-14)} color={color} width={72} height={22} />
									</div>
								</td>
								{cols.map((c) =>
									c.kind === "delta" ? (
										<td key={c.id} className="px-2.5 py-2 text-right">
											<DeltaTag v={c.value(r)} size={11.5} />
										</td>
									) : (
										<td
											key={c.id}
											className={`px-2.5 py-2 text-right tabular-nums font-bold${
												c.color ? "" : " text-bn-text-tertiary"
											}`}
											style={c.color ? { color: c.color } : undefined}
										>
											{c.format?.(c.value(r)) ?? num(c.value(r))}
										</td>
									),
								)}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

/** 内容构成 —— 动态 / 投稿 / 直播 的占比。 */
function ContentMix({
	plainPosts,
	videoPosts,
	lives,
	days,
	coveredDays,
	coveredTotal,
}: {
	/** 动态数 = 全部作品减去带视频的(`plainPostCount` 算的,这里只管画)。 */
	plainPosts: number | null;
	videoPosts: number | null;
	lives: number | null;
	days: number;
	/**
	 * 窗口内**有采集覆盖**的天数 —— 日均的分母。不能用 `days`:分子只统计得到
	 * 我们在记的那些天,分母却把没在记的也算进去,日均会被摊薄成一个假的小数。
	 */
	coveredDays: number;
	/**
	 * 有覆盖那些天的活动合计 —— 「日均活动」的分子,与 `coveredDays` 同一把尺子。
	 * 上面那个 `total` 是**窗口合计**、没被覆盖遮罩过,拿它当分子会把日均抬高几十倍。
	 */
	coveredTotal: number;
}) {
	const tx = useT();
	// 「没在记」与「在记但没动静」是两回事,空态文案也得分开 —— 否则老库升级后
	// 点开近 90 日,会看到一句「还没有发过任何内容」扣在一位高产 UP 头上。
	if (plainPosts === null && videoPosts === null && lives === null) {
		return <ChartEmpty hint={tx("sourceUi.pages.Stats.hint.11")} />;
	}
	// 走到这里至少有一项有记录。剩下的 null 是「这一类没记到」,并进 0 参与占比 ——
	// 分类占比图上没有「未知的那一块」可画,但整体「没在记」的情形已在上面拦掉了。
	const dyn = plainPosts ?? 0;
	const arc = videoPosts ?? 0;
	const liv = lives ?? 0;
	const total = dyn + arc + liv;
	if (total === 0) return <ChartEmpty hint={tx("sourceUi.pages.Stats.hint.12")} />;
	const parts: Array<[string, number, string]> = [
		[tx("sourceUi.pages.Stats.plainPosts"), dyn, PURPLE],
		[tx("sourceUi.pages.Stats.ContentMix.13"), arc, BLUE],
		[tx("extension.reportDiscrepancies.kindLive"), liv, PINK],
	];
	return (
		<div className="flex h-full flex-col justify-center gap-4">
			<div className="flex items-center justify-center gap-5">
				<Donut
					value={dyn / total}
					size={104}
					color={PURPLE}
					label={
						<div className="text-center">
							<div className="text-bn-xl font-bold text-bn-text-primary">{total}</div>
							<div className="text-bn-micro text-bn-text-secondary">
								{tx("sourceUi.pages.Stats.label.14")}
							</div>
						</div>
					}
				/>
				<div className="flex flex-col gap-1">
					<div className="text-bn-xs text-bn-text-secondary">
						{tx("sourceUi.pages.Stats.ContentMix.15")}
					</div>
					<div className="tabular-nums text-bn-xl font-bold leading-none" style={{ color: PURPLE }}>
						{coveredDays > 0 ? (coveredTotal / coveredDays).toFixed(1) : "—"}
					</div>
					<div className="text-bn-2xs text-bn-text-secondary">
						{tx("sourceUi.pages.Stats.ContentMix.16")}
						{coveredDays < days
							? tx("sourceUi.pages.Stats.ContentMix.17", { value1: coveredDays })
							: tx("sourceUi.pages.Stats.ContentMix.18", { value1: days })}
					</div>
				</div>
			</div>
			<div className="flex flex-col gap-2.5">
				{parts.map(([label, v, c]) => (
					<div key={label} className="flex items-center gap-2 text-bn-sm">
						<span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: c }} />
						<span className="w-8 shrink-0 text-bn-text-tertiary">{label}</span>
						<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bn-code-bg">
							<div
								className="h-full rounded-full"
								style={{ width: `${(v / total) * 100}%`, background: c }}
							/>
						</div>
						<b className="w-6 text-right tabular-nums text-bn-text-primary">{v}</b>
						<span className="w-9 text-right tabular-nums text-bn-text-secondary">
							{Math.round((v / total) * 100)}%
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

export default function Stats() {
	const tx = useT();
	const [days, setDays] = useState<number>(30);
	const [picked, setPicked] = useState<string | null>(null);

	const statsQuery = useQuery({
		queryKey: statsQueryKey(days),
		queryFn: () =>
			api.get<StatsOverviewResponse>(`/api/stats/overview?days=${days}&tz=${localTzOffset()}`),
	});
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<SubscriptionDTO[]>("/api/subscriptions"),
	});
	// 拓展行的平台名与徽章照来源表里的描述符(取自装着的拓展清单);没回来时写拓展 id。
	const extensions = useExtensions({ retry: false }).data?.extensions;
	const sources = useSources().data?.sources;

	// 两支订阅都列(ADR-0020):行以**订阅 id** 为键,选中、聚焦、配色、名字都按它对 —— 外部 id 恰好等于某个
	// B 站 uid 时,按 uid 对就会把另一个平台上的另一个人认成那位 B 站 UP。
	const res = statsQuery.data;
	const rows = res?.rows ?? [];
	const meta = useMemo(() => {
		const lookup = createSubscriptionLookup(subsQuery.data ?? []);
		const m = new Map<string, UpMeta>();
		for (const r of statsQuery.data?.rows ?? []) {
			m.set(r.subscriptionId, upMetaOf(r, lookup.byId(r.subscriptionId), sources, extensions));
		}
		return m;
	}, [statsQuery.data, subsQuery.data, sources, extensions]);
	const metaOf = (r: UpStatsRow): UpMeta =>
		meta.get(r.subscriptionId) ?? upMetaOf(r, undefined, sources, extensions);
	const axis = useMemo(() => dayAxis(days), [days]);
	const xLabels = useMemo(() => sparseLabels(axis), [axis]);
	const totals = useMemo(() => (res ? computeTotals(res) : null), [res]);
	/** 「总粉丝量」只加得动有记录的那几位,少于订阅数时标签要如实说明。 */
	const fansKnown = fansKnownCount(rows);
	const focused = picked ? (rows.find((r) => r.subscriptionId === picked) ?? null) : null;
	const focusedMeta = focused ? metaOf(focused) : undefined;
	const focusColor = focusedMeta?.color ?? PINK;

	// 画像跟随顶部的时间范围。六根轴里只有「粉丝规模(当前)」不随窗口变 ——
	// 粉丝数是「此刻共有多少」,没有「近30日的粉丝规模」这回事;轴上并排标着
	// 原始值,切换范围时哪根动了哪根没动一目了然。
	const radarAxes = useMemo(
		() => (focused ? buildRadarAxes(focused, rows) : null),
		[focused, rows],
	);

	// 等待/失败态也走页面自己的 p-6 外框 —— 直接裸一行字坐在页面背景上,皮肤壁纸
	// 一开就是灰字飘在图上,而且切到正常态时整页会跳一下(内外边距对不上)。
	if (statsQuery.isLoading) {
		return (
			<div className="bn-anim-page-in p-6">
				<LoadingBlock
					label={tx("sourceUi.pages.Stats.label.19")}
					hint={tx("sourceUi.pages.Stats.hint.20")}
				/>
			</div>
		);
	}
	if (statsQuery.isError) {
		return (
			<div className="bn-anim-page-in p-6">
				<ErrorNote>{tx("sourceUi.pages.Stats.Stats.21")}</ErrorNote>
			</div>
		);
	}

	const heatRows = (focused ? [focused] : rows).map((r) => ({
		id: r.subscriptionId,
		name: metaOf(r).name,
		color: metaOf(r).color,
		cells: r.activity.map(activityLevel),
	}));

	return (
		<div className="bn-anim-page-in flex flex-col gap-3.5 p-6">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="flex items-center gap-3">
					{/* 单 UP 视图给一枚大头像 —— 钻进某个人之后,页头得先回答「现在看的是谁」。 */}
					{focused && focusedMeta ? (
						<Avatar
							name={focusedMeta.name}
							color={focusColor}
							size={44}
							url={focusedMeta.avatar}
							status={focused.live ? "living" : undefined}
						/>
					) : null}
					<div>
						<div className="text-bn-lg font-bold tracking-tight text-bn-text-primary">
							{focusedMeta ? focusedMeta.name : tx("sourceUi.pages.Stats.Stats.22")}
						</div>
						<div className="mt-1 text-bn-sm text-bn-text-secondary">
							{focusedMeta ? (
								// 名字已经在上面的标题里了,这行改说「这是谁」:B 站写 UID —— 昵称会改,UID 不会,
								// 主人对着后台核对时要的是这个;拓展写平台名 + 外部 id(ADR-0020 决策 3)。
								<>
									{focusedMeta.identity.label}{" "}
									<b style={{ color: focusColor }}>{focusedMeta.identity.id}</b>
									{tx("sourceUi.pages.Stats.Stats.23")}
								</>
							) : (
								<>
									{tx("sourceUi.pages.Stats.Stats.24")}
									<b style={{ color: PINK }}>{rows.length}</b>
									{tx("sourceUi.pages.Stats.Stats.25")}
								</>
							)}
						</div>
					</div>
				</div>
				<div className="flex items-center gap-2.5">
					<UpPicker rows={rows} metaOf={metaOf} value={picked} onChange={setPicked} />
					<div className="flex gap-1 rounded-bn-card border border-bn-border bg-bn-surface p-0.5">
						{STATS_RANGES.map((r) => (
							<button
								key={r.days}
								type="button"
								onClick={() => setDays(r.days)}
								data-bn={days === r.days ? "chip chip-active" : "chip"}
								className="rounded-md px-3 py-1.5 text-bn-sm font-semibold"
								style={{
									background: days === r.days ? "var(--color-bn-surface-muted)" : "transparent",
									color: days === r.days ? PINK : "var(--color-bn-text-tertiary)",
								}}
							>
								{r.label}
							</button>
						))}
					</div>
				</div>
			</div>

			{/* KPI 行 */}
			<div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
				{focused ? (
					<>
						<GlassStatCard
							label={tx("sourceUi.pages.Stats.label.26")}
							value={num(focused.followers)}
							color={focusColor}
							footer={
								<>
									<DeltaTag v={focused.net7d} size={11.5} />
									<span className="text-bn-2xs text-bn-text-secondary">
										{tx("sourceUi.pages.Stats.footer.27")}
									</span>
									<span className="ml-auto">
										<Sparkline
											data={focused.series.slice(-14)}
											color={focusColor}
											width={64}
											height={20}
										/>
									</span>
								</>
							}
						/>
						<GlassStatCard
							label={tx("sourceUi.pages.Stats.label.28")}
							value={num(focused.net1d, { signed: true })}
							color={TEAL}
							pulse
						/>
						<GlassStatCard
							label={tx("sourceUi.pages.Stats.label.29", { value1: days })}
							value={num(focused.netWindow, { signed: true })}
							color={PURPLE}
						/>
						<GlassStatCard
							label={tx("sourceUi.pages.Stats.ContentMix.13")}
							value={dash(focused.videoPosts)}
							suffix={tx("sourceUi.pages.Stats.suffix.30")}
							color={AMBER}
						/>
						{/* KPI 行收尾在蓝:呼应「左粉右蓝」的品牌轴。 */}
						<GlassStatCard
							label={tx("sourceUi.pages.Stats.label.31")}
							value={dash(focused.liveSessions)}
							suffix={tx("sourceUi.pages.Stats.suffix.32", {
								value1: dash(focused.liveHours, hours),
							})}
							color={BLUE}
						/>
					</>
				) : (
					<>
						<GlassStatCard
							// 部分 UP 还没采到样本时,这个数不是全站合计 —— 标签得说明白,
							// 否则「总粉丝量」会被读成所有订阅的和,而它少算了几位。
							label={
								fansKnown < rows.length
									? tx("sourceUi.pages.Stats.label.33", { value1: fansKnown, value2: rows.length })
									: tx("sourceUi.pages.Stats.label.34")
							}
							value={num(totals?.followers ?? null)}
							color={PINK}
							footer={
								<>
									<DeltaTag v={totals?.net7d ?? null} size={11.5} />
									<span className="text-bn-2xs text-bn-text-secondary">
										{tx("sourceUi.pages.Stats.footer.27")}
									</span>
									<span className="ml-auto">
										<Sparkline
											data={(totals?.series ?? []).slice(-14)}
											color={PINK}
											width={64}
											height={20}
										/>
									</span>
								</>
							}
						/>
						<GlassStatCard
							label={tx("sourceUi.pages.Stats.label.28")}
							value={num(totals?.net1d ?? null, { signed: true })}
							color={TEAL}
							pulse
						/>
						<GlassStatCard
							label={tx("sourceUi.pages.Stats.label.29", { value1: days })}
							value={num(totals?.netWindow ?? null, { signed: true })}
							color={PURPLE}
						/>
						<GlassStatCard
							label={tx("sourceUi.pages.Stats.ContentMix.13")}
							value={dash(totals?.videoPosts)}
							suffix={tx("sourceUi.pages.Stats.suffix.30")}
							color={AMBER}
						/>
						<GlassStatCard
							label={tx("sourceUi.pages.Stats.label.31")}
							value={dash(totals?.liveSessions)}
							suffix={tx("sourceUi.pages.Stats.suffix.32", {
								value1: dash(totals?.liveHours, hours),
							})}
							color={BLUE}
						/>
					</>
				)}
			</div>

			{/* 主面板 + 侧图 */}
			<div className="grid gap-3.5 xl:grid-cols-[1.9fr_1fr]">
				{focused ? (
					<GlassPanel
						title={tx("sourceUi.pages.Stats.title.35", { value1: focusedMeta?.name ?? "" })}
						subtitle={tx("sourceUi.pages.Stats.subtitle.36", { value1: days })}
						accent={focusColor}
						icon={<Icon.heart width={15} height={15} />}
					>
						<ResponsiveChart
							height={250}
							render={(w) => (
								<TrendChart
									series={[
										{
											name: focused.subscriptionId,
											color: focusColor,
											data: cumulativeFans(focused),
										},
									]}
									width={w}
									height={250}
									xLabels={xLabels}
									area
									absolute
									bridge
								/>
							)}
						/>
					</GlassPanel>
				) : (
					<GlassPanel
						title={tx("sourceUi.pages.Stats.title.37")}
						subtitle={tx("sourceUi.pages.Stats.subtitle.38")}
						accent={PINK}
						icon={<Icon.list width={15} height={15} />}
						right={
							<Btn size="sm" variant="ghost" onClick={() => exportCsv(rows, metaOf, days, sources)}>
								{tx("sourceUi.pages.Stats.right.39")}
							</Btn>
						}
					>
						<CompareTable rows={rows} metaOf={metaOf} days={days} onPick={setPicked} />
					</GlassPanel>
				)}

				{focused ? (
					<GlassPanel
						title={tx("sourceUi.pages.Stats.title.40")}
						subtitle={tx("sourceUi.pages.Stats.subtitle.41", { value1: days })}
						accent={PURPLE}
						icon={<Icon.star width={15} height={15} />}
					>
						<div className="flex h-full min-h-52 items-center justify-center">
							{radarAxes ? (
								<RadarChart color={focusColor} size={252} axes={radarAxes} />
							) : (
								<ChartEmpty hint={tx("sourceUi.pages.Stats.hint.42")} />
							)}
						</div>
					</GlassPanel>
				) : (
					<GlassPanel
						title={tx("sourceUi.pages.Stats.title.43")}
						subtitle={tx("sourceUi.pages.Stats.subtitle.44", { value1: days })}
						accent={PINK}
						icon={<Icon.fire width={15} height={15} />}
					>
						<Heatmap rows={heatRows} days={axis} />
					</GlassPanel>
				)}
			</div>

			{/* 净增 + 内容构成 + 直播 */}
			<div className="grid gap-3.5 xl:grid-cols-[1.5fr_1fr_1fr]">
				<GlassPanel
					title={
						focused
							? tx("sourceUi.pages.Stats.title.45", { value1: focusedMeta?.name ?? "" })
							: tx("sourceUi.pages.Stats.title.46")
					}
					subtitle={
						focused
							? tx("sourceUi.pages.Stats.subtitle.47", { value1: days })
							: tx("sourceUi.pages.Stats.subtitle.48", { value1: days })
					}
					accent={BLUE}
					icon={<Icon.heart width={15} height={15} />}
					right={
						<span
							className="rounded-bn-pill px-2 py-0.5 text-bn-xs font-bold"
							style={{
								// 三档,不是两档:`(x ?? 0) >= 0` 会把「没有记录」归零后判成非负,
								// 于是粉丝还没采到样本时徽章是绿的 —— 数值那侧显示 `—`,颜色却在
								// 说「涨了」。null 的语气交给 signTone 统一裁,有测试守着。
								color: NET_TONE_COLOR[signTone(focused ? focused.netWindow : totals?.netWindow)],
								background: "var(--color-bn-code-bg)",
							}}
						>
							{num(focused ? focused.netWindow : (totals?.netWindow ?? null), { signed: true })} /{" "}
							{days}
							{tx("sourceUi.pages.Stats.right.49")}
						</span>
					}
				>
					{/*
					 * 单人与汇总都用柱状 —— 设计稿这里画的是面积折线,但那是拿平滑的假数据凑出来的。
					 * 每日净增是**带符号**的离散量,面积图会从折线填到零基线,一旦曲线穿过 0,正负两段
					 * 的填充用同一个颜色叠在一起,+5000 和 -5000 看起来一模一样,自交的多边形还会渲染出
					 * 一堆奇形怪状的碎块。柱状天然能表达符号(涨绿跌红),也和单人视图口径统一。
					 *
					 * 两个视图都从**累计末值**重算净增,顺带把停机断档的整段涨幅按天摊开(灰柱)。
					 * 服务端的 `series` 在断档处已经把整段合计压在末尾那一天,摊不回去 ——
					 * 无断档时两者逐位相等,见 gaps.ts。
					 *
					 * 汇总是**先各摊各的、再逐位相加**,不是先加出一条全站累计再摊:某位 UP
					 * 那天缺数据时,它的几十万粉丝会从合计里整个消失,曲线上多出一个假坑。
					 */}
					<ResponsiveChart
						height={200}
						render={(w) => (
							<NetBars
								data={
									focused
										? netFromCumulative(focused.cumulative)
										: sumNetPoints(rows.map((r) => netFromCumulative(r.cumulative)))
								}
								days={axis}
								width={w}
								height={200}
								xLabels={xLabels}
							/>
						)}
					/>
				</GlassPanel>

				<GlassPanel
					title={tx("sourceUi.pages.Stats.title.50")}
					subtitle={
						focused
							? tx("sourceUi.pages.Stats.subtitle.51", { value1: focusedMeta?.name ?? "" })
							: tx("sourceUi.pages.Stats.subtitle.52")
					}
					accent={PURPLE}
					icon={<Icon.dyn width={15} height={15} />}
				>
					<ContentMix
						plainPosts={plainPostCount(focused ?? totals)}
						videoPosts={focused ? focused.videoPosts : (totals?.videoPosts ?? null)}
						lives={focused ? focused.liveSessions : (totals?.liveSessions ?? null)}
						days={days}
						coveredDays={coveredDayCount(focused ? focused.activity : totals?.activity)}
						coveredTotal={coveredActivityTotal(focused ? focused.activity : totals?.activity)}
					/>
				</GlassPanel>

				{focused ? (
					<GlassPanel
						title={tx("sourceUi.pages.Stats.title.53")}
						subtitle={tx("sourceUi.pages.Stats.subtitle.54", { value1: days })}
						accent={PINK}
						icon={<Icon.live width={15} height={15} />}
					>
						<div className="grid grid-cols-2 gap-2">
							{(
								[
									[
										tx("sourceUi.pages.Stats.Stats.55"),
										dash(focused.liveSessions),
										tx("sourceUi.pages.Stats.Stats.56"),
									],
									[tx("sourceUi.pages.Stats.Stats.57"), dash(focused.liveHours, hours), "h"],
									[
										// 分母是**时长已知**的场次,不是全部场次 —— 硬杀进程留下的
										// 场次时长未知,按 0 计进分母会把场均值平白拉低。
										tx("sourceUi.pages.Stats.Stats.58"),
										focused.liveTimedSessions && focused.liveHours !== null
											? hours(focused.liveHours / focused.liveTimedSessions)
											: "—",
										"h",
									],
									// 每场的数是本场**累计**观看(ADR-0020 决策 7),不是同时在线的峰值 —— 曾叫「峰值观看 /
									// 场均峰值」,名不副实(决策 11)。面板底下那句说明是按什么算的。
									[tx("sourceUi.pages.Stats.Stats.59"), num(focused.maxViewers), ""],
									[tx("sourceUi.pages.Stats.Stats.60"), num(focused.avgViewers), ""],
									[
										tx("sourceUi.pages.Stats.ContentMix.13"),
										dash(focused.videoPosts),
										tx("sourceUi.pages.Stats.suffix.30"),
									],
								] as Array<[string, string, string]>
							).map(([label, v, unit]) => (
								<div
									key={label}
									className="rounded-bn-card border border-bn-border-subtle bg-bn-surface-muted px-2.5 py-2"
								>
									<div className="mb-1 text-bn-2xs font-semibold text-bn-text-secondary">
										{label}
									</div>
									<div className="flex items-baseline gap-1">
										<span className="tabular-nums text-bn-lg font-bold" style={{ color: PINK }}>
											{v}
										</span>
										{unit ? (
											<span className="text-bn-2xs text-bn-text-secondary">{unit}</span>
										) : null}
									</div>
								</div>
							))}
						</div>
						<HintNote className="mt-2">
							{tx("sourceUi.pages.Stats.Stats.61")}
							{VIEWERS_HINT}
						</HintNote>
					</GlassPanel>
				) : (
					<GlassPanel
						title={tx("sourceUi.pages.Stats.title.62")}
						subtitle={tx("sourceUi.pages.Stats.subtitle.63", { value1: days })}
						accent={PINK}
						icon={<Icon.live width={15} height={15} />}
					>
						{/* 无记录(null)的 UP 不进排名 —— 「没在记」不是「播了 0 小时」。
						    下面的 `?? 0` 只是让 TS 收窄,filter 已经保证走到那儿的都是实数。 */}
						{rows.some((r) => (r.liveHours ?? 0) > 0) ? (
							<div className="flex flex-col gap-2.5">
								{[...rows]
									.filter((r) => (r.liveHours ?? 0) > 0)
									.sort((a, b) => (b.liveHours ?? 0) - (a.liveHours ?? 0))
									.slice(0, 5)
									.map((r) => {
										const mx = Math.max(...rows.map((x) => x.liveHours ?? 0));
										const m = metaOf(r);
										return (
											<div key={r.subscriptionId} className="flex items-center gap-2 text-bn-sm">
												<span className="w-16 truncate font-semibold text-bn-text-primary">
													{m.name}
												</span>
												<div className="h-2 flex-1 overflow-hidden rounded-full bg-bn-code-bg">
													<div
														className="h-full rounded-full"
														style={{
															width: `${((r.liveHours ?? 0) / mx) * 100}%`,
															background: m.color,
														}}
													/>
												</div>
												<span className="w-9 text-right tabular-nums font-bold text-bn-text-tertiary">
													{hours(r.liveHours ?? 0)}h
												</span>
											</div>
										);
									})}
							</div>
						) : (
							<ChartEmpty hint={tx("sourceUi.pages.Stats.hint.64")} />
						)}
					</GlassPanel>
				)}
			</div>

			{/* AI 锐评 —— 两张不同的卡:榜单需要对照组,单人只就自己的数据说话 */}
			{/* 定时配置与手动生成并排:同一件事的两种触发方式,配置在左、现在就生成在右。
			    页头选了某位 UP 就整组换成他自己的那一套(定时锐评 + 单人锐评),没选就是
			    全局那套(榜单周报 + 榜单锐评)—— 看的是谁,配的就是谁。窄屏回落成单栏。 */}
			{focused ? (
				// 单人锐评与它的定时两支订阅都有,按订阅 id 认(ADR-0020 决策 14 / 18)。
				<div className="grid gap-4 lg:grid-cols-2 lg:items-stretch">
					<SoloRoastScheduleBox
						key={`sched-${focused.subscriptionId}`}
						subscriptionId={focused.subscriptionId}
						name={metaOf(focused).name}
					/>
					<SoloRoastCard
						key={focused.subscriptionId}
						subscriptionId={focused.subscriptionId}
						name={metaOf(focused).name}
						color={focusColor}
						avatar={focusedMeta?.avatar}
						days={days}
					/>
				</div>
			) : (
				<div className="grid gap-4 lg:grid-cols-2 lg:items-stretch">
					<RoastScheduleBox />
					{/* 榜单结果按订阅 id 回指(决策 18),名字 / 颜色 / 头像查的就是统计行那一份。 */}
					<RoastCard days={days} meta={meta} />
				</div>
			)}
		</div>
	);
}
