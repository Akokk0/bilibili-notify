import { packageText } from "@bilibili-notify/internal/texts";
/** @jsxImportSource vue */

/**
 * 直播卡的块库。
 *
 * 每块只画**结构**:元素、它们的嵌套、撑住布局的那几个 class(`flex` / `w-full` / `block` …)。
 * 它**长什么样**(字号、字色、圆角、胶囊底色、头像尺寸)一概不在这里 —— 全写在出厂默认
 * 皮肤各块的 CSS 里(ADR-0014 决策 7 的 2026-09-19 🔗):一份皮肤 JSON 就是卡片的全部样子,
 * 渲染器不留一层「默认外观」让皮肤去盖。`__tests__/blocks-bare.test.ts` 扫源码钉着这一点。
 *
 * 挂点(ADR-0014 决策 9):`self` 是渲染器包在块外面的 wrapper,块的**根**另挂一个按「它是
 * 什么」取名的挂点(`image` / `text` / `pill` / `line`),默认皮肤的外观规则就写在它上面;
 * 名字取自 `CARD_SKIN_BUILTIN_BLOCKS.live[<块>].hooks`,是对外 API(`__tests__/card-hooks.test.ts`
 * 两头钉着:块内出现的挂点必须都在目录里,目录里的挂点也必须真被挂上)。
 *
 * 数据区那几件(currentViewers / likes / category / followers / totalViewers)**取代了**原来的
 * `showPopularity` / `showArea` / `showFans` 三个开关(ADR-0014 决策 16 的 🔗,开关已退役):块级的 `showIf`
 * 管不到复合块内部的一行,所以改成「想少显示哪件就删哪块」。
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.live`,一个不多一个不少(`__tests__/card-blocks.test.ts`
 * 对表钉着)。
 *
 * 唯一留在 inline 的 CSS 变量是 `--bn-live-status-color`(直播状态角标的底色:直播中粉 /
 * 已下播·未开播灰)—— 它是**数据**不是外观,由状态算出来,皮肤在 `pill` 的规则里用
 * `var(--bn-live-status-color)` 引它。
 */

import { DIVIDER_TYPE } from "@bilibili-notify/internal";
import type { LiveCardView } from "../templates/live-card";
import type { BlockRenderer } from "./types";

/** 开播与直播中在卡上是同一种样子(角标、数据区都一样),只差那句时间 —— 那句由入口算好。 */
function isOnAir(p: LiveCardView): boolean {
	return p.status === "start" || p.status === "streaming";
}

function statusLabel(p: LiveCardView): { text: string; bg: string } {
	if (isOnAir(p)) return { text: packageText("image.blocks.live.1"), bg: "#FF6699" };
	if (p.status === "end") return { text: packageText("image.blocks.live.2"), bg: "#aaa" };
	return { text: packageText("image.blocks.live.3"), bg: "#aaa" };
}

/**
 * 头像(原子块)。`object-cover` 是裁法不是样子:尺寸与圆由皮肤的 `image` 规则说。
 * 没有头像地址就整块收起(见 `LiveCardInput.creator`:拿不到引用就不给)。
 */
const creatorAvatar: BlockRenderer<LiveCardView> = (p) =>
	p.creatorAvatarUrl ? (
		<img
			data-bn="image"
			class="object-cover shrink-0"
			src={p.creatorAvatarUrl}
			alt={packageText("image.blocks.live.4")}
		/>
	) : null;

/** 主播名(原子块)。 */
const creatorName: BlockRenderer<LiveCardView> = (p) => <span data-bn="text">{p.creatorName}</span>;

/** 开播时间(原子块)。 */
const time: BlockRenderer<LiveCardView> = (p) => <span data-bn="text">{p.time}</span>;

/**
 * 数据区五件(在看人数 / 点赞 / 分类 / 粉丝数 / 累计观看)。每块只画**一样东西**、各自只在该出现的状态下有内容
 * (㉔c:从前的 `popularity` / `fans` 两块随状态换含义,现在各拆成两块)。那一格没有数就收起,不留一个只有
 * 前缀的空行 —— B 站那头恒给,拓展没报的话同理。
 *
 * 在看人数与点赞(以及分类)那几个 span 带 `block`,这不是样子而是复刻复合块里的既有行为:顶行曾是 `flex`,
 * 那几个 span 作为 flex item 本就被块化了(行盒按自己的字号算);原子块的 wrapper 是普通块容器,
 * span 若还留在行内,行盒会被 wrapper 继承来的基准字号撑高。粉丝数与累计观看是 div,本来就是块。
 *
 * 状态口径(ADR-0019 决策 76):在看人数开播 / 直播中 / 没在播都有(下播那一刻的在线人数概括不了这一场,所以
 * 下播不画);点赞与累计观看只有下播;粉丝数只有开播 / 直播中。粉丝数变化**不上默认卡**(它进下播文案;
 * 皮肤契约的 `stats.followersDelta` 照给,想画的皮肤自己画)。
 */
