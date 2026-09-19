/** @jsxImportSource vue */

/**
 * 动态卡的块库。
 *
 * 每块只画**结构**:元素、它们的嵌套、撑住布局的那几个 class(`flex` / `w-full` /
 * `line-clamp-2` …)。它**长什么样**(字号、字色、圆角、角标底色、头像尺寸、转发框那圈
 * 灰底与蓝边)一概不在这里 —— 全写在出厂默认皮肤各块的 CSS 里(ADR-0014 决策 7 的
 * 2026-09-19 🔗):一份皮肤 JSON 就是卡片的全部样子,渲染器不留一层「默认外观」让皮肤去盖。
 * `__tests__/blocks-bare.test.ts` 扫源码钉着这一点。
 *
 * 挂点(ADR-0014 决策 9):`self` 是渲染器包在块外面的 wrapper,块的**根**另挂一个按「它是
 * 什么」取名的挂点(`image` / `text` / `pill` / `bubble` / `line`),默认皮肤的外观规则就写在
 * 它上面;根之外的部件照挂(图廊的 `pics` / `pic`、互动数的 `icon`、播放·弹幕数里的 `stat`)。
 * 名字取自 `CARD_SKIN_BUILTIN_BLOCKS.dynamic[<块>].hooks`,是对外 API
 * (`__tests__/card-hooks.test.ts` 两头钉着:块内出现的挂点必须都在目录里,目录里的挂点也
 * 必须真被挂上)。
 *
 * 两块**没有根挂点**,因为它们的根不归这里管:`text` 的正文是 VNode 插槽(`node.text`),
 * **不给它包一层壳** —— `body` 挂点挂在 `rich-text.tsx` 的富文本根 div 上;`pics` / `additional`
 * 同理由 `templates/dynamic-content.tsx` 里那几个 builder 画好,挂点住在它们身上。那几段富文本
 * 是决策 7 正文「内置块渲染逻辑不动」的地盘,外观没跟着搬。
 *
 * 唯一留在 inline 的 CSS 变量是 `--bn-up-name-color`(UP 主名的颜色:大会员粉 / 常规墨色)
 * —— 它是**数据**不是外观,由 `node.upIsVip` 算出来,皮肤在 `name` 的 `text` 规则里用
 * `var(--bn-up-name-color)` 引它。
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.dynamic`,一个不多一个不少(`__tests__/card-blocks.test.ts`
 * 对表钉着)。
 */

import { DIVIDER_TYPE } from "@bilibili-notify/internal";
import { h, type VNode } from "vue";
import { SVG_COMMENT, SVG_DANMAKU, SVG_FORWARD, SVG_LIKE, SVG_TOPIC, SVG_VIEW } from "../icons";
import type { DynamicNode } from "../templates/dynamic-content";
import type { BlockRenderer } from "./types";

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

/** 头像(原子块)。`object-cover` 是裁法不是样子:尺寸与圆由皮肤的 `image` 规则说。 */
const avatar: BlockRenderer<DynamicBlockProps> = ({ node }) => (
	<img data-bn="image" class="shrink-0 object-cover" src={node.avatarUrl} alt="头像" />
);

/**
 * UP 主名(原子块,含类型标签后缀)。名字的**颜色**是数据(大会员粉 / 常规墨色),留在
 * inline 的 `--bn-up-name-color` 里,皮肤用 `var()` 引。
 */
const name: BlockRenderer<DynamicBlockProps> = ({ node }) => (
	<span data-bn="text" style={{ "--bn-up-name-color": node.upIsVip ? "#FB7299" : "#18191C" }}>
		{node.upName}
		{node.headerLabel ? ` ${node.headerLabel}` : ""}
	</span>
);

/** 发布时间(原子块)。 */
const time: BlockRenderer<DynamicBlockProps> = ({ node }) => (
	<span data-bn="text">{node.pubTime}</span>
);

/** 话题(原子块):图标 + 话题名那一行。没有话题就收起。 */
const topic: BlockRenderer<DynamicBlockProps> = ({ node }) =>
	node.topic ? (
		<div data-bn="text" class="flex items-center">
			{SVG_TOPIC}
			{node.topic}
		</div>
	) : null;

/**
 * 正文文字(原子块):`node.text`,即 `node.body` 的文字那一半。不包壳 —— `body` 挂点在富文本
 * 自己的根上,那段富文本的外观也归它(决策 7 正文「内置块渲染逻辑不动」)。一个字都没有就收起。
 */
const text: BlockRenderer<DynamicBlockProps> = ({ node }) => node.text ?? null;

/**
 * 投稿视频那张卡的五块(决策 8 的 2026-09-18 🔗)。从前它们是 `media` 一整块里的部件 ——
 * 整块挪、整块关,右下角的时长角标更是拆不出来。现在各是一块,**排版与观感都留给皮肤**:
 * 外面那圈灰底圆角容器、封面上角标的定位、三段文字之间的间距、各自的字号字色,统统由出厂
 * 默认皮肤的块 CSS 拼回去(不造隐形底板块)。
 *
 * 没有投稿视频就各自收起 —— 转发那条自己没有视频,原视频归转发框里那张卡。
 */
