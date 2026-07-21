/** @jsxImportSource vue */

/**
 * AI 锐评卡 —— 榜单周报({@link RoastBoardCard})与单人锐评({@link RoastSoloCard})。
 *
 * 与其它卡最大的不同:正文**整段由大模型生成**,没有任何 B 站原始结构可依。所以
 * 这里一律走 JSX 文本节点(Vue 会转义),**绝不用 `innerHTML`** —— SC 卡为了保留
 * 换行用了它,那是因为文本来自 B 站弹幕且已手工转义过;模型输出没有那个前提。
 *
 * 这两张卡不接 `cardStyleByKind` 的 per-kind 样式矩阵,也没有版式编辑器:那套是
 * 「每位 UP × 每种卡」的二维覆盖,而榜单卡压根不属于任何单个 UP。配色跟词云卡
 * 同源,直接吃全局 `cardStyle`。
 */

export type RoastCardUp = {
	name: string;
	/** B 站头像 URL(渲染前已内联成 data URL);缺省时退回首字母圆牌。 */
	avatar?: string;
	/** 该 UP 的强调色,来自 `colorFromUid` —— 与 dashboard 上同一位 UP 的颜色一致。 */
	color: string;
};

export type RoastBoardCardProps = {
	/** 统计窗口天数。必须标在卡上:同一份榜单在 7 日和 30 日下讲的不是一回事。 */
	days: number;
	pigeon: RoastCardUp & { reason: string };
	diligent: RoastCardUp & { reason: string };
	roast: Array<RoastCardUp & { comment: string }>;
	scores: Array<RoastCardUp & { score: number }>;
	cardColorStart: string;
	cardColorEnd: string;
	/** 玻璃片(内容层)透明度 0..1;缺省走 0.86 —— 这张卡文字密,比 live 卡再实一点。 */
	glassOpacity?: number;
	/** 完全透明:内容层透明 + 去掉毛玻璃模糊(优先于 glassOpacity)。 */
	glassClear?: boolean;
	/** 自定义背景图(已解析的 data URL / http URL);非空时替换外框渐变。 */
	backgroundImage?: string;
};

export type RoastSoloCardProps = {
	days: number;
	up: RoastCardUp;
	verdict: string;
	score: number;
	highlights: Array<{ label: string; comment: string }>;
	cardColorStart: string;
	cardColorEnd: string;
	glassOpacity?: number;
	glassClear?: boolean;
	backgroundImage?: string;
};

const INK = "#18191C";
const INK_SOFT = "#61666D";

/** 进度条宽度。模板是公开入口,不指望调用方已经夹过 —— 越界会把条画到卡片外。 */
function barWidth(score: number): string {
	return `${Math.max(0, Math.min(100, score))}%`;
}

/** 头像:有图用图,没图退首字母圆牌。展开成码点数组,免得 emoji 名字被劈成半个代理对。 */
function UpAvatar(p: { up: RoastCardUp; size: number }) {
	const box = { width: `${p.size}px`, height: `${p.size}px` };
	if (p.up.avatar) {
		return (
			<img class="rounded-full object-cover shrink-0" style={box} src={p.up.avatar} alt="头像" />
		);
	}
	return (
		<div
			class="flex shrink-0 items-center justify-center rounded-full font-bold text-white"
			style={{ ...box, background: p.up.color, fontSize: `${Math.round(p.size * 0.44)}px` }}
		>
			{[...p.up.name][0] ?? "?"}
		</div>
	);
}

type FrameStyle = {
	cardColorStart: string;
	cardColorEnd: string;
	glassOpacity?: number;
	glassClear?: boolean;
	backgroundImage?: string;
};

/**
 * 外框 + 玻璃片。两张卡唯一共用的结构。
 *
 * 写成**普通函数**而不是组件,是因为 Vue 的函数式组件把 children 送进 slots 而
 * 不是 props —— 写成 `<CardFrame>…</CardFrame>` 时 `p.children` 恒为 undefined,
 * 卡片会渲染出一个完全空的外框(而且构建全绿,只在看图时才发现)。
 */
function cardFrame(p: FrameStyle & { width: number }, children: unknown) {
	const glass = p.glassClear ? 0 : (p.glassOpacity ?? 0.86);
	const blur = p.glassClear ? 0 : 10;
	return (
		<div
			class="p-[15px]"
			style={{
				width: `${p.width}px`,
				background: p.backgroundImage
					? `url("${p.backgroundImage}") center / cover`
					: `linear-gradient(to right bottom, ${p.cardColorStart}, ${p.cardColorEnd})`,
			}}
		>
			<div
				class="overflow-hidden rounded-[12px]"
				style={{
					background: `rgba(255,255,255,${glass})`,
					backdropFilter: `blur(${blur}px)`,
					boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
				}}
			>
				{children}
			</div>
		</div>
	);
}

function Divider() {
	return <div class="mx-[16px] h-px" style="background: rgba(0,0,0,0.07);" />;
}