const stat =
	(
		visible: (p: LiveCardView) => boolean,
		textOf: (p: LiveCardView) => string,
		Tag: "span" | "div",
	): BlockRenderer<LiveCardView> =>
	(p) => {
		const text = visible(p) ? textOf(p) : "";
		if (!text) return null;
		return Tag === "span" ? (
			<span data-bn="text" class="block">
				{text}
			</span>
		) : (
			<div data-bn="text">{text}</div>
		);
	};

/** 在看人数(原子块):下播以外的状态。 */
const currentViewers = stat(
	(p) => p.status !== "end",
	(p) => (p.currentViewers ? packageText("image.blocks.live.5", { value0: p.currentViewers }) : ""),
	"span",
);

/** 点赞(原子块):只有下播。 */
const likes = stat(
	(p) => p.status === "end",
	(p) => (p.likes ? packageText("image.blocks.live.6", { value0: p.likes }) : ""),
	"span",
);

/** 分类(原子块)。没有分类就收起 —— 拓展可以不报,不留一个「分区：」后面什么都没有。 */
const category = stat(
	() => true,
	(p) => (p.category ? packageText("image.blocks.live.7", { value0: p.category }) : ""),
	"span",
);

/** 粉丝数(原子块):开播 / 直播中。 */
const followers = stat(
	isOnAir,
	(p) => (p.followers ? packageText("image.blocks.live.8", { value0: p.followers }) : ""),
	"div",
);

/** 累计观看(原子块):只有下播。 */
const totalViewers = stat(
	(p) => p.status === "end",
	(p) => (p.totalViewers ? packageText("image.blocks.live.9", { value0: p.totalViewers }) : ""),
	"div",
);

/**
 * live 卡的块表。每块返回内层 VNode(无 `data-block` —— 由 `renderBlocks` 的 wrapper
 * 统一加),无数据时返回 null 自动收起。divider 是可重复的分割线块。
 */
export const LIVE_BLOCKS: Record<string, BlockRenderer<LiveCardView>> = {
	[DIVIDER_TYPE]: () => <div data-bn="line" />,

	// 没有真封面时 `p.cover` 已经是占位图(`buildLiveCardView` 给的),这里照画、不收起 ——
	// 想没封面就整格收起的皮肤自己挂 `showIf: "live.hasCover"`。
	cover: (p) => (
		<img
			data-bn="image"
			// `h-full object-cover`:皮肤给这块声明了跨行时,wrapper 会拿到真高度
			// (`heightFromRows`),图得跟着填满、按比例裁。没声明高度时 `height:100%` 的
			// 百分比没有参照物,浏览器当 auto 办 —— 所以这两个 class 对老皮肤是零影响。
			class="block w-full h-full object-cover"
			src={p.cover}
			alt={packageText("image.blocks.live.10")}
		/>
	),

	// 从前这颗角标是封面块里 `position:absolute` 的一个孩子。现在它自己是一块,与封面占
	// 同一片格子、层次更高,贴哪个角由皮肤的 `align-self` / `justify-self` / `margin` 说 ——
	// 所以这里**不写定位**,只画角标本身;它的高度 / 圆角 / 字号也归皮肤的 `pill` 规则。
	status: (p) => {
		const status = statusLabel(p);
		return (
			<div
				data-bn="pill"
				class="inline-flex items-center"
				style={{ "--bn-live-status-color": status.bg }}
			>
				{status.text}
			</div>
		);
	},

	title: (p) => <div data-bn="text">{p.title}</div>,

	description: (p) => (
		<div data-bn="text">{p.description || packageText("image.blocks.live.11")}</div>
	),

	creatorAvatar,
	creatorName,
	time,
	currentViewers,
	likes,
	category,
	followers,
	totalViewers,
};
