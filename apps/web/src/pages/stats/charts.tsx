import { useLayoutEffect, useRef, useState } from "react";
import {
	compactSeries,
	extent,
	formatAxisWan,
	formatSignedWan,
	heatAxisLabels,
	heatCellStyle,
	niceTicks,
	splitSegments,
} from "./chart-utils.js";
import type { RadarAxis } from "./radar.js";

/**
 * 数据统计页的 SVG 图表原子。
 *
 * 全部手写 SVG、零图表库依赖 —— 这几张图形态固定,引一个通用图表库既撑大
 * 前端包体,又要花同样多的力气把它的默认视觉扳成本项目的玻璃拟态风格。
 *
 * 颜色一律走 `var(--color-bn-*)` 主题令牌,明暗两套主题自动跟随;**不要**在这里
 * 写死十六进制 —— 写死的颜色在暗色主题下会瞎掉,而且 UnoCSS 的 token 护栏
 * (color-token-conformance)只管 utility class,管不到 SVG 属性。
 */

const AXIS_TEXT = "var(--color-bn-text-secondary)";
const GRID = "var(--color-bn-border-subtle)";
const GRID_ZERO = "var(--color-bn-border)";
const POS = "var(--color-bn-success-text)";
const NEG = "var(--color-bn-danger-text)";