/** 评分条一行。名字列定宽,免得长短名把进度条起点参差不齐地推来推去。 */
function ScoreRow(p: { up: RoastCardUp; score: number }) {
	return (
		<div class="flex items-center gap-[8px]">
			<span
				class="w-[92px] shrink-0 truncate text-[12px] font-semibold"
				style={{ color: INK }}
				title={p.up.name}
			>
				{p.up.name}
			</span>
			<div
				class="h-[10px] flex-1 overflow-hidden rounded-full"
				style="background: rgba(0,0,0,0.06);"
			>
				<div
					class="h-full rounded-full"
					style={{ width: barWidth(p.score), background: p.up.color }}
				/>
			</div>
			<span class="w-[26px] shrink-0 text-right text-[12px] font-bold" style={{ color: INK_SOFT }}>
				{Math.round(p.score)}
			</span>
		</div>
	);
}

export function RoastBoardCard(p: RoastBoardCardProps) {
	const podium = (
		[
			["🕊️ 本期鸽王", p.pigeon, "#F85A54"],
			["🏆 勤奋 UP", p.diligent, "#2AC864"],
		] as const
	).map(([label, who, tone]) => (
		<div class="flex-1 rounded-[10px] p-[10px]" style="background: rgba(0,0,0,0.035);">
			<div class="mb-[7px] text-[11px] font-bold" style={{ color: tone }}>
				{label}
			</div>
			<div class="mb-[6px] flex items-center gap-[6px]">
				<UpAvatar up={who} size={26} />
				<span class="truncate text-[14px] font-bold" style={{ color: INK }}>
					{who.name}
				</span>
			</div>
			<div class="text-[11.5px] leading-[1.55]" style={{ color: INK_SOFT }}>
				{who.reason}
			</div>
		</div>
	));

	return cardFrame({ ...p, width: 600 }, [
		<>
			<div class="flex items-baseline justify-between px-[16px] pt-[14px] pb-[11px]">
				<span class="text-[17px] font-bold leading-none" style={{ color: INK }}>
					📊 UP 主周报
				</span>
				<span class="text-[12px]" style={{ color: INK_SOFT }}>
					近 {p.days} 天 · 智能女仆锐评
				</span>
			</div>
			<Divider />

			<div class="flex gap-[10px] px-[16px] py-[12px]">{podium}</div>

			{p.roast.length > 0 && (
				<>
					<Divider />
					<div class="px-[16px] py-[12px]">
						<div class="mb-[8px] text-[11px] font-bold" style={{ color: INK_SOFT }}>
							逐位锐评
						</div>
						<div class="flex flex-col gap-[6px]">
							{p.roast.map((r) => (
								<div class="flex gap-[7px] text-[12px] leading-[1.6]">
									<span
										class="mt-[6px] h-[6px] w-[6px] shrink-0 rounded-full"
										style={{ background: r.color }}
									/>
									<div>
										<span class="font-bold" style={{ color: INK }}>
											{r.name}
										</span>{" "}
										<span style={{ color: INK_SOFT }}>{r.comment}</span>
									</div>
								</div>
							))}
						</div>
					</div>
				</>
			)}

			{p.scores.length > 0 && (
				<>
					<Divider />
					<div class="px-[16px] pt-[12px] pb-[14px]">
						<div class="mb-[9px] text-[11px] font-bold" style={{ color: INK_SOFT }}>
							综合勤奋度评分 · 0–100
						</div>
						<div class="flex flex-col gap-[7px]">
							{[...p.scores]
								.sort((a, b) => b.score - a.score)
								.map((s) => (
									<ScoreRow up={s} score={s.score} />
								))}
						</div>
					</div>
				</>
			)}
		</>,
	]);
}

export function RoastSoloCard(p: RoastSoloCardProps) {
	return cardFrame({ ...p, width: 430 }, [
		<>
			<div class="flex items-center gap-[10px] px-[16px] pt-[14px] pb-[11px]">
				<UpAvatar up={p.up} size={40} />
				<div class="flex min-w-0 flex-col gap-[3px]">
					<span class="truncate text-[16px] font-bold leading-none" style={{ color: INK }}>
						{p.up.name}
					</span>
					<span class="text-[11.5px]" style={{ color: INK_SOFT }}>
						近 {p.days} 天 · 智能女仆锐评
					</span>
				</div>
			</div>
			<Divider />

			<div class="px-[16px] py-[13px]">
				<div class="text-[13.5px] leading-[1.65] font-semibold" style={{ color: INK }}>
					{p.verdict}
				</div>
			</div>
			<Divider />

			<div class="px-[16px] py-[12px]">
				<div class="mb-[8px] text-[11px] font-bold" style={{ color: INK_SOFT }}>
					综合勤奋度 · 0–100
				</div>
				<ScoreRow up={p.up} score={p.score} />
			</div>

			{p.highlights.length > 0 && (
				<>
					<Divider />
					<div class="flex flex-col gap-[7px] px-[16px] pt-[12px] pb-[14px]">
						{p.highlights.map((hl) => (
							<div class="flex gap-[8px] text-[12px] leading-[1.6]">
								<span
									class="shrink-0 rounded-[5px] px-[7px] py-[2px] text-[11px] font-bold text-white"
									style={{ background: p.up.color }}
								>
									{hl.label}
								</span>
								<span style={{ color: INK_SOFT }}>{hl.comment}</span>
							</div>
						))}
					</div>
				</>
			)}
		</>,
	]);
}
