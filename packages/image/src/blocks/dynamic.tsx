/** @jsxImportSource vue */

/**
 * 动态卡的块库。
 *
 * 复合块(header / content / additional / stats / divider)是从 `templates/dynamic-card.tsx`
 * **原样搬**进来的那几段 JSX —— class、inline style、文案一个字都没动;原子块
 * (avatar / name / time)是**新抠**的:从 header 里取出头像 img / 名字 span / 时间 span,
 * 保持它们在复合块里的 class 与 style,让皮肤能把三件分开摆。
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.dynamic`,一个不多一个不少(`__tests__/card-blocks.test.ts`
 * 对表钉着)。
 *
 * 复合块内部的部件挂 `data-bn="<挂点>"`(ADR-0014 决策 9),挂点名取自
 * `CARD_SKIN_BUILTIN_BLOCKS.dynamic[<块>].hooks`;原子块的挂点是 `self`,所以不挂。
 * content 块的正文是 VNode 插槽(`node.body`),**不给它包一层壳** —— `body` 挂点挂在
 * `rich-text.tsx` 的富文本根 div 上;图廊 / 视频卡 / 附加卡的挂点同理住在
 * `templates/dynamic-content.tsx` 里那几个 builder 上。两头由 `__tests__/card-hooks.test.ts` 钉着。
 *
 * **这块暴露的 CSS 变量**(ADR-0014 决策 13 的 🔗):颜色的**值**留在 inline 的 `--bn-*`
 * 自定义属性里,颜色**属性**写到 class 上 —— 皮肤 CSS 的 `!important` 被清洗器摘掉,
 * inline 声明永远压不过,写成 class 皮肤才染得动。
 *
 * | 变量 | 含义 | 挂在哪 |
 * | --- | --- | --- |
 * | `--bn-up-name-color` | UP 主名的颜色(大会员粉 / 常规墨色,运行期二选一) | `name` 原子块根、`header` 里的名字 span |
 * | `--bn-ink-faint` | 最弱的文字色(发布时间 / 互动数) | `time` 原子块、`header` 里的时间 span、`stats` 块根 |
 * | `--bn-accent` | 强调色(话题与转发 inset 左边框是 B 站蓝;充电专属占位是 B 站粉) | `content` 里的话题行与转发 inset、`templates/dynamic-content.tsx` 的充电专属占位 |
 * | `--bn-divider-color` | 分割线色 | `divider` 块根(= 分割线自己) |
 * | `--bn-inset-bg` | 淡底内嵌块的背景 | 转发 inset 自己、`templates/dynamic-content.tsx` 的主视频卡外壳 |
 *
 * `content` 块的正文由 `templates/dynamic-content.tsx` 与 `rich-text.tsx` 画,那两处的颜色
 * 同规矩、同一张变量表;`--bn-ink-faint` 在那边也用着。
 *
 * 写法用 UnoCSS 的**任意属性** `[color:var(--bn-x)]`,不用 `text-[var(--bn-x)]`:preset-wind4 的
 * 颜色工具类会编成 `color-mix(in oklab, … , transparent)`,那趟色彩空间往返**会动像素**
 * (本机 Chrome 实测,14 个颜色里 12 个栅格字节变了),像素门当场红。
 *
 * 转发 inset 的 `border-left` 拆成了 `border-left-width` / `border-left-style` 留 inline、
 * 颜色走 class:简写 `border-left: 5px solid` 会把 `border-left-color` 也写成 inline 的
 * `currentColor`,inline 恒赢 class,颜色那半就永远染不动了。
 */

import { type CardBlock, DIVIDER_TYPE } from "@bilibili-notify/internal";
import { h, type VNode } from "vue";
import { SVG_COMMENT, SVG_FORWARD, SVG_LIKE, SVG_TOPIC } from "../icons";
import { renderBlocks } from "../templates/block-layout";
import type { DynamicNode } from "../templates/dynamic-content";
import { type BlockRenderer, bindBlocks } from "./types";