/** 自适宽容器:测出像素宽再把它交给 render(w),避免 SVG 用百分比宽导致文字被拉伸。 */
export function ResponsiveChart({
	height,
	render,
}: {
	height: number;
	render: (width: number) => React.ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [w, setW] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () => {
			const cw = el.clientWidth;
			if (cw > 0) setW(cw);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return (
		<div ref={ref} style={{ width: "100%", height }}>
			{w > 0 ? render(w) : null}
		</div>
	);
}

/** 空数据占位 —— 与「有数据但全是 0」严格区分,文案要说清是没记录。 */
export function ChartEmpty({ hint }: { hint: string }) {
	return (
		<div className="flex h-full min-h-24 items-center justify-center px-4 text-center text-xs text-bn-text-secondary">
			{hint}
		</div>
	);
}

export function DeltaTag({ v, size = 12 }: { v: number | null; size?: number }) {
	if (v === null) {
		return (
			<span className="font-mono text-bn-text-secondary" style={{ fontSize: size }}>
				—
			</span>
		);
	}
	const up = v >= 0;
	return (
		<span className="font-mono font-bold" style={{ fontSize: size, color: up ? POS : NEG }}>
			{up ? "▲" : "▼"} {formatSignedWan(v)}
		</span>
	);
}

/** 迷你走势线。表格里每行一枚,所以不画坐标轴。 */
export function Sparkline({
	data,
	color,
	width = 80,
	height = 24,
}: {
	data: ReadonlyArray<number | null>;
	color: string;
	width?: number;
	height?: number;
}) {
	// 迷你图不表现断档 —— 见 compactSeries 的注释。
	const pts0 = compactSeries(data);
	const ext = extent(pts0);
	if (!ext || pts0.length < 2) return null;
	const min = Math.min(ext.min, 0);
	const max = Math.max(ext.max, 0);
	const rng = max - min || 1;
	const X = (i: number) => (i / (pts0.length - 1)) * width;
	const Y = (v: number) => height - 2 - ((v - min) / rng) * (height - 4);

	return (
		<svg width={width} height={height} style={{ display: "block" }} aria-hidden="true">
			<title>近期走势</title>
			<polygon
				points={`0,${Y(min)} ${pts0.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")} ${width},${Y(min)}`}
				fill={color}
				opacity="0.13"
			/>
			<polyline
				points={pts0.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}
				fill="none"
				stroke={color}
				strokeWidth="1.6"
				strokeLinejoin="round"
				strokeLinecap="round"
			/>
			<circle
				cx={X(pts0.length - 1)}
				cy={Y(pts0[pts0.length - 1] as number)}
				r="2.2"
				fill={color}
			/>
		</svg>
	);
}

interface TrendSeries {
	name: string;
	color: string;
	data: ReadonlyArray<number | null>;
}

/**
 * 折线 / 面积趋势图。`absolute` 用于累计值(粉丝总量),刻度不强制含 0;
 * 缺省用于净增,零基线始终可见。
 */
export function TrendChart({
	series,
	width,
	height = 200,
	xLabels = [],
	area = true,
	absolute = false,
}: {
	series: TrendSeries[];
	width: number;
	height?: number;
	xLabels?: string[];
	area?: boolean;
	absolute?: boolean;
}) {
	const pad = { l: 46, r: 14, t: 14, b: 22 };
	const iw = width - pad.l - pad.r;
	const ih = height - pad.t - pad.b;
	const all = series.flatMap((s) => [...s.data]);
	const ext = extent(all);
	if (!ext) return <ChartEmpty hint="这段时间还没有采集到数据" />;

	// 累计值(粉丝总量)不强制含 0,否则几百万的曲线会被压成贴顶的一条直线。
	const {
		min,
		max,
		ticks: tickVals,
		step,
	} = niceTicks(ext.min, ext.max, {
		includeZero: !absolute,
		// 粉丝数与净增都是人数,刻度不该出现 0.5。
		integer: true,
	});

	const n = series[0]?.data.length ?? 0;
	const X = (i: number) => pad.l + (n > 1 ? (i / (n - 1)) * iw : iw / 2);
	const Y = (v: number) => pad.t + ih - ((v - min) / (max - min)) * ih;
	// 刻度标签的小数位数按**步长**定,不按数值大小定 —— 否则 227 万粉的曲线会画出
	// 三条标着「227万」的网格线(见 formatAxisWan)。
	const fmt = (v: number) => (absolute ? formatAxisWan(v, step) : formatSignedWan(v));
	const baseY = absolute ? pad.t + ih : Y(0);

	return (
		<svg width={width} height={height} style={{ display: "block", maxWidth: "100%" }}>
			<title>趋势图</title>
			{tickVals.map((tv) => (
				<g key={tv}>
					<line
						x1={pad.l}
						x2={width - pad.r}
						y1={Y(tv)}
						y2={Y(tv)}
						stroke={!absolute && tv === 0 ? GRID_ZERO : GRID}
						strokeWidth="1"
					/>
					<text
						x={pad.l - 8}
						y={Y(tv) + 3.5}
						textAnchor="end"
						fontSize="9.5"
						fill={AXIS_TEXT}
						className="font-mono"
					>
						{fmt(Math.round(tv))}
					</text>
				</g>
			))}
			{xLabels.map((l, i) =>
				l ? (
					<text key={l} x={X(i)} y={height - 6} textAnchor="middle" fontSize="9.5" fill={AXIS_TEXT}>
						{l}
					</text>
				) : null,
			)}
			{series.map((s) => {
				const segments = splitSegments(s.data);
				return (
					<g key={s.name}>
						{segments.map((seg) => {
							const pts = seg.map((i) => `${X(i).toFixed(1)},${Y(s.data[i] as number).toFixed(1)}`);
							if (seg.length === 1) {
								return (
									<circle
										key={seg[0]}
										cx={X(seg[0] as number)}
										cy={Y(s.data[seg[0] as number] as number)}
										r="2.5"
										fill={s.color}
									/>
								);
							}
							return (
								<g key={seg[0]}>
									{area && series.length === 1 ? (
										<polygon
											points={`${X(seg[0] as number)},${baseY} ${pts.join(" ")} ${X(seg.at(-1) as number)},${baseY}`}
											fill={s.color}
											opacity="0.14"
										/>
									) : null}
									<polyline
										points={pts.join(" ")}
										fill="none"
										stroke={s.color}
										strokeWidth="2"
										strokeLinejoin="round"
										strokeLinecap="round"
									/>
								</g>
							);
						})}
					</g>
				);
			})}
		</svg>
	);
}

/** 每日净增柱状图。涨绿跌红,零基线常驻。 */
export function NetBars({
	data,
	days,
	width,
	height = 190,
	xLabels = [],
}: {
	data: ReadonlyArray<number | null>;
	/** 与 data 等长的本地日(YYYY-MM-DD)。既是 React key,也是每根柱子的 tooltip。 */
	days: readonly string[];
	width: number;
	height?: number;
	xLabels?: string[];
}) {
	const pad = { l: 46, r: 14, t: 12, b: 22 };
	const iw = width - pad.l - pad.r;
	const ih = height - pad.t - pad.b;
	const ext = extent(data);
	if (!ext) return <ChartEmpty hint="这段时间还没有采集到数据" />;

	const { min, max, ticks: tickVals } = niceTicks(ext.min, ext.max, { integer: true });

	const n = data.length;
	const X = (i: number) => pad.l + ((i + 0.5) / n) * iw;
	const Y = (v: number) => pad.t + ih - ((v - min) / (max - min)) * ih;
	const zeroY = Y(0);
	const bw = Math.max(3, (iw / n) * 0.62);

	return (
		<svg width={width} height={height} style={{ display: "block", maxWidth: "100%" }}>
			<title>每日净增</title>
			{tickVals.map((tv) => (
				<g key={tv}>
					<line
						x1={pad.l}
						x2={width - pad.r}
						y1={Y(tv)}
						y2={Y(tv)}
						stroke={tv === 0 ? GRID_ZERO : GRID}
						strokeWidth="1"
					/>
					<text
						x={pad.l - 8}
						y={Y(tv) + 3.5}
						textAnchor="end"
						fontSize="9.5"
						fill={AXIS_TEXT}
						className="font-mono"
					>
						{formatSignedWan(Math.round(tv))}
					</text>
				</g>
			))}
			{data.map((v, i) =>
				// null 的那天不画柱子 —— 留白就是「没记录」,画一根零高柱会被读成「没涨粉」。
				v === null ? null : (
					<rect
						key={days[i]}
						x={X(i) - bw / 2}
						y={Math.min(Y(v), zeroY)}
						width={bw}
						height={Math.max(1.2, Math.abs(zeroY - Y(v)))}
						rx="1.5"
						fill={v >= 0 ? POS : NEG}
						opacity="0.82"
					>
						<title>{`${days[i]} ${formatSignedWan(v)}`}</title>
					</rect>
				),
			)}
			{xLabels.map((l, i) =>
				l ? (
					<text key={l} x={X(i)} y={height - 6} textAnchor="middle" fontSize="9.5" fill={AXIS_TEXT}>
						{l}
					</text>
				) : null,
			)}
		</svg>
	);
}

/**
 * 六维雷达。`value` 已由 `buildRadarAxes` 归一化到 0..1,`null` = 该维度无记录。
 *
 * 无记录的轴画在圆心,但轴线改虚线、标签置灰并写「无记录」—— 位置上和真实的 0
 * 重合是没办法的事(半径没有第三种状态),只能靠标注把两者分开。
 */
export function RadarChart({
	axes,
	color,
	size = 220,
}: {
	axes: RadarAxis[];
	color: string;
	size?: number;
}) {
	const n = axes.length;
	if (n < 3) return <ChartEmpty hint="维度不足,无法绘制画像" />;
	const cx = size / 2;
	const cy = size / 2 + 4;
	// 每根轴要写两行(维度名 + 原始值),比单行时多留一圈边距。
	const R = size / 2 - 52;
	const ang = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
	const pt = (i: number, r: number): [number, number] => [
		cx + Math.cos(ang(i)) * R * r,
		cy + Math.sin(ang(i)) * R * r,
	];
	const rings = [0.25, 0.5, 0.75, 1];
	const poly = (r: number) =>
		axes
			.map((_, i) =>
				pt(i, r)
					.map((x) => x.toFixed(1))
					.join(","),
			)
			.join(" ");
	// 不设下限:真实的 0 就该落在圆心。旧实现兜了个 0.05,于是「一次都没投稿」
	// 也会支出一小截,读起来像「有一点」。
	const dataPts = axes.map((a, i) => pt(i, Math.max(0, Math.min(1, a.value ?? 0))));

	return (
		<svg
			width={size}
			height={size}
			style={{ display: "block", margin: "0 auto", maxWidth: "100%", overflow: "visible" }}
		>
			<title>能力画像</title>
			{rings.map((r) => (
				<polygon key={r} points={poly(r)} fill="none" stroke={GRID} strokeWidth="1" />
			))}
			{axes.map((a, i) => {
				const [x, y] = pt(i, 1);
				return (
					<line
						key={a.label}
						x1={cx}
						y1={cy}
						x2={x}
						y2={y}
						stroke={GRID}
						strokeWidth="1"
						strokeDasharray={a.value === null ? "2 3" : undefined}
					/>
				);
			})}
			<polygon
				points={dataPts.map((p) => p.map((x) => x.toFixed(1)).join(",")).join(" ")}
				fill={color}
				fillOpacity="0.18"
				stroke={color}
				strokeWidth="2"
				strokeLinejoin="round"
			/>
			{axes.map((a, i) => {
				const [x, y] = pt(i, 1.24);
				const anchor = Math.abs(x - cx) < 10 ? "middle" : x > cx ? "start" : "end";
				const missing = a.value === null;
				return (
					<g key={a.label}>
						<text
							x={x}
							y={y}
							textAnchor={anchor}
							fontSize="10.5"
							fontWeight="600"
							fill={missing ? GRID_ZERO : AXIS_TEXT}
						>
							{a.label}
						</text>
						{/* 半径只表达「组内第几」,真实数值必须并排给出,否则读者无从判断
						    一根满格的轴到底是 100 万粉还是 3 篇投稿。 */}
						<text
							x={x}
							y={y + 11}
							textAnchor={anchor}
							fontSize="9.5"
							fill={missing ? GRID_ZERO : color}
							fontWeight={missing ? "400" : "700"}
							className="font-mono"
						>
							{a.display}
						</text>
					</g>
				);
			})}
		</svg>
	);
}

export interface HeatRow {
	uid: string;
	name: string;
	color: string;
	/** 每格一天的活跃强度 0..4;`null` = 那天没有记录。 */
	cells: ReadonlyArray<number | null>;
}

/** 活跃热力图。每格一天,颜色越深越活跃。 */
export function Heatmap({
	rows,
	days,
	minCellH = 16,
	maxCellH = 44,
	gap = 3,
}: {
	rows: HeatRow[];
	/** 与每行 cells 等长的本地日,提供 React key 与逐格 tooltip。 */
	days: readonly string[];
	/** 行高下限:订阅多时格子再挤也保持可点。 */
	minCellH?: number;
	/**
	 * 行高上限:只订阅一两个 UP 时,不加限制会把单行拉成一条巨粗的色带,
	 * 反而看不出「每格一天」的语义。
	 */
	maxCellH?: number;
	gap?: number;
}) {
	if (!rows.length) return <ChartEmpty hint="还没有订阅任何 UP 主" />;
	return (
		// 行用 flex-1 吃满面板高度(见 GlassPanel 的 flex-col 注释),避免下方留一大片空白;
		// 上下限之间靠 justify-center 把富余空间均摊到两头。
		<div className="flex h-full flex-col justify-center gap-1.5">
			{rows.map((r) => (
				<div
					key={r.uid}
					className="flex flex-1 items-stretch gap-2.5"
					// 内联的 min-height 会盖掉任何 min-h-* 类,这里就是唯一的下限来源。
					style={{ minHeight: minCellH, maxHeight: maxCellH }}
				>
					<div className="flex w-20 shrink-0 items-center gap-1.5">
						<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
						<span className="truncate text-xs font-semibold text-bn-text-primary">{r.name}</span>
					</div>
					<div className="flex flex-1" style={{ gap }}>
						{r.cells.map((v, i) => (
							<div
								key={`${r.uid}-${days[i]}`}
								title={`${days[i]} · ${v === null ? "无记录" : `活跃度 ${v}/4`}`}
								className="flex-1 rounded-sm"
								// 无记录 = 空心描边,有记录 = 实心。口径在 heatCellStyle 里,有测试守着。
								style={heatCellStyle(v, r.color)}
							/>
						))}
					</div>
				</div>
			))}
			{/* 底部时间刻度 —— 没有它就看不出热力图横轴跨了多久。 */}
			<div className="mt-2.5 flex shrink-0">
				<div className="w-20 shrink-0" />
				<div className="flex flex-1 justify-between font-mono text-[9.5px] text-bn-text-secondary">
					{heatAxisLabels(days.length).map((label, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 固定 4 个刻度,位置即身份
						<span key={i}>{label}</span>
					))}
				</div>
			</div>
		</div>
	);
}

/** 环形占比图。 */
export function Donut({
	value,
	size = 104,
	color,
	stroke = 13,
	label,
}: {
	value: number;
	size?: number;
	color: string;
	stroke?: number;
	label?: React.ReactNode;
}) {
	const r = (size - stroke) / 2;
	const c = 2 * Math.PI * r;
	return (
		<div className="relative" style={{ width: size, height: size }}>
			<svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
				<title>占比</title>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					stroke="var(--color-bn-code-bg)"
					strokeWidth={stroke}
				/>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					stroke={color}
					strokeWidth={stroke}
					strokeLinecap="round"
					strokeDasharray={`${c * Math.max(0, Math.min(1, value))} ${c}`}
				/>
			</svg>
			{label ? (
				<div className="absolute inset-0 flex items-center justify-center">{label}</div>
			) : null}
		</div>
	);
}
