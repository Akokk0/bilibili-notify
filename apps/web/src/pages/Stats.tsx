import type { SubscriptionDTO } from "@bilibili-notify/contract";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Avatar, Btn } from "../components/atoms";
import { GlassPanel, GlassStatCard } from "../components/glass";
import { Icon } from "../components/icons";
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
	type StatsOverviewResponse,
	sparseLabels,
	statsQueryKey,
	type UpStatsRow,
} from "../services/stats";
import type { SignTone } from "./stats/chart-utils";
import { dash, formatSignedWan, formatWan, signTone } from "./stats/chart-utils";
import {
	ChartEmpty,
	DeltaTag,
	Donut,
	Heatmap,
	NetBars,
	RadarChart,
	ResponsiveChart,
	Sparkline,
	TrendChart,
} from "./stats/charts";
import { buildStatColumns, type StatColumnId } from "./stats/columns";
import { buildCsv } from "./stats/csv";
import { netFromCumulative, sumNetPoints } from "./stats/gaps";
import { RoastCard } from "./stats/RoastCard";
import { RoastScheduleBox } from "./stats/RoastScheduleBox";
import { buildRadarAxes } from "./stats/radar";
import { SoloRoastCard } from "./stats/SoloRoastCard";
import { colorFromUid, displayName } from "./up/helpers";

/**
 * 面板 / KPI 卡的主题色。
 *
 * **必须是十六进制字面量,不能用 `var(--color-bn-*)`**:GlassPanel 与
 * GlassStatCard 会拼 alpha 后缀(`${color}1a`)来造渐变底色和描边,拼上 CSS
 * 变量会得到 `var(--color-bn-pink)1a` 这种非法值 —— 浏览器**静默丢弃整条声明**,
 * 卡片就变成没有底色、没有边框的裸块,而且 typecheck 和 lint 都发现不了。
 * 取值与 styles.css 里的同名 token 一致。
 */
const PINK = "#fb7299";
const BLUE = "#00aeec";
const PURPLE = "#a29bfe";
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

const RANGES = [
	{ days: 7, label: "近7日" },
	{ days: 30, label: "近30日" },
	{ days: 90, label: "近90日" },
] as const;

/** 数值展示统一走这里:`null` 一律显示破折号,绝不用 0 顶替「没有记录」。 */
function num(v: number | null, fmt: (n: number) => string = formatWan): string {
	return v === null ? "—" : fmt(v);
}

function hours(h: number): string {
	return h >= 10 ? String(Math.round(h)) : h.toFixed(1).replace(/\.0$/, "");
}

