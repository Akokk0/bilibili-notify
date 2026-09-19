/** @jsxImportSource vue */

/**
 * 上舰卡的块库。
 *
 * 每块只画**结构**:元素、它们的嵌套、撑住布局的那几个 class(`flex` / `overflow-hidden` /
 * `truncate` / `bg-cover` …)。它**长什么样**(字号、字色、圆角、胶囊底色与高度、头像与徽章
 * 的尺寸)一概不在这里 —— 全写在出厂默认皮肤各块的 CSS 里(ADR-0014 决策 7 的 2026-09-19 🔗):
 * 一份皮肤 JSON 就是卡片的全部样子,渲染器不留一层「默认外观」让皮肤去盖。
 * `__tests__/blocks-bare.test.ts` 扫源码钉着这一点。
 *
 * 挂点(ADR-0014 决策 9):`self` 是渲染器包在块外面的 wrapper,块的**根**另挂一个按「它是
 * 什么」取名的挂点(`image` / `text` / `pill` / `line`),默认皮肤的外观规则就写在它上面;根
 * 之外的部件照挂(用户名胶囊里的 `text`、主播胶囊里的 `masterAvatar` / `masterName`)。名字
 * 取自 `CARD_SKIN_BUILTIN_BLOCKS.guard[<块>].hooks`,是对外 API(`__tests__/card-hooks.test.ts`
 * 两头钉着:块内出现的挂点必须都在目录里,目录里的挂点也必须真被挂上)。
 *
 * 两处要说明:
 * - **头像**的根是那个把图裁圆的框,`image` 挂在**框**上,里头的 `<img>` 不挂 —— 圆与尺寸
 *   写一处就够,img 只负责填满并按比例裁。
 * - **徽章**不经 `renderBlocks` 的 wrapper 挂 `data-block`(它自带),所以它的根上同时有
 *   `data-block="badge"` 与 `data-bn="image"`;wrapper 仍在,皮肤那条后代选择器照样选得中。
 *
 * 留在 inline 的 CSS 变量都是**数据**不是外观,皮肤用 `var()` 引:
 *
 * | 变量 | 含义 | 挂在哪 |
 * | --- | --- | --- |
 * | `--bn-card-tier-color` | 舰长等级档位色(`bgColor[0]`) | `user` / `master` 两颗胶囊、`text` |
 * | `--bn-divider-color` | 分割线色 = 档位色 + `33` 透明度 | `divider`(= 线自己) |
 *
 * 分割线单开一个变量而不是复用档位色:它的值是**运行期拼出来的**(`${档位色}33`),
 * CSS 里没有「给一个 hex 追加 alpha」的写法,`color-mix` 又要过一趟色彩空间换算(会动像素)。
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.guard`,一个不多一个不少(`__tests__/card-blocks.test.ts`
 * 对表钉着)。
 */

import type { GuardLevel } from "@bilibili-notify/blive";
import { DIVIDER_TYPE } from "@bilibili-notify/internal";
import type { GuardCardProps } from "../templates/guard-card";
import type { BlockRenderer } from "./types";

/** 「文字信息」那句,按舰长等级。块库与数据契约(`skin/card-data.ts`)共用这一份。 */
export const GUARD_DESC: Record<GuardLevel, (uname: string, masterName: string) => string> = {
	0: () => "",
	1: (uname, masterName) => `"${uname}"上任\n"${masterName}"大航海舰队总督！`,
	2: (uname, masterName) => `"${uname}"就任\n"${masterName}"大航海舰队提督！`,
	3: (uname, masterName) => `"${uname}号"加入\n"${masterName}"大航海舰队！`,
};

/**
 * 头像(原子块):一个把图裁圆的框 + 填满它的 img。尺寸与圆写在框的 `image` 规则里,
 * img 只负责填满并按比例裁(`overflow-hidden` 是裁法不是样子)。
 */
const avatar: BlockRenderer<GuardCardProps> = (p) => (
	<div data-bn="image" class="overflow-hidden shrink-0">
		<img class="w-full h-full object-cover" src={p.face} alt="用户头像" />
	</div>
);

/** 用户名胶囊(原子块)。底色是档位色(数据),留 inline 给皮肤 `var()` 引。 */
const user: BlockRenderer<GuardCardProps> = (p) => (
	<div
		data-bn="pill"
		class="flex items-center overflow-hidden"
		style={{ "--bn-card-tier-color": p.bgColor[0] }}
	>
		<span data-bn="text" class="truncate">
			{p.uname}
		</span>
	</div>
);

/**
 * 主播胶囊(原子块)。小头像的图是**数据**,走 inline 的 `background-image`;`bg-cover` /
 * `bg-center` 是它的裁法与定位,不是样子。
 */
const master: BlockRenderer<GuardCardProps> = (p) => (
	<div
		data-bn="pill"
		class="flex items-center overflow-hidden"
		style={{ "--bn-card-tier-color": p.bgColor[0] }}
	>
		<div
			data-bn="masterAvatar"
			class="bg-cover bg-center shrink-0"
			style={{ backgroundImage: `url("${p.masterAvatarUrl}")` }}
		/>
		<span data-bn="masterName" class="truncate">
			{p.isAdmin ? "房管" : p.masterName}
		</span>
	</div>
);

/**
 * guard 卡的块表。name / text / divider 走内容列的 `renderBlocks`;badge 是受限 2D 里的
 * 常驻块,由模板按 `badgeSide` 直接定位(所以它自带 `data-block`)。
 */
export const GUARD_BLOCKS: Record<string, BlockRenderer<GuardCardProps>> = {
	// 线的颜色是数据(档位色加两成透明),注在 `--bn-divider-color` 里;粗细 / 上下留白归皮肤。
	[DIVIDER_TYPE]: (p) => (
		<div data-bn="line" style={{ "--bn-divider-color": `${p.bgColor[0]}33` }} />
	),

	// 徽章块:舰长大图,受限 2D 里的常驻块,由 badgeSide 定位。图是数据(走 inline 的
	// `background-image`),多大一张归皮肤的 `image` 规则。
	badge: (p) => (
		<div
			data-block="badge"
			data-bn="image"
			class="bg-cover bg-center shrink-0"
			style={{ backgroundImage: `url("${p.captainImgUrl}")` }}
		/>
	),

	text: (p) => {
		const desc = GUARD_DESC[p.guardLevel]?.(p.uname, p.masterName) ?? "";
		return desc ? (
			<div
				data-bn="text"
				class="whitespace-pre-line"
				style={{ "--bn-card-tier-color": p.bgColor[0] }}
			>
				{desc}
			</div>
		) : null;
	},

	avatar,
	user,
	master,
};
