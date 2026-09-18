/** @jsxImportSource vue */

/**
 * 直播卡的块库。
 *
 * 复合块(cover / header / title / data / desc / divider)是从 `templates/live-card.tsx`
 * **原样搬**进来的那几段 JSX —— class、inline style、文案一个字都没动;原子块
 * (avatar / name / time)是**新抠**的:从 header 里取出头像 img / 名字 span / 时间 span,
 * 保持它们在复合块里的 class 与 style,让皮肤能把三件分开摆。
 *
 * 数据区那三件(popularity / area / fans)同理从 `data` 里抠出来,只是**多带上复合块根上
 * 那几句观感**(`px-4` / 13px / `#666`)—— 见 `DATA_ATOM_CLASS` 的说明。它们**取代了**原来的
 * `showPopularity` / `showArea` / `showFans` 三个开关(ADR-0014 决策 16 的 🔗,开关已退役):
 * 块级的 `showIf` 管不到复合块内部的一行,所以改成「想少显示哪件就删哪块」。
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.live`,一个不多一个不少(`__tests__/card-blocks.test.ts`
 * 对表钉着)。
 *
 * 复合块内部的部件挂 `data-bn="<挂点>"`(ADR-0014 决策 9):挂点名取自
 * `CARD_SKIN_BUILTIN_BLOCKS.live[<块>].hooks`,是对外 API,皮肤 CSS 直接按它选中部件。
 * 原子块自己就是那一件,它的挂点是 `self`,所以**不挂**内部挂点(`__tests__/card-hooks.test.ts`
 * 两头钉着:块内出现的挂点必须都在目录里,目录里的挂点也必须真被挂上)。
 *
 * **这块暴露的 CSS 变量**(ADR-0014 决策 13 的 🔗):颜色的**值**留在 inline 的 `--bn-*`
 * 自定义属性里,颜色**属性**写到 class 上 —— 皮肤 CSS 的 `!important` 被清洗器摘掉,
 * inline 声明永远压不过,写成 class 皮肤才染得动。
 *
 * | 变量 | 含义 | 挂在哪 |
 * | --- | --- | --- |
 * | `--bn-live-status-color` | 直播状态角标的底色(直播中粉 / 已下播·未开播灰) | `status` 原子块 |
 * | `--bn-ink` | 主文字色(主播名 / 标题) | `name` 原子块、`header` 里的名字 span、`title` 块根 |
 * | `--bn-ink-soft` | 次级文字色(数据区) | `data` 块根、`popularity` / `area` / `fans` 原子块 |
 * | `--bn-ink-faint` | 最弱的文字色(开播时间 / 简介) | `time` 原子块、`header` 里的时间 span、`desc` 块根 |
 * | `--bn-divider-color` | 分割线色 | `divider` 块根(= 分割线自己) |
 *
 * 写法用 UnoCSS 的**任意属性** `[color:var(--bn-x)]`,不用 `text-[var(--bn-x)]`:preset-wind4 的
 * 颜色工具类会编成 `color-mix(in oklab, … , transparent)`,那趟色彩空间往返**会动像素**
 * (本机 Chrome 实测,14 个颜色里 12 个栅格字节变了),像素门当场红。
 */

import { DIVIDER_TYPE } from "@bilibili-notify/internal";
import { htmlToPlain } from "../html-to-plain";
import type { LiveCardProps } from "../templates/live-card";
import type { BlockRenderer } from "./types";

function statusLabel(p: LiveCardProps): { text: string; bg: string } {
	if (p.liveStatus === 1) return { text: "直播中", bg: "#FF6699" };
	if (p.liveStatus === 2) return { text: "已下播", bg: "#aaa" };
	return { text: "未开播", bg: "#aaa" };
}

function statsLeft(p: LiveCardProps): string {
	if (p.liveStatus === 3) return `点赞：${p.likedNum}`;
	return `人气：${p.onlineNum}`;
}

function followerText(p: LiveCardProps): string {
	if (p.liveStatus === 1) return p.fansNum ? `当前粉丝数：${p.fansNum}` : "";
	if (p.liveStatus === 2) return p.watchedNum !== "API" ? `累计观看人数：${p.watchedNum}` : "";
	if (p.liveStatus === 3) return p.fansChanged ? `粉丝数变化：${p.fansChanged}` : "";
	return "";
}

/** 头像(原子块):header 复合块里的那个 img。 */
const avatar: BlockRenderer<LiveCardProps> = (p) => (
	<img class="w-11 h-11 rounded-full object-cover shrink-0" src={p.userface} alt="主播头像" />
);