/**
 * 给 `icons.tsx` 里那几个**预求值的 VNode 常量**挂上 `icon` 挂点。
 *
 * 不能在图标外面包一层 `<span data-bn="icon">` —— 那会往输出里塞一个今天没有的元素,
 * 基准快照(剥掉挂点后逐字节)当场红,布局也跟着变;也不能改常量本身,它们在别处(富文本、
 * 附加卡)复用,而那些地方没有 `icon` 挂点。所以照原样重建一个同类型同 children 的 VNode,
 * props 里多一条 `data-bn`,原常量分毫不动。
 *
 * ⚠️ 别改回 `cloneVNode`:它走 `mergeProps`,而 `mergeProps` 会把**每个** `style`(包括
 * 没被覆盖的那一份)过一遍 `normalizeStyle` —— 图标的 `style` 是字符串,被解析成对象再
 * 序列化就多出一个结尾分号(`flex-shrink:0` → `flex-shrink:0;`),基准当场红。`h()` 只在
 * style 是对象时才规范化,字符串原样带过去。
 */
const withIconHook = (icon: VNode): VNode =>
	h(icon.type as string, { ...icon.props, "data-bn": "icon" }, icon.children as VNode[]);

/**
 * 转发框那层 div 的 class。**单点定义**:验收门(`skin/__tests__/skin-gate.test.ts`)要
 * 按它认出这个框 —— 基准快照打在挂点之前,那份 HTML 里一个 `data-bn` 都没有,只剩 class
 * 认得出来。两处各写一份的话,改了 class 门会为一个看不懂的理由红。
 */
export const FORWARD_INSET_CLASS =
	"rounded-[8px] mt-2 pt-[12px] pb-[12px] [background:var(--bn-inset-bg)] [border-left-color:var(--bn-accent)]";

const ICON_FORWARD = withIconHook(SVG_FORWARD);
const ICON_COMMENT = withIconHook(SVG_COMMENT);
const ICON_LIKE = withIconHook(SVG_LIKE);

/**
 * 动态块吃的 props:一个 DynamicNode + **内层卡怎么装**。
 *
 * 转发框里是另一张完整的卡,而「一张卡怎么装」这件事块库不该知道 —— 模板路按一维竖栈装、
 * 皮肤路按网格装,两条路各自把自己的装配方式递进来。块只负责把结果放进转发框里。
 * 内层因此永远与外层同一套装配:模板路跟同一份 layout,皮肤路跟同一份皮肤。
 */
export type DynamicBlockProps = {
	node: DynamicNode;
	renderForward: (node: DynamicNode) => VNode | VNode[];
};

/** 头像(原子块):header 复合块里的那个 img。 */
const avatar: BlockRenderer<DynamicBlockProps> = ({ node }) => (
	<img
		class="w-[52px] h-[52px] shrink-0 rounded-full object-cover"
		src={node.avatarUrl}
		alt="头像"
	/>
);

/** UP 主名(原子块):header 复合块里的那个 span(含类型标签后缀与大会员粉名)。 */
const name: BlockRenderer<DynamicBlockProps> = ({ node }) => (
	<span
		class="text-[17px] font-bold leading-none [color:var(--bn-up-name-color)]"
		style={{ "--bn-up-name-color": node.upIsVip ? "#FB7299" : "#18191C" }}
	>
		{node.upName}
		{node.headerLabel ? ` ${node.headerLabel}` : ""}
	</span>
);

/** 发布时间(原子块):header 复合块里的那个 span。 */
const time: BlockRenderer<DynamicBlockProps> = ({ node }) => (
	<span class="text-[12px] [color:var(--bn-ink-faint)]" style="--bn-ink-faint: #999;">
		{node.pubTime}
	</span>
);

/**
 * dynamic 卡的块表。每块返回内层 VNode(无 `data-block` —— 由 `renderBlocks` 的 wrapper
 * 统一加),无数据时返回 null 自动收起。
 */
