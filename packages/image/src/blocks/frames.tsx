/** @jsxImportSource vue */

/**
 * 七种卡的**外框**(ADR-0014 决策 6 的「根块」)—— 玻璃层以外那一层 + 玻璃层本身。
 *
 * 块库把「卡片里画什么」拆成了块,这份把「卡片长什么样的壳」也拆出来:模板路径与皮肤路径
 * 从此共用同一个外框,不会出现「模板改了圆角、皮肤还是旧的」。里头的 JSX 是从
 * `templates/*.tsx` **原样搬**进来的,class、inline style、默认玻璃透明度一个字都没动 ——
 * 基准快照(`__tests__/card-baseline.test.ts`)逐字节钉着这一点。
 *
 * 两处**纯附加**:外层挂 `data-bn="frame"`、玻璃层挂 `data-bn="glass"`
 * (`CARD_SKIN_FRAME_HOOKS`,皮肤 CSS 的根级挂点)。基准比较前会剥掉 `data-bn`,所以
 * 不影响「逐字节」。
 *
 * `extra` 是**皮肤路径专用**的附加:
 * - `glass` 把玻璃层变成 12 列网格容器(模板路径不传 → 玻璃层与今天一模一样);
 * - `frame` 往外层注皮肤变量(`--bn-card-*`);
 * - `width` 只有锐评两张卡用得上(它们的宽度写在外框 inline style 里,不像别的卡靠
 *   `renderCard` 的 htmlWidth)。
 *
 * inline style 一律用**数组形式**(`[对象, extra]`)或**字符串拼接**:`extra` 为
 * undefined 时 Vue 的 `normalizeStyle` 直接跳过它,序列化结果与今天逐字节相同。
 */

import type { CardSkinKind } from "@bilibili-notify/internal";
import type { VNode } from "vue";
import type { DynamicCardProps } from "../templates/dynamic-card";
import type { GuardCardProps } from "../templates/guard-card";
import type { LiveCardProps } from "../templates/live-card";
import type { RoastBoardCardProps, RoastSoloCardProps } from "../templates/roast-card";
import type { SCCardProps } from "../templates/sc-card";
import type { WordCloudCardProps } from "../templates/wordcloud-card";

/** 皮肤路径往外框上追加的东西。模板路径一概不传。 */
export interface FrameExtra {
	/** 追加到**外层**(渐变 / 背景图那层)inline style 的声明串 —— 皮肤变量走这里。 */
	frame?: string;
	/** 追加到**玻璃层** inline style 的声明串 —— 网格容器(`display:grid` …)走这里。 */
	glass?: string;
	/** 卡宽 px。只有锐评两张卡的外框自带宽度,其余卡的宽度由 `renderCard` 的 htmlWidth 定。 */
	width?: number;
}

/** 一种卡的外框:吃该卡种的 props 与玻璃层里的孩子,画出**两层**壳。 */
export type FrameRenderer<P> = (props: P, children: VNode | VNode[], extra?: FrameExtra) => VNode;

/** 卡种 → 它的模板 props。皮肤渲染器吃的 props 与模板是同一份。 */
export interface CardPropsByKind {
	live: LiveCardProps;
	dynamic: DynamicCardProps;
	sc: SCCardProps;
	guard: GuardCardProps;
	roastBoard: RoastBoardCardProps;
	roastSolo: RoastSoloCardProps;
	wordcloud: WordCloudCardProps;
}

/** 外框自带的渐变 / 背景图那一句 —— 四种卡各自的 props 里颜色字段名不同,值算法相同。 */
function frameBg(backgroundImage: string | undefined, start: string, end: string): string {
	return backgroundImage
		? `url("${backgroundImage}") center / cover`
		: `linear-gradient(to right bottom, ${start}, ${end})`;
}

/** 玻璃层的白纱与模糊。`glassClear` 优先:白层透明 + 无模糊(0 透明度仍保留磨砂)。 */
function glassOf(
	p: { glassOpacity?: number; glassClear?: boolean },
	base: number,
): { glass: number; blur: number } {
	return {
		glass: p.glassClear ? 0 : (p.glassOpacity ?? base),
		blur: p.glassClear ? 0 : 10,
	};
}

/** 锐评两张卡共用的外框(原 `templates/roast-card.tsx` 的 `cardFrame`)。 */
function roastFrame(
	p: RoastBoardCardProps | RoastSoloCardProps,
	children: VNode | VNode[],
	defaultWidth: number,
	extra?: FrameExtra,
): VNode {
	const { glass, blur } = glassOf(p, 0.86);
	return (
		<div
			data-bn="frame"
			class="p-[15px]"
			style={[
				{
					width: `${extra?.width ?? defaultWidth}px`,
					background: frameBg(p.backgroundImage, p.cardColorStart, p.cardColorEnd),
				},
				extra?.frame,
			]}
		>
			<div
				data-bn="glass"
				class="overflow-hidden rounded-[12px]"
				style={[
					{
						background: `rgba(255,255,255,${glass})`,
						backdropFilter: `blur(${blur}px)`,
						boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
					},
					extra?.glass,
				]}
			>
				{children}
			</div>
		</div>
	);
}

