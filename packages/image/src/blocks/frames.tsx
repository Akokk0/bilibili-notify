/** @jsxImportSource vue */

/**
 * 七种卡的**外框**(ADR-0014 决策 6 的「根块」)—— 玻璃层以外那一层 + 玻璃层本身。
 *
 * 块库把「卡片里画什么」拆成了块,这份把「卡片长什么样的壳」也拆出来。出图只有皮肤
 * 渲染器一条路(ADR-0014 决策 24 的 2026-09-18 🔗:整卡模板已退役),所以这七个外框
 * **只有 `renderSkinnedCard` 一个调用方**。
 *
 * 与块库同规矩(ADR-0014 决策 7 的 2026-09-19 🔗):**这里只画结构** —— 两层 div、它们的
 * 嵌套、撑住布局的那几个 class(`h-auto` / `flex` / `w-full` / `overflow-hidden`)。卡宽卡高、
 * 内边距、圆角、那圈阴影、底色与白纱全写在出厂默认皮肤各卡的 `css` 里(`[data-bn="frame"]`
 * 与 `[data-bn="glass"]` 两条规则),`__tests__/blocks-bare.test.ts` 扫源码钉着。
 *
 * 外框**一个字节的外观都不 inline**(ADR-0014 决策 15 的 🔗):清洗器一律摘掉皮肤 CSS 里的
 * `!important`,inline 声明皮肤永远压不过 —— 底色写在这儿的话,换皮肤就改不动它。
 *
 * 两处**纯附加**:外层挂 `data-bn="frame"`、玻璃层挂 `data-bn="glass"`
 * (`CARD_SKIN_FRAME_HOOKS`,皮肤 CSS 的根级挂点)。
 *
 * `extra` 是皮肤渲染器**必给**的三样:
 * - `frame` 往外层注皮肤变量(`--bn-card-*`)与旋钮声明;
 * - `glass` 把玻璃层变成 12 列网格容器(`display:grid` …);
 * - `width` 只有锐评两张卡用得上(它们的宽度写在外框 inline style 里,不像别的卡靠
 *   `renderCard` 的 htmlWidth)。
 *
 * ⚠️ **inline style 的写法(数组 / 字符串)按现状钉死,别顺手拉平**:Vue 的
 * `ssrRenderStyle` 对字符串是原样透传,对数组会 `normalizeStyle` 重新解析再拼回去 ——
 * 同一份声明串两种写法未必产出同样的字节,而出图的基准是逐字节比的。所以外层自带声明的
 * 用数组(`[对象, extra.frame]`),不自带的也写成数组;玻璃层今天是什么形态就留什么形态。
 *
 * ⚠️ 外框写成**普通函数**而不是组件:Vue 的函数式组件把 children 送进 slots 而不是 props,
 * 写成 `<CardFrame>…</CardFrame>` 时 `p.children` 恒为 undefined,卡片会渲染出一个完全空的
 * 外框(而且构建全绿,只在看图时才发现)。
 */

import type { CardSkinKind } from "@bilibili-notify/internal";
import type { VNode } from "vue";
import type { DynamicCardProps } from "../templates/dynamic-card";
import type { GuardCardProps } from "../templates/guard-card";
import type { LiveCardProps } from "../templates/live-card";
import type { RoastBoardCardProps, RoastSoloCardProps } from "../templates/roast-card";
import type { SCCardProps } from "../templates/sc-card";
import type { WordCloudCardProps } from "../templates/wordcloud-card";

/** 皮肤渲染器往外框上追加的东西。 */
export interface FrameExtra {
	/** 追加到**外层** inline style 的声明串 —— 皮肤变量与旋钮声明走这里。 */
	frame?: string;
	/** 追加到**玻璃层** inline style 的声明串 —— 网格容器(`display:grid` …)走这里。 */
	glass?: string;
	/** 卡宽 px。只有锐评两张卡的外框自带宽度,其余卡的宽度由 `renderCard` 的 htmlWidth 定。 */
	width?: number;
}