export const DYNAMIC_BLOCKS: Record<string, BlockRenderer<DynamicBlockProps>> = {
	[DIVIDER_TYPE]: () => (
		<div
			class="[background:var(--bn-divider-color)]"
			style="height: 1px; --bn-divider-color: rgba(0,0,0,0.06); margin: 0 16px;"
		/>
	),

	header: ({ node }) => (
		<div class="flex items-center gap-[12px] px-[16px]">
			<img
				data-bn="avatar"
				class="w-[52px] h-[52px] shrink-0 rounded-full object-cover"
				src={node.avatarUrl}
				alt="头像"
			/>
			<div class="flex flex-col gap-[3px]">
				<span
					data-bn="name"
					class="text-[17px] font-bold leading-none [color:var(--bn-up-name-color)]"
					style={{ "--bn-up-name-color": node.upIsVip ? "#FB7299" : "#18191C" }}
				>
					{node.upName}
					{node.headerLabel ? ` ${node.headerLabel}` : ""}
				</span>
				<span
					data-bn="time"
					class="text-[12px] [color:var(--bn-ink-faint)]"
					style="--bn-ink-faint: #999;"
				>
					{node.pubTime}
				</span>
			</div>
		</div>
	),

	content: ({ node, renderForward }) => (
		<div class="px-[16px]">
			{node.topic ? (
				<div
					data-bn="topic"
					class="flex items-center gap-[5px] mb-[8px] text-[13px] font-bold [color:var(--bn-accent)]"
					style="--bn-accent: #00AEEC;"
				>
					{SVG_TOPIC}
					{node.topic}
				</div>
			) : null}
			{node.body}
			{node.forward ? (
				// 转发 inset 是内部动态的「框架」:像外层卡片容器一样提供固定的上下内边距,
				// 这样 renderBlocks 跳过内部首块上边距后,内容不会顶着 inset 顶部。
				// zoom 把内部子树整体等比缩小(Chromium 原生支持、会正常重排) —— 内层走同一套
				// 写死 px 的 builder,只有 zoom 能统一缩小头像 / 视频卡 / 文字,一眼认出是转发。
				<div
					data-bn="forward"
					class={FORWARD_INSET_CLASS}
					style="--bn-inset-bg: rgba(0,0,0,0.04); --bn-accent: #00AEEC; border-left-width: 5px; border-left-style: solid; zoom: 0.85;"
				>
					{renderForward(node.forward)}
				</div>
			) : null}
		</div>
	),

	additional: ({ node }) =>
		node.additional ? <div class="px-[16px]">{node.additional}</div> : null,

	stats: ({ node }) =>
		node.stats ? (
			<div
				class="flex justify-around px-[16px] [color:var(--bn-ink-faint)]"
				style="--bn-ink-faint: #999;"
			>
				<div data-bn="item" class="flex items-center gap-[6px] text-[13px]">
					{ICON_FORWARD}
					<span>{node.stats.forward}</span>
				</div>
				<div data-bn="item" class="flex items-center gap-[6px] text-[13px]">
					{ICON_COMMENT}
					<span>{node.stats.comment}</span>
				</div>
				<div data-bn="item" class="flex items-center gap-[6px] text-[13px]">
					{ICON_LIKE}
					<span>{node.stats.like}</span>
				</div>
			</div>
		) : null,

	avatar,
	name,
	time,
};

/**
 * **模板路**:由一个 DynamicNode + 版式生成各块构建器(按块名)。转发框里的内层卡按
 * 同一份 layout 再装一遍 —— 那条递归住在这里(所以它必须在 `DYNAMIC_BLOCKS` 之后用
 * `function` 声明,靠提升)。皮肤路不经过这里,它自己往 `renderForward` 里递网格装配。
 */
export function dynamicNodeBuilders(
	node: DynamicNode,
	layout: CardBlock[],
): Record<string, () => VNode | null> {
	return bindBlocks(DYNAMIC_BLOCKS, {
		node,
		renderForward: (forward) => renderBlocks(layout, dynamicNodeBuilders(forward, layout)),
	});
}