/**
 * 七种卡的外框表。**玻璃层里铺什么由调用方决定**:模板路径铺 `renderBlocks(...)` 的结果,
 * 皮肤路径铺网格里的块 wrapper;上舰卡今天那个「内容列 + 徽章」的二分结构是旧版式专属的,
 * 留在模板里当 children 传进来。
 */
export const FRAMES: { [K in CardSkinKind]: FrameRenderer<CardPropsByKind[K]> } = {
	live: (p, children, extra) => {
		const { glass, blur } = glassOf(p, 0.82);
		return (
			<div
				data-bn="frame"
				class="h-auto p-3.75"
				style={[
					{ background: frameBg(p.backgroundImage, p.cardColorStart, p.cardColorEnd) },
					extra?.frame,
				]}
			>
				<div
					data-bn="glass"
					class="overflow-hidden rounded-xl"
					style={`background: rgba(255,255,255,${glass}); backdrop-filter: blur(${blur}px); box-shadow: 0 4px 16px rgba(0,0,0,0.12); min-width: 360px; padding-top: 14px; padding-bottom: 10px;${
						extra?.glass ?? ""
					}`}
				>
					{children}
				</div>
			</div>
		);
	},

	dynamic: (p, children, extra) => {
		const { glass, blur } = glassOf(p, 0.82);
		return (
			<div
				data-bn="frame"
				class="h-auto p-[15px]"
				style={[
					{
						background: frameBg(p.backgroundImage, p.cardColorStart, p.cardColorEnd),
						minWidth: "380px",
					},
					extra?.frame,
				]}
			>
				<div
					data-bn="glass"
					class="w-full overflow-hidden rounded-[12px]"
					style={`background: rgba(255,255,255,${glass}); backdrop-filter: blur(${blur}px); box-shadow: 0 4px 16px rgba(0,0,0,0.12); padding-top: 14px; padding-bottom: 12px;${
						extra?.glass ?? ""
					}`}
				>
					{children}
				</div>
			</div>
		);
	},

	sc: (p, children, extra) => {
		const { glass, blur } = glassOf(p, 0.75);
		return (
			<div
				data-bn="frame"
				class="flex justify-center items-center w-[290px] p-[15px]"
				style={[
					{ background: frameBg(p.backgroundImage, p.bgColor[0], p.bgColor[1]) },
					extra?.frame,
				]}
			>
				<div
					data-bn="glass"
					class="flex flex-col items-center w-[260px] px-[16px] py-5 rounded-[10px] shadow-[0_4px_8px_0_rgba(0,0,0,0.2)]"
					style={[
						{
							background: `rgba(255,255,255,${glass})`,
							backdropFilter: `blur(${blur}px)`,
						},
						extra?.glass,
					]}
				>
					{children}
				</div>
			</div>
		);
	},

	guard: (p, children, extra) => {
		const { glass, blur } = glassOf(p, 0.75);
		return (
			<div
				data-bn="frame"
				class="flex justify-center items-center w-[430px] h-[220px] p-[15px]"
				style={[
					{ background: frameBg(p.backgroundImage, p.bgColor[0], p.bgColor[1]) },
					extra?.frame,
				]}
			>
				<div
					data-bn="glass"
					class="flex items-center w-[400px] h-[190px] rounded-[10px] shadow-[0_4px_8px_0_rgba(0,0,0,0.2)]"
					style={[
						{
							background: `rgba(255,255,255,${glass})`,
							backdropFilter: `blur(${blur}px)`,
						},
						extra?.glass,
					]}
				>
					{children}
				</div>
			</div>
		);
	},

	roastBoard: (p, children, extra) => roastFrame(p, children, 600, extra),
	roastSolo: (p, children, extra) => roastFrame(p, children, 430, extra),

	wordcloud: (p, children, extra) => (
		<div
			data-bn="frame"
			class="h-auto p-[15px]"
			style={[
				{ background: `linear-gradient(to right bottom, ${p.colorStart}, ${p.colorEnd})` },
				extra?.frame,
			]}
		>
			<div
				data-bn="glass"
				class="overflow-hidden rounded-[12px]"
				style={`background: rgba(255,255,255,0.82); backdrop-filter: blur(10px); box-shadow: 0 4px 16px rgba(0,0,0,0.12);${
					extra?.glass ?? ""
				}`}
			>
				{children}
			</div>
		</div>
	),
};