/**
 * 一种卡的外框:吃玻璃层里的孩子与那两串 inline style,画出**两层**壳。
 *
 * **不吃 props。** 从前带一个,七个外框一个都没读(外观整批归了皮肤 CSS),留着的理由写的是
 * 「哪天某种卡的结构又要看数据,从这里拿」—— 而那个留着的钩子撑着调用处一句 `as`:
 * `FRAMES[kind]` 在泛型卡种下签不齐,只能 cast 过去,于是**唯一那个调用点的类型检查是关着的**。
 * 真到了「某种卡要读 props」那天,传错 props 的那一次会静默通过。
 *
 * 档位这件事今天已经有答案:`bgColor` 由 `frameVariables` 注成 `--bn-card-tier-color`,
 * 皮肤 CSS 自己按变量变;结构要动那是块与网格的活,外框只有两层壳。
 */
export type FrameRenderer = (children: VNode | VNode[], extra: FrameExtra) => VNode;

/** 卡种 → 它的 props。皮肤渲染器吃的 props 与块库是同一份。 */
export interface CardPropsByKind {
	live: LiveCardProps;
	dynamic: DynamicCardProps;
	sc: SCCardProps;
	guard: GuardCardProps;
	roastBoard: RoastBoardCardProps;
	roastSolo: RoastSoloCardProps;
	wordcloud: WordCloudCardProps;
}

/**
 * 档位色两张卡(醒目留言 / 上舰)共用的外框 —— 逐字符相同,只有玻璃层的排布 class 不同。
 *
 * class 拿常量传进来而不是写死在两处:`__tests__/blocks-bare.test.ts` 的扫描器除了
 * `class="…"` 还认 `*_CLASS = "…"` 这个命名(`blocks/dynamic.tsx` 的 `STAT_ATOM_CLASS`
 * 立的规矩)—— 换个名字这两串 class 就从守卫眼皮底下消失了。
 */
const SC_GLASS_CLASS = "flex flex-col items-center";
const GUARD_GLASS_CLASS = "flex items-center";

function tierFrame(glassClass: string, children: VNode | VNode[], extra: FrameExtra): VNode {
	return (
		<div data-bn="frame" class="flex justify-center items-center" style={[extra.frame]}>
			<div data-bn="glass" class={glassClass} style={[extra.glass]}>
				{children}
			</div>
		</div>
	);
}

/** 锐评两张卡共用的外框 —— 只有宽度不同。 */
function roastFrame(children: VNode | VNode[], defaultWidth: number, extra: FrameExtra): VNode {
	return (
		<div data-bn="frame" style={[{ width: `${extra.width ?? defaultWidth}px` }, extra.frame]}>
			<div data-bn="glass" class="overflow-hidden" style={[extra.glass]}>
				{children}
			</div>
		</div>
	);
}

/**
 * 七种卡的外框表。**玻璃层里铺什么由调用方决定** —— 皮肤渲染器铺的是网格里的块 wrapper。
 *
 * ⛔ **`live` 与 `wordcloud` 今天逐字符相同,别合。** 2026-09-20 拍板过:它俩从前不一样
 * (各自带 `ownBg` / `ownGlass` 兜底),这一轮外观整批归了皮肤 CSS、兜底删光,剩下的骨架
 * 才重合 —— 是**删出来的结果**,不是有人决定过这两种卡该同形。合成一份等于替产品宣布
 * 「开播卡和词云卡的壳从此永远一样」;哪天词云要换更宽的壳或加一圈出血,得先把合并拆
 * 回来,而那时未必有人记得当初合并只是因为「那天它俩正好一样」。
 */
export const FRAMES: Record<CardSkinKind, FrameRenderer> = {
	live: (children, extra) => (
		<div data-bn="frame" class="h-auto" style={[extra.frame]}>
			<div data-bn="glass" class="overflow-hidden" style={extra.glass ?? ""}>
				{children}
			</div>
		</div>
	),

	dynamic: (children, extra) => (
		<div data-bn="frame" class="h-auto" style={[{ minWidth: "380px" }, extra.frame]}>
			<div data-bn="glass" class="w-full overflow-hidden" style={extra.glass ?? ""}>
				{children}
			</div>
		</div>
	),

	sc: (children, extra) => tierFrame(SC_GLASS_CLASS, children, extra),
	guard: (children, extra) => tierFrame(GUARD_GLASS_CLASS, children, extra),

	roastBoard: (children, extra) => roastFrame(children, 600, extra),
	roastSolo: (children, extra) => roastFrame(children, 430, extra),

	wordcloud: (children, extra) => (
		<div data-bn="frame" class="h-auto" style={[extra.frame]}>
			<div data-bn="glass" class="overflow-hidden" style={extra.glass ?? ""}>
				{children}
			</div>
		</div>
	),
};