const videoCover: BlockRenderer<DynamicBlockProps> = ({ node }) =>
	node.video ? (
		<img
			data-bn="image"
			// 见 `blocks/live.tsx` 的封面:皮肤声明了跨行时 wrapper 拿到真高度,图跟着填满、
			// 按比例裁;没声明时 `h-full` 的百分比没有参照物,浏览器当 auto 办(零影响)。
			class="w-full h-full object-cover block"
			src={node.video.cover}
			alt=""
		/>
	) : null;

/**
 * 时长角标。自己衬一层深色底(皮肤的 `pill` 规则给),不靠「整张封面压暗 + 白字阴影」——
 * 封面是主体,压暗会让整张图发灰,而封面右下角是什么颜色完全由 UP 决定,亮底上的白字加弱
 * 阴影会糊没。贴哪个角由皮肤说,所以这里**不写定位**。接口没给时长就收起(直播回放这类)。
 */
const videoDuration: BlockRenderer<DynamicBlockProps> = ({ node }) =>
	node.video?.duration ? <span data-bn="pill">{node.video.duration}</span> : null;

const videoTitle: BlockRenderer<DynamicBlockProps> = ({ node }) =>
	node.video ? (
		<div data-bn="text" class="line-clamp-2">
			{node.video.title}
		</div>
	) : null;

/** 简介常为空串 —— 空就整块收起,免得标题与播放数之间多出一条空白。 */
const videoDesc: BlockRenderer<DynamicBlockProps> = ({ node }) =>
	node.video?.desc ? (
		<div data-bn="text" class="line-clamp-2">
			{node.video.desc}
		</div>
	) : null;

/** 播放 · 弹幕数。两项各挂一个 `stat`,皮肤要能单独调「图标与数之间的间距」。 */
const videoStats: BlockRenderer<DynamicBlockProps> = ({ node }) =>
	node.video ? (
		<div data-bn="text" class="flex items-center">
			<span data-bn="stat" class="flex items-center">
				{SVG_VIEW}
				{node.video.views}
			</span>
			<span data-bn="stat" class="flex items-center">
				{SVG_DANMAKU}
				{node.video.danmaku}
			</span>
		</div>
	) : null;

/**
 * 图廊(原子块):`node.pics`。张数是动态的,拆不开,所以仍是 builder 画好的一整块,挂点
 * (`pics` / `pic`)在它画的部件上。没有图就收起。
 */
const pics: BlockRenderer<DynamicBlockProps> = ({ node }) => node.pics ?? null;

/**
 * 转发框(原子块)。根**就是**那个框,样子(灰底、圆角、左边那道蓝、`zoom`)写在皮肤的
 * `bubble` 规则里;框里那张卡照旧交给 `renderForward` 装。不是转发就收起。
 */
const forward: BlockRenderer<DynamicBlockProps> = ({ node, renderForward }) =>
	node.forward ? <div data-bn="bubble">{renderForward(node.forward)}</div> : null;

/** 互动数三件共用的结构:图标与数并排、竖向居中。间距与字色归皮肤的 `text` 规则。 */
const STAT_ATOM_CLASS = "flex items-center";

type DynamicStats = NonNullable<DynamicNode["stats"]>;

/**
 * 一项互动数(原子块):图标 + 数。没有互动数就收起 —— 转发框里的原动态本来就不带。
 */
const statAtom =
	(icon: VNode, pick: (s: DynamicStats) => string): BlockRenderer<DynamicBlockProps> =>
	({ node }) =>
		node.stats ? (
			<div data-bn="text" class={STAT_ATOM_CLASS}>
				{icon}
				<span>{pick(node.stats)}</span>
			</div>
		) : null;

/**
 * dynamic 卡的块表。每块返回内层 VNode(无 `data-block` —— 由 `renderBlocks` 的 wrapper
 * 统一加),无数据时返回 null 自动收起。
 */
export const DYNAMIC_BLOCKS: Record<string, BlockRenderer<DynamicBlockProps>> = {
	[DIVIDER_TYPE]: () => <div data-bn="line" />,

	// 附加卡是 `templates/dynamic-content.tsx` 画好的一整块(挂点住在它身上),这里只把它
	// 放进格子。从前那层 `px-[16px]` 搬进了皮肤这块 `self` 的 `padding` —— 根是块级 div、
	// 填满格子,写在外面那层 wrapper 上像素一样。
	additional: ({ node }) => (node.additional ? <div>{node.additional}</div> : null),

	avatar,
	name,
	time,
	topic,
	text,
	videoCover,
	videoDuration,
	videoTitle,
	videoDesc,
	videoStats,
	pics,
	forward,
	forwardCount: statAtom(ICON_FORWARD, (s) => s.forward),
	commentCount: statAtom(ICON_COMMENT, (s) => s.comment),
	likeCount: statAtom(ICON_LIKE, (s) => s.like),
};