/** 主播名(原子块):header 复合块里的那个 span。 */
const name: BlockRenderer<LiveCardProps> = (p) => (
	<span class="text-[16px] font-bold leading-none [color:var(--bn-ink)]" style="--bn-ink: #18191C;">
		{p.username}
	</span>
);

/** 开播时间(原子块):header 复合块里的那个 span。 */
const time: BlockRenderer<LiveCardProps> = (p) => (
	<span class="text-[12px] [color:var(--bn-ink-faint)]" style="--bn-ink-faint: #999;">
		{p.liveTime}
	</span>
);

/**
 * 数据区三件(人气 / 分区 / 粉丝)单独摆时自带的观感。
 *
 * 复合块 `data` 把 `px-4`、13px 与 `#666` 写在**根上**,里头三件靠继承拿到;拆成原子块后
 * 没有那个根替它们撑着,所以每件自己带上 —— 不带的话它们会掉回卡片的基准字号与深色。
 *
 * `block` 不是多加的一样,而是复刻复合块里的既有行为:顶行是 `flex`,那两个 span 作为
 * flex item 本就被块化了(行盒按自己的 13px 算);原子块的 wrapper 是普通块容器,span 若
 * 还留在行内,行盒会被 wrapper 继承来的基准字号撑高。
 */
const DATA_ATOM_CLASS = "block px-4 text-[13px] [color:var(--bn-ink-soft)]";
const DATA_ATOM_STYLE = "--bn-ink-soft: #666;";

/**
 * 人气 / 点赞(原子块):data 复合块顶行左边那个 span。
 *
 * 与复合块同一条判据:那个 span 恒画(`statsLeft` 带「人气：」前缀,永远不是空串),
 * 所以这里也不写「没内容收起」——写了也是一条永远走不到的分支。
 */
const popularity: BlockRenderer<LiveCardProps> = (p) => (
	<span class={DATA_ATOM_CLASS} style={DATA_ATOM_STYLE}>
		{statsLeft(p)}
	</span>
);

/** 分区(原子块):data 复合块顶行右边那个 span。文案同样恒有前缀,不会空。 */
const area: BlockRenderer<LiveCardProps> = (p) => (
	<span class={DATA_ATOM_CLASS} style={DATA_ATOM_STYLE}>
		{`分区：${p.data.area_name}`}
	</span>
);

/**
 * 粉丝行(原子块):data 复合块第二行那个 div。三态各有各的文案,某态没有就收起 ——
 * 与复合块里 `{fans ? <div …> : null}` 同一条判据。
 */
const fans: BlockRenderer<LiveCardProps> = (p) => {
	const text = followerText(p);
	if (!text) return null;
	return (
		<div class={DATA_ATOM_CLASS} style={DATA_ATOM_STYLE}>
			{text}
		</div>
	);
};

/**
 * live 卡的块表。每块返回内层 VNode(无 `data-block` —— 由 `renderBlocks` 的 wrapper
 * 统一加),无数据时返回 null 自动收起。divider 是可重复的分割线块。
 */
export const LIVE_BLOCKS: Record<string, BlockRenderer<LiveCardProps>> = {
	[DIVIDER_TYPE]: () => (
		<div
			class="[background:var(--bn-divider-color)]"
			style="height: 1px; --bn-divider-color: rgba(0,0,0,0.06); margin: 0 16px;"
		/>
	),

	cover: (p) => (
		<img
			class="block w-full rounded-lg"
			src={p.coverOverride || (p.cover ? p.data.user_cover : p.data.keyframe)}
			alt="封面"
		/>
	),

	// 从前这颗角标是封面块里 `position:absolute` 的一个孩子。现在它自己是一块,与封面占
	// 同一片格子、层次更高,贴哪个角由皮肤的 `align-self` / `justify-self` / `margin` 说 ——
	// 所以这里**不写定位**,只画角标本身。
	status: (p) => {
		const status = statusLabel(p);
		return (
			<div
				class="inline-flex items-center px-2.5 rounded-xl text-white text-[12px] font-bold [background-color:var(--bn-live-status-color)]"
				style={{
					"--bn-live-status-color": status.bg,
					height: "24px",
					lineHeight: "1",
					paddingTop: "1px",
				}}
			>
				{status.text}
			</div>
		);
	},

	title: (p) => (
		<div
			class="px-4 text-[17px] font-bold leading-snug [color:var(--bn-ink)]"
			style="--bn-ink: #18191C;"
		>
			{p.data.title}
		</div>
	),

	desc: (p) => (
		<div
			class="px-4 text-[13px] leading-normal [color:var(--bn-ink-faint)]"
			style="--bn-ink-faint: #999;"
		>
			{htmlToPlain(p.data.description) || "这个主播很懒，什么简介都没写"}
		</div>
	),

	avatar,
	name,
	time,
	popularity,
	area,
	fans,
};
