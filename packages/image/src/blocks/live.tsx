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
 * 数据区那三件(popularity / area / fans)**取代了**原来的 `showPopularity` / `showArea` /
 * `showFans` 三个开关(ADR-0014 决策 16 的 🔗,开关已退役):块级的 `showIf` 管不到复合块内部
 * 的一行,所以改成「想少显示哪件就删哪块」。
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
	if (isOnAir(p)) return { text: "直播中", bg: "#FF6699" };
	if (p.status === "end") return { text: "已下播", bg: "#aaa" };
	return { text: "未开播", bg: "#aaa" };
}

/**
 * 人气那一格:下播卡换成点赞(ADR-0019 决策 76 —— 下播那一刻的人气是散场时的在线人数,
 * 概括不了这一场),其余状态是此刻在线。那一格没有数就整行不画。
 */
function statsLeft(p: LiveCardView): string {
	if (p.status === "end") return p.likes ? `点赞：${p.likes}` : "";
	return p.online ? `人气：${p.online}` : "";
}

/**
 * 粉丝那一行:开播 / 直播中是当前粉丝数,下播是本场累计观看人数,没在播不画。粉丝数变化
 * **不上默认卡**(决策 76,它进下播文案;皮肤契约照给,想画的皮肤自己画)。
 */
function followerText(p: LiveCardView): string {
	if (isOnAir(p)) return p.fans ? `当前粉丝数：${p.fans}` : "";
	if (p.status === "end") return p.totalViewers ? `累计观看人数：${p.totalViewers}` : "";
	return "";
}

/** 头像(原子块)。`object-cover` 是裁法不是样子:尺寸与圆由皮肤的 `image` 规则说。 */
const avatar: BlockRenderer<LiveCardView> = (p) => (
	<img data-bn="image" class="object-cover shrink-0" src={p.userface} alt="主播头像" />
);

/** 主播名(原子块)。 */
const name: BlockRenderer<LiveCardView> = (p) => <span data-bn="text">{p.username}</span>;

/** 开播时间(原子块)。 */
const time: BlockRenderer<LiveCardView> = (p) => <span data-bn="text">{p.time}</span>;

/**
 * 数据区三件(人气 / 分区 / 粉丝)。
 *
 * 顶行那两个 span 带 `block`,这不是样子而是复刻复合块里的既有行为:顶行曾是 `flex`,那两个
 * span 作为 flex item 本就被块化了(行盒按自己的字号算);原子块的 wrapper 是普通块容器,
 * span 若还留在行内,行盒会被 wrapper 继承来的基准字号撑高。
 */

/**
 * 人气 / 点赞(原子块)。那一格没有数就收起 —— B 站那头恒给(人气与点赞都有初值),拓展没报
 * 的话不留一个「点赞：」后面什么都没有。
 */
const popularity: BlockRenderer<LiveCardView> = (p) => {
	const text = statsLeft(p);
	if (!text) return null;
	return (
		<span data-bn="text" class="block">
			{text}
		</span>
	);
};

/** 分区(原子块)。文案同样恒有前缀,不会空。 */
const area: BlockRenderer<LiveCardView> = (p) => (
	<span data-bn="text" class="block">
		{`分区：${p.area}`}
	</span>
);

/** 粉丝行(原子块):各状态各有各的文案,某态没有就收起。 */
const fans: BlockRenderer<LiveCardView> = (p) => {
	const text = followerText(p);
	if (!text) return null;
	return <div data-bn="text">{text}</div>;
};

/**
 * live 卡的块表。每块返回内层 VNode(无 `data-block` —— 由 `renderBlocks` 的 wrapper
 * 统一加),无数据时返回 null 自动收起。divider 是可重复的分割线块。
 */
export const LIVE_BLOCKS: Record<string, BlockRenderer<LiveCardView>> = {
	[DIVIDER_TYPE]: () => <div data-bn="line" />,

	cover: (p) => (
		<img
			data-bn="image"
			// `h-full object-cover`:皮肤给这块声明了跨行时,wrapper 会拿到真高度
			// (`heightFromRows`),图得跟着填满、按比例裁。没声明高度时 `height:100%` 的
			// 百分比没有参照物,浏览器当 auto 办 —— 所以这两个 class 对老皮肤是零影响。
			class="block w-full h-full object-cover"
			src={p.cover}
			alt="封面"
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

	desc: (p) => <div data-bn="text">{p.description || "这个主播很懒，什么简介都没写"}</div>,

	avatar,
	name,
	time,
	popularity,
	area,
	fans,
};