/** 距今多久 —— 鸽子榜要的信号。 */
function sinceText(iso: string | null): string {
	if (!iso) return "无记录";
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms)) return "无记录";
	const mins = Math.floor(ms / 60_000);
	if (mins < 1) return "刚刚";
	if (mins < 60) return `${mins} 分钟前`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs} 小时前`;
	return `${Math.floor(hrs / 24)} 天前`;
}

interface UpMeta {
	name: string;
	color: string;
	/** B 站头像 URL。缺省时 Avatar 退回首字母块 —— 订阅刚建、profile 还没缓存到。 */
	avatar?: string;
	sub?: SubscriptionDTO;
}

/**
 * 把当前对比表导出成 CSV。
 *
 * 列定义在 `stats/csv.ts` —— 表头与取值同源、有测试守着。这里只剩下载那几行:
 * 拼 BOM(否则 Excel 打开中文列名是乱码)、造 Blob、点一下虚拟链接。
 */
function exportCsv(rows: UpStatsRow[], meta: Map<string, UpMeta>, days: number): void {
	const csv = buildCsv(rows, days, (uid) => meta.get(uid)?.name ?? `UID ${uid}`);
	const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `bilibili-notify-stats-${new Date().toISOString().slice(0, 10)}.csv`;
	a.click();
	URL.revokeObjectURL(url);
}

/** UP 选择器 —— 全部 / 单个 UP 的切换入口。 */
function UpPicker({
	rows,
	meta,
	value,
	onChange,
}: {
	rows: UpStatsRow[];
	meta: Map<string, UpMeta>;
	value: string | null;
	onChange: (uid: string | null) => void;
}) {
	const [open, setOpen] = useState(false);
	const cur = value ? meta.get(value) : undefined;
	return (
		<div className="relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex h-9 min-w-40 items-center gap-2 rounded-bn-card border border-bn-border bg-bn-surface px-2.5 text-left"
			>
				{/* 「全部 UP 主」不配头像 —— 汇总视图没有「一个人」可代表,
				    原来那颗粉蓝渐变圆只是个占位,反而像某位 UP 的头像。 */}
				{cur ? <Avatar name={cur.name} color={cur.color} size={22} url={cur.avatar} /> : null}
				<span className="text-xs font-bold text-bn-text-primary">{cur?.name ?? "全部 UP 主"}</span>
				<span className="ml-auto text-xs text-bn-text-secondary">{open ? "▴" : "▾"}</span>
			</button>
			{open ? (
				<div className="absolute left-0 top-[calc(100%+6px)] z-50 max-h-80 min-w-56 overflow-y-auto rounded-bn-card border border-bn-border bg-bn-surface shadow-bn-card">
					<button
						type="button"
						onClick={() => {
							onChange(null);
							setOpen(false);
						}}
						className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-bn-hover-muted"
					>
						<span className="text-xs font-bold text-bn-text-primary">全部 UP 主</span>
						<span className="ml-auto text-xs text-bn-text-secondary">汇总</span>
					</button>
					{rows.map((r) => {
						const m = meta.get(r.uid);
						return (
							<button
								key={r.uid}
								type="button"
								onClick={() => {
									onChange(r.uid);
									setOpen(false);
								}}
								className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-bn-hover-muted"
							>
								<Avatar
									name={m?.name ?? r.uid}
									color={m?.color ?? PINK}
									size={26}
									url={m?.avatar}
									status={r.live ? "living" : undefined}
								/>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-xs font-bold text-bn-text-primary">
										{m?.name ?? `UID ${r.uid}`}
									</span>
									<span className="block text-[10.5px] text-bn-text-secondary">
										{num(r.fans)} · {sinceText(r.lastActivityAt)}
									</span>
								</span>
								<DeltaTag v={r.net7d} size={10.5} />
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

/** UP 对比表 —— 全局视图的主面板,点行进入单 UP 钻取。 */
function CompareTable({
	rows,
	meta,
	days,
	onPick,
}: {
	rows: UpStatsRow[];
	meta: Map<string, UpMeta>;
	days: number;
	onPick: (uid: string) => void;
}) {
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

	if (!rows.length) return <ChartEmpty hint="还没有订阅任何 UP 主" />;

	return (
		<div className="overflow-x-auto">
			<table className="w-full border-collapse text-xs">
				<thead>
					<tr className="border-b border-bn-border">
						<th className="px-2.5 py-2 text-left text-[11px] font-bold text-bn-text-secondary">
							UP 主
						</th>
						<th className="px-2.5 py-2 text-right text-[11px] font-bold text-bn-text-secondary">
							粉丝数
						</th>
						<th className="px-2.5 py-2 text-center text-[11px] font-bold text-bn-text-secondary">
							近期走势
						</th>
						{cols.map((c) => (
							<th
								key={c.id}
								className="whitespace-nowrap px-2.5 py-2 text-right text-[11px] font-bold"
								style={{ color: sort === c.id ? PINK : "var(--color-bn-text-secondary)" }}
							>
								<button type="button" onClick={() => setSort(c.id)}>
									{c.label}
									{sort === c.id ? " ▾" : ""}
								</button>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{sorted.map((r) => {
						const m = meta.get(r.uid);
						const color = m?.color ?? PINK;
						return (
							<tr
								key={r.uid}
								onClick={() => onPick(r.uid)}
								className="cursor-pointer border-b border-bn-border-subtle hover:bg-bn-hover-muted"
							>
								<td className="px-2.5 py-2">
									<div className="flex items-center gap-2">
										<Avatar
											name={m?.name ?? r.uid}
											color={color}
											size={28}
											url={m?.avatar}
											status={r.live ? "living" : undefined}
										/>
										<div className="min-w-0">
											<div className="truncate text-xs font-bold text-bn-text-primary">
												{m?.name ?? `UID ${r.uid}`}
											</div>
											<div className="text-[10.5px] text-bn-text-secondary">
												{sinceText(r.lastActivityAt)}
												{r.live ? " · 直播中" : ""}
											</div>
										</div>
									</div>
								</td>
								<td className="px-2.5 py-2 text-right font-mono font-bold text-bn-text-primary">
									{num(r.fans)}
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
											className={`px-2.5 py-2 text-right font-mono font-bold${
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
	dynamics,
	archives,
	lives,
	days,
	coveredDays,
	coveredTotal,
}: {
	dynamics: number | null;
	archives: number | null;
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
	// 「没在记」与「在记但没动静」是两回事,空态文案也得分开 —— 否则老库升级后
	// 点开近 90 日,会看到一句「还没有发过任何内容」扣在一位高产 UP 头上。
	if (dynamics === null && archives === null && lives === null) {
		return <ChartEmpty hint="这段时间我们还没有采集到数据" />;
	}
	// 走到这里至少有一项有记录。剩下的 null 是「这一类没记到」,并进 0 参与占比 ——
	// 分类占比图上没有「未知的那一块」可画,但整体「没在记」的情形已在上面拦掉了。
	const dyn = dynamics ?? 0;
	const arc = archives ?? 0;
	const liv = lives ?? 0;
	const total = dyn + arc + liv;
	if (total === 0) return <ChartEmpty hint="这段时间还没有采集到任何活动" />;
	const parts: Array<[string, number, string]> = [
		["动态", dyn, PURPLE],
		["投稿", arc, BLUE],
		["直播", liv, PINK],
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
							<div className="text-xl font-bold text-bn-text-primary">{total}</div>
							<div className="text-[9.5px] text-bn-text-secondary">总活动</div>
						</div>
					}
				/>
				<div className="flex flex-col gap-1">
					<div className="text-[11px] text-bn-text-secondary">日均活动</div>
					<div className="font-mono text-2xl font-bold leading-none" style={{ color: PURPLE }}>
						{coveredDays > 0 ? (coveredTotal / coveredDays).toFixed(1) : "—"}
					</div>
					<div className="text-[10.5px] text-bn-text-secondary">
						次 / 天 · {coveredDays < days ? `已记录${coveredDays}日` : `近${days}日`}
					</div>
				</div>
			</div>
			<div className="flex flex-col gap-2.5">
				{parts.map(([label, v, c]) => (
					<div key={label} className="flex items-center gap-2 text-xs">
						<span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: c }} />
						<span className="w-8 shrink-0 text-bn-text-tertiary">{label}</span>
						<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bn-code-bg">
							<div
								className="h-full rounded-full"
								style={{ width: `${(v / total) * 100}%`, background: c }}
							/>
						</div>
						<b className="w-6 text-right font-mono text-bn-text-primary">{v}</b>
						<span className="w-9 text-right font-mono text-bn-text-secondary">
							{Math.round((v / total) * 100)}%
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

export default function Stats() {
	const [days, setDays] = useState<number>(30);
	const [picked, setPicked] = useState<string | null>(null);

	const statsQuery = useQuery({
		queryKey: statsQueryKey(days),
		queryFn: () =>
			api.get<StatsOverviewResponse>(`/api/stats/overview?days=${days}&tz=${localTzOffset()}`),
	});
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<SubscriptionDTO[]>("/api/subs"),
	});

	const meta = useMemo(() => {
		const m = new Map<string, UpMeta>();
		for (const s of subsQuery.data ?? []) {
			m.set(s.uid, {
				name: displayName(s),
				color: colorFromUid(s.uid),
				avatar: s.cachedProfile?.avatar,
				sub: s,
			});
		}
		return m;
	}, [subsQuery.data]);

	const res = statsQuery.data;
	const rows = res?.rows ?? [];
	const axis = useMemo(() => dayAxis(days), [days]);
	const xLabels = useMemo(() => sparseLabels(axis), [axis]);
	const totals = useMemo(() => (res ? computeTotals(res) : null), [res]);
	/** 「总粉丝量」只加得动有记录的那几位,少于订阅数时标签要如实说明。 */
	const fansKnown = fansKnownCount(rows);
	const focused = picked ? (rows.find((r) => r.uid === picked) ?? null) : null;
	const focusedMeta = focused ? meta.get(focused.uid) : undefined;
	const focusColor = focusedMeta?.color ?? PINK;

	// 画像跟随顶部的时间范围。六根轴里只有「粉丝规模(当前)」不随窗口变 ——
	// 粉丝数是「此刻共有多少」,没有「近30日的粉丝规模」这回事;轴上并排标着
	// 原始值,切换范围时哪根动了哪根没动一目了然。
	const radarAxes = useMemo(
		() => (focused ? buildRadarAxes(focused, rows) : null),
		[focused, rows],
	);

	if (statsQuery.isLoading) {
		return <div className="p-8 text-sm text-bn-text-secondary">正在读取统计数据…</div>;
	}
	if (statsQuery.isError) {
		return <div className="p-8 text-sm text-bn-danger-text">统计数据加载失败,请稍后重试。</div>;
	}

	const heatRows = (focused ? [focused] : rows).map((r) => ({
		uid: r.uid,
		name: meta.get(r.uid)?.name ?? `UID ${r.uid}`,
		color: meta.get(r.uid)?.color ?? PINK,
		cells: r.activity.map(activityLevel),
	}));

	return (
		<div className="flex flex-col gap-3.5 p-6">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="flex items-center gap-3">
					{/* 单 UP 视图给一枚大头像 —— 钻进某个人之后,页头得先回答「现在看的是谁」。 */}
					{focused ? (
						<Avatar
							name={focusedMeta?.name ?? focused.uid}
							color={focusColor}
							size={44}
							url={focusedMeta?.avatar}
							status={focused.live ? "living" : undefined}
						/>
					) : null}
					<div>
						<div className="text-lg font-bold tracking-tight text-bn-text-primary">
							{focused ? (focusedMeta?.name ?? `UID ${focused.uid}`) : "数据统计 · 粉丝与动态分析"}
						</div>
						<div className="mt-1 text-xs text-bn-text-secondary">
							{focused ? (
								// 名字已经在上面的标题里了,这行改说 UID —— 昵称会改,UID 不会,
								// 主人对着后台核对时要的是这个。
								<>
									UID <b style={{ color: focusColor }}>{focused.uid}</b> · 粉丝增减、投稿与直播情况
								</>
							) : (
								<>
									女仆帮主人盯着 <b style={{ color: PINK }}>{rows.length}</b> 位 UP
									主的粉丝增减、投稿与直播频率 ~(*´∀`)~♡
								</>
							)}
						</div>
					</div>
				</div>
				<div className="flex items-center gap-2.5">
					<UpPicker rows={rows} meta={meta} value={picked} onChange={setPicked} />
					<div className="flex gap-1 rounded-bn-card border border-bn-border bg-bn-surface p-0.5">
						{RANGES.map((r) => (
							<button
								key={r.days}
								type="button"
								onClick={() => setDays(r.days)}
								className="rounded-md px-3 py-1.5 text-xs font-semibold"
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
							label="当前粉丝"
							value={num(focused.fans)}
							color={focusColor}
							footer={
								<>
									<DeltaTag v={focused.net7d} size={11.5} />
									<span className="text-[10.5px] text-bn-text-secondary">近7日</span>
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
							label="今日净增"
							value={num(focused.net1d, formatSignedWan)}
							color={TEAL}
							pulse
						/>
						<GlassStatCard
							label={`近${days}日净增`}
							value={num(focused.netWindow, formatSignedWan)}
							color={PURPLE}
						/>
						<GlassStatCard label="投稿" value={dash(focused.archives)} suffix="个" color={BLUE} />
						<GlassStatCard
							label="开播"
							value={dash(focused.liveSessions)}
							suffix={`场 · ${dash(focused.liveHours, hours)}h`}
							color={AMBER}
						/>
					</>
				) : (
					<>
						<GlassStatCard
							// 部分 UP 还没采到样本时,这个数不是全站合计 —— 标签得说明白,
							// 否则「总粉丝量」会被读成所有订阅的和,而它少算了几位。
							label={
								fansKnown < rows.length ? `总粉丝量 · ${fansKnown}/${rows.length} 位` : "总粉丝量"
							}
							value={num(totals?.fans ?? null)}
							color={PINK}
							footer={
								<>
									<DeltaTag v={totals?.net7d ?? null} size={11.5} />
									<span className="text-[10.5px] text-bn-text-secondary">近7日</span>
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
							label="今日净增"
							value={num(totals?.net1d ?? null, formatSignedWan)}
							color={TEAL}
							pulse
						/>
						<GlassStatCard
							label={`近${days}日净增`}
							value={num(totals?.netWindow ?? null, formatSignedWan)}
							color={PURPLE}
						/>
						<GlassStatCard label="投稿" value={dash(totals?.archives)} suffix="个" color={BLUE} />
						<GlassStatCard
							label="开播"
							value={dash(totals?.liveSessions)}
							suffix={`场 · ${dash(totals?.liveHours, hours)}h`}
							color={AMBER}
						/>
					</>
				)}
			</div>

			{/* 主面板 + 侧图 */}
			<div className="grid gap-3.5 xl:grid-cols-[1.9fr_1fr]">
				{focused ? (
					<GlassPanel
						title={`${focusedMeta?.name} · 粉丝总量走势`}
						subtitle={`累计粉丝数变化 · 近${days}日`}
						accent={focusColor}
						icon={<Icon.heart width={15} height={15} />}
					>
						<ResponsiveChart
							height={250}
							render={(w) => (
								<TrendChart
									series={[
										{
											name: focused.uid,
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
						title="UP 主数据对比"
						subtitle="点击表头排序 · 投稿 / 直播 / 动态 全维度 · 点击某行查看单人分析"
						accent={PINK}
						icon={<Icon.list width={15} height={15} />}
						right={
							<Btn size="sm" variant="ghost" onClick={() => exportCsv(rows, meta, days)}>
								导出 CSV
							</Btn>
						}
					>
						<CompareTable rows={rows} meta={meta} days={days} onPick={setPicked} />
					</GlassPanel>
				)}

				{focused ? (
					<GlassPanel
						title="能力画像"
						subtitle={`轴长 = 在已订阅 UP 中的相对位置 · 近${days}日`}
						accent={PURPLE}
						icon={<Icon.star width={15} height={15} />}
					>
						<div className="flex h-full min-h-52 items-center justify-center">
							{radarAxes ? (
								<RadarChart color={focusColor} size={252} axes={radarAxes} />
							) : (
								<ChartEmpty hint="至少订阅 2 位 UP 主才画得出相对画像 —— 只有一位时六根轴会全部满格,没有信息量" />
							)}
						</div>
					</GlassPanel>
				) : (
					<GlassPanel
						title="活跃热力图"
						subtitle={`每格一天 · 颜色越深越活跃 · 近${days}日`}
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
					title={focused ? `${focusedMeta?.name} · 粉丝净增趋势` : "订阅 UP 粉丝净增趋势"}
					subtitle={
						focused
							? `每日粉丝净增(涨绿跌红)· 近${days}日`
							: `所有订阅 UP 主每日净增合计 · 近${days}日`
					}
					accent={BLUE}
					icon={<Icon.heart width={15} height={15} />}
					right={
						<span
							className="rounded-full px-2 py-0.5 text-[11px] font-bold"
							style={{
								// 三档,不是两档:`(x ?? 0) >= 0` 会把「没有记录」归零后判成非负,
								// 于是粉丝还没采到样本时徽章是绿的 —— 数值那侧显示 `—`,颜色却在
								// 说「涨了」。null 的语气交给 signTone 统一裁,有测试守着。
								color: NET_TONE_COLOR[signTone(focused ? focused.netWindow : totals?.netWindow)],
								background: "var(--color-bn-code-bg)",
							}}
						>
							{num(focused ? focused.netWindow : (totals?.netWindow ?? null), formatSignedWan)} /{" "}
							{days}天
						</span>
					}
				>
					{/*
					 * 单人与汇总都用柱状 —— 设计稿这里画的是面积折线,但那是拿平滑的假数据凑出来的。
					 * 每日净增是**带符号**的离散量,面积图会从折线填到零基线,一旦曲线穿过 0,正负两段
					 * 的填充用同一个颜色叠在一起,+5000 和 −5000 看起来一模一样,自交的多边形还会渲染出
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
					title="内容构成"
					subtitle={focused ? `${focusedMeta?.name} 的类型占比` : "全部订阅 UP 的类型占比"}
					accent={PURPLE}
					icon={<Icon.dyn width={15} height={15} />}
				>
					<ContentMix
						dynamics={focused ? focused.dynamics : (totals?.dynamics ?? null)}
						archives={focused ? focused.archives : (totals?.archives ?? null)}
						lives={focused ? focused.liveSessions : (totals?.liveSessions ?? null)}
						days={days}
						coveredDays={coveredDayCount(focused ? focused.activity : totals?.activity)}
						coveredTotal={coveredActivityTotal(focused ? focused.activity : totals?.activity)}
					/>
				</GlassPanel>

				{focused ? (
					<GlassPanel
						title="直播概览"
						subtitle={`近${days}日开播与人气`}
						accent={PINK}
						icon={<Icon.live width={15} height={15} />}
					>
						<div className="grid grid-cols-2 gap-2">
							{(
								[
									["开播场次", dash(focused.liveSessions), "场"],
									["直播总时长", dash(focused.liveHours, hours), "h"],
									[
										// 分母是**时长已知**的场次,不是全部场次 —— 硬杀进程留下的
										// 场次时长未知,按 0 计进分母会把场均值平白拉低。
										"场均时长",
										focused.liveTimedSessions && focused.liveHours !== null
											? hours(focused.liveHours / focused.liveTimedSessions)
											: "—",
										"h",
									],
									["峰值观看", num(focused.peakViewers), ""],
									// 我们只采得到每场的峰值,所以这是「场均峰值」而不是「平均观看」。
									["场均峰值", num(focused.avgPeakViewers), ""],
									["投稿", dash(focused.archives), "个"],
								] as Array<[string, string, string]>
							).map(([label, v, unit]) => (
								<div
									key={label}
									className="rounded-bn-card border border-bn-border-subtle bg-bn-surface-muted px-2.5 py-2"
								>
									<div className="mb-1 text-[10.5px] font-semibold text-bn-text-secondary">
										{label}
									</div>
									<div className="flex items-baseline gap-1">
										<span className="font-mono text-lg font-bold" style={{ color: PINK }}>
											{v}
										</span>
										{unit ? (
											<span className="text-[10.5px] text-bn-text-secondary">{unit}</span>
										) : null}
									</div>
								</div>
							))}
						</div>
					</GlassPanel>
				) : (
					<GlassPanel
						title="直播时长 Top"
						subtitle={`近${days}日开播时长排名`}
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
										const m = meta.get(r.uid);
										return (
											<div key={r.uid} className="flex items-center gap-2 text-xs">
												<span className="w-16 truncate font-semibold text-bn-text-primary">
													{m?.name ?? r.uid}
												</span>
												<div className="h-2 flex-1 overflow-hidden rounded-full bg-bn-code-bg">
													<div
														className="h-full rounded-full"
														style={{
															width: `${((r.liveHours ?? 0) / mx) * 100}%`,
															background: m?.color ?? PINK,
														}}
													/>
												</div>
												<span className="w-9 text-right font-mono font-bold text-bn-text-tertiary">
													{hours(r.liveHours ?? 0)}h
												</span>
											</div>
										);
									})}
							</div>
						) : (
							<ChartEmpty hint="这段时间还没有采集到开播记录" />
						)}
					</GlassPanel>
				)}
			</div>

			{/* AI 锐评 —— 两张不同的卡:榜单需要对照组,单人只就自己的数据说话 */}
			{focused ? (
				<SoloRoastCard
					key={focused.uid}
					uid={focused.uid}
					name={focusedMeta?.name ?? `UID ${focused.uid}`}
					color={focusColor}
					avatar={focusedMeta?.avatar}
					days={days}
				/>
			) : (
				/* 定时周报与手动锐评并排:同一件事的两种触发方式,配置在左、现在就生成
				   在右。窄屏回落成单栏。只在榜单视图下露出 —— 这里配的是全局那条榜单
				   流水线,跟当前钻取的是哪一位 UP 无关(单人锐评的定时挂在各自订阅上)。 */
				<div className="grid gap-4 lg:grid-cols-2 lg:items-start">
					<RoastScheduleBox />
					<RoastCard days={days} meta={meta} />
				</div>
			)}
		</div>
	);
}
