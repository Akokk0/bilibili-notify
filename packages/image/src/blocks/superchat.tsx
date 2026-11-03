import { packageText } from "@bilibili-notify/internal/texts";
/** @jsxImportSource vue */

/**
 * SC(醒目留言)卡的块库。
 *
 * 每块只画**结构**:元素、它们的嵌套、撑住布局的那几个 class(`flex` / `w-full` /
 * `overflow-hidden` / `bg-cover` …)。它**长什么样**(字号、字色、圆角、胶囊底色、头像尺寸、
 * 留言气泡那层白纱)一概不在这里 —— 全写在出厂默认皮肤各块的 CSS 里(ADR-0014 决策 7 的
 * 2026-09-19 🔗):一份皮肤 JSON 就是卡片的全部样子,渲染器不留一层「默认外观」让皮肤去盖。
 * `__tests__/blocks-bare.test.ts` 扫源码钉着这一点。
 *
 * 挂点(ADR-0014 决策 9):`self` 是渲染器包在块外面的 wrapper,块的**根**另挂一个按「它是
 * 什么」取名的挂点(`image` / `text` / `pill` / `line`),默认皮肤的外观规则就写在它上面;根
 * 之外的部件照挂(留言的 `bubble` 与 `text`、「SC to」那行里的 `label` / `creator` /
 * `creatorAvatar` / `creatorName`)。名字取自 `CARD_SKIN_BUILTIN_BLOCKS.superchat[<块>].hooks`,是对外
 * API(`__tests__/card-hooks.test.ts` 两头钉着:块内出现的挂点必须都在目录里,目录里的挂点
 * 也必须真被挂上)。
 *
 * 两处例外要说明:
 * - **头像**的根是那个把图裁圆的框,`image` 挂在**框**上,里头的 `<img>` 不挂 —— 圆与尺寸
 *   写一处就够,img 只负责填满并按比例裁。
 * - **留言**的根是一层撑满格子的壳,居中由块的 `self` 规则(`text-align`)说,所以壳上不挂;
 *   气泡挂 `bubble`、文字挂 `text`。
 *
 * 留在 inline 的 CSS 变量只有档位色 —— 它们是**数据**不是外观(由价位档算出来),皮肤在各自
 * 的规则里用 `var()` 引:
 *
 * | 变量 | 含义 | 挂在哪 |
 * | --- | --- | --- |
 * | `--bn-card-tier-color` | 价位档位色的起色(`bgColor[0]`) | `divider`(= 线自己)、`name` 胶囊、`price`、`duration` |
 * | `--bn-card-tier-color-end` | 价位档位色的止色(`bgColor[1]`) | `price`(金额是渐变裁字,缺一个字就透明了) |
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.superchat`,一个不多一个不少(`__tests__/card-blocks.test.ts`
 * 对表钉着)。
 */

import { DIVIDER_TYPE } from "@bilibili-notify/internal";
import { escapeHtmlWithBreaks } from "../html-escape";
import { SVG_DURATION } from "../icons";
import type { SuperchatCardView } from "../templates/superchat-card";
import type { BlockRenderer } from "./types";

/**
 * 发送者头像(原子块):一个把图裁圆的框 + 填满它的 img。尺寸与圆写在框的 `image` 规则里,
 * img 只负责填满并按比例裁(`overflow-hidden` 是裁法不是样子)。
 *
 * **没有头像就整块收起**(返回 null):`SuperchatCardInput.viewer.avatar` 只收图库引用,B 站这条路出卡前把留言帧自带的头像地址抓进图库,
 * 抓不到就不给(ADR-0021 决策 26 下 2026-10-05 的 🔗)。
 */
const viewerAvatar: BlockRenderer<SuperchatCardView> = (p) =>
	p.viewerAvatarUrl ? (
		<div data-bn="image" class="overflow-hidden">
			<img
				class="w-full h-full object-cover"
				src={p.viewerAvatarUrl}
				alt={packageText("image.blocks.superchat.1")}
			/>
		</div>
	) : null;

/** 观众名(原子块):那颗名牌胶囊。底色是档位色(数据),留 inline 给皮肤 `var()` 引。 */
const viewerName: BlockRenderer<SuperchatCardView> = (p) => (
	<div data-bn="pill" style={{ "--bn-card-tier-color": p.bgColor[0] }}>
		{p.viewerName}
	</div>
);

/**
 * 金额(原子块):那串数字。它是**渐变裁字**(皮肤那条规则里 `background-clip:text` +
 * 透明字色),起止两枚档位色是数据,缺一枚字就整个透明了,所以两枚都留 inline。
 */
const amount: BlockRenderer<SuperchatCardView> = (p) => (
	<div
		data-bn="text"
		style={{
			"--bn-card-tier-color": p.bgColor[0],
			"--bn-card-tier-color-end": p.bgColor[1],
		}}
	>
		{p.amount}
	</div>
);

/**
 * 时长胶囊(原子块):图标 + 时长。底色同样是档位色(数据)。**来源没给留言时长就整块收起**(`duration` 是空串):
 * 时长写在消息里(`tier.durationSec`),不再按价位反推。
 */
const duration: BlockRenderer<SuperchatCardView> = (p) =>
	p.duration ? (
		<div
			data-bn="pill"
			class="inline-flex items-center"
			style={{ "--bn-card-tier-color": p.bgColor[0] }}
		>
			{SVG_DURATION()}
			<span>{p.duration}</span>
		</div>
	) : null;

/**
 * 「SC to」那一行(原子块):三个字 + 主播那一组(小头像 + 名字)。小头像的图是**数据**,
 * 走 inline 的 `background-image`;`bg-cover` / `bg-center` 是它的裁法与定位,不是样子。
 */
const to: BlockRenderer<SuperchatCardView> = (p) => (
	<div data-bn="text" class="flex items-center">
		<span data-bn="label">SC to</span>
		<div data-bn="creator" class="flex items-center">
			{p.creatorAvatarUrl && (
				<div
					data-bn="creatorAvatar"
					class="bg-cover bg-center"
					style={{ backgroundImage: `url("${p.creatorAvatarUrl}")` }}
				/>
			)}
			<span data-bn="creatorName">{p.creatorName}</span>
		</div>
	</div>
);

/**
 * sc 卡的块表。每块返回内层 VNode(无 `data-block`),无数据时返回 null。
 * divider 是 sc 专属的渐变分割线(可重复)。
 */
export const SUPERCHAT_BLOCKS: Record<string, BlockRenderer<SuperchatCardView>> = {
	// 渐变的中段是档位色(数据),注在 `--bn-card-tier-color` 里;渐变本身归皮肤的 `line` 规则。
	[DIVIDER_TYPE]: (p) => (
		<div data-bn="line" class="w-full" style={{ "--bn-card-tier-color": p.bgColor[0] }} />
	),

	// 外面那层壳只负责撑满格子:居中归这块 `self` 规则里的 `text-align`(块级根填满格子,
	// 写在 wrapper 上继承下来一模一样),所以壳上不挂挂点。
	message: (p) => {
		const escapedText = escapeHtmlWithBreaks(p.text?.trim() ?? "");
		return escapedText ? (
			<div class="w-full">
				<div data-bn="bubble">
					<div data-bn="text" class="break-words whitespace-pre-wrap" innerHTML={escapedText} />
				</div>
			</div>
		) : null;
	},

	viewerAvatar,
	viewerName,
	amount,
	duration,
	to,
};
