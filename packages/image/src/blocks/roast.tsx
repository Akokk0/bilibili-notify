/** @jsxImportSource vue */

/**
 * AI 锐评卡的块库 —— 榜单周报与单人锐评各一张表,各自只有一个 `body` 块。
 *
 * `body` 是从 `templates/roast-card.tsx` **原样搬**进来的那个 Fragment(玻璃层里的整段正文,
 * 含标题行 / 分割线 / 榜单 / 评分条),class、inline style、文案一个字都没动;外框
 * (`cardFrame`)仍留在模板里。这两张卡在 `CARD_SKIN_BUILTIN_BLOCKS` 里整张就是一个内置块,
 * 所以没有原子块可抠。
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.roastBoard` / `.roastSolo`,一个不多一个不少
 * (`__tests__/card-blocks.test.ts` 对表钉着)。
 */

import { SVG_CHART_BARS, SVG_FEATHER, SVG_TROPHY } from "../icons";
import type { RoastBoardCardProps, RoastCardUp, RoastSoloCardProps } from "../templates/roast-card";
import type { BlockRenderer } from "./types";

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

function Divider() {
	return <div class="mx-[16px] h-px" style="background: rgba(0,0,0,0.07);" />;
}

/**
 * 评分条一行。
 *
 * 榜单卡多行并列,名字列**定宽**,免得长短名把进度条起点参差不齐地推来推去。
 * 单人卡只有一行,没有对齐对象 —— 定宽只会白白把名字截成「极客湾Geeker…」,
 * 所以传 `autoName` 让它按内容撑开;再用 max-width 兜底,免得超长名把条挤没。
 */
function ScoreRow(p: { up: RoastCardUp; score: number; autoName?: boolean }) {
	return (
		<div class="flex items-center gap-[8px]">
			<span
				class={`${p.autoName ? "max-w-[46%]" : "w-[120px]"} shrink-0 truncate text-[12px] font-semibold`}
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

/** 榜单周报卡的块表(整张正文一个块)。 */
export const ROAST_BOARD_BLOCKS: Record<string, BlockRenderer<RoastBoardCardProps>> = {
	body: (p) => {
		const podium = (
			[
				[SVG_FEATHER, "本期鸽王", p.pigeon, "#F85A54"],
				[SVG_TROPHY, "勤奋 UP", p.diligent, "#2AC864"],
			] as const
		).map(([icon, label, who, tone]) => (
			<div class="flex-1 rounded-[10px] p-[10px]" style="background: rgba(0,0,0,0.035);">
				<div
					class="mb-[7px] flex items-center gap-[5px] text-[11px] font-bold"
					style={{ color: tone }}
				>
					{icon}
					<span>{label}</span>
				</div>
				<div class="mb-[6px] flex items-center gap-[8px]">
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

		return (
			<>
				{/* items-center 而非 baseline:图标没有基线可对,baseline 会把它按底边墩下去。 */}
				<div class="flex items-center justify-between px-[16px] pt-[14px] pb-[11px]">
					<span
						class="flex items-center gap-[7px] text-[17px] font-bold leading-none"
						style={{ color: INK }}
					>
						{SVG_CHART_BARS}
						<span>UP 主周报</span>
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
			</>
		);
	},
};

/** 单人锐评卡的块表(整张正文一个块)。 */
export const ROAST_SOLO_BLOCKS: Record<string, BlockRenderer<RoastSoloCardProps>> = {
	body: (p) => (
		<>
			<div class="flex items-center gap-[14px] px-[16px] pt-[14px] pb-[11px]">
				<UpAvatar up={p.up} size={40} />
				<div class="flex min-w-0 flex-col gap-[4px]">
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
				<ScoreRow up={p.up} score={p.score} autoName />
			</div>

			{p.highlights.length > 0 && (
				<>
					<Divider />
					<div class="flex flex-col gap-[7px] px-[16px] pt-[12px] pb-[14px]">
						{/*
						 * items-start 不能省:flex 默认 align-items: stretch,右边点评一旦
						 * 换行,左边这块没有固定高度的标签就会被拉成两行高的长条。
						 */}
						{p.highlights.map((hl) => (
							<div class="flex items-start gap-[8px] text-[12px] leading-[1.6]">
								<span
									class="mt-[1px] shrink-0 rounded-[5px] px-[7px] py-[2px] text-[11px] font-bold text-white"
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
		</>
	),
};
