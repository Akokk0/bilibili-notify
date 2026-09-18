/** @jsxImportSource vue */

/**
 * 动态卡的块库。
 *
 * 复合块(header / content / additional / stats / divider)是从 `templates/dynamic-card.tsx`
 * **原样搬**进来的那几段 JSX —— class、inline style、文案一个字都没动;原子块是**新抠**的,
 * 保持它们在复合块里的 class 与 style,让皮肤能把各件分开摆:
 * - avatar / name / time:header 里的头像 img / 名字 span / 时间 span;
 * - topic / text / 视频五块 / pics / forward(2026-09-18,决策 8 的 🔗):话题行、正文文字、
 *   投稿视频那张卡(封面 / 时长 / 标题 / 简介 / 播放·弹幕数)、图廊、转发框。文字与媒体
 *   取呈现态里另给的那几份(`node.text` / `node.video` / `node.pics`),
 *   不从 `node.body` 里摘;
 * - forwardCount / commentCount / likeCount(同日):stats 里的三项,多带上复合块根上的颜色
 *   (见 `STAT_ATOM_CLASS`)。
 *
 * 键名对齐 `CARD_SKIN_BUILTIN_BLOCKS.dynamic`,一个不多一个不少(`__tests__/card-blocks.test.ts`
 * 对表钉着)。
 *
 * 复合块内部的部件挂 `data-bn="<挂点>"`(ADR-0014 决策 9),挂点名取自
 * `CARD_SKIN_BUILTIN_BLOCKS.dynamic[<块>].hooks`;原子块的**根**是 `self`,所以根上不挂,
 * 但它里头带着的部件照挂(正文的 `body`、图廊的 `pics`、互动数的 `icon`)。
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
 * | `--bn-ink-faint` | 最弱的文字色(发布时间 / 互动数) | `time` 原子块、`header` 里的时间 span、`stats` 块根、三个互动数原子块 |
 * | `--bn-accent` | 强调色(话题与转发 inset 左边框是 B 站蓝;充电专属占位是 B 站粉) | `content` 里的话题行与转发 inset、`topic` / `forward` 原子块、`templates/dynamic-content.tsx` 的充电专属占位 |
 * | `--bn-divider-color` | 分割线色 | `divider` 块根(= 分割线自己) |
 * | `--bn-inset-bg` | 淡底内嵌块的背景 | 转发 inset 自己(含 `forward` 原子块)、`templates/dynamic-content.tsx` 的主视频卡外壳 |
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

/**
 * 转发框那层 div 的 class。**单点定义**:好几处测试要按它认出这个框 —— 这一块是**原子块**,
 * 它的挂点是 `self`,根上不挂 `data-bn="forward"`(那是复合块时代的内部部件名),所以只剩
 * class 认得出来。两处各写一份的话,改了 class 门会为一个看不懂的理由红。
 */
export const FORWARD_INSET_CLASS =
	"rounded-[8px] mt-2 pt-[12px] pb-[12px] [background:var(--bn-inset-bg)] [border-left-color:var(--bn-accent)]";

/**
 * 转发框那层 div 的 inline style。复合块 `content` 里的转发 inset 与原子块 `forward` 共用这一句
 * —— 两处各抄一份的话,改了一处,单独摆的转发框就与复合块里的长得不一样了。
 */
const FORWARD_INSET_STYLE =
	"--bn-inset-bg: rgba(0,0,0,0.04); --bn-accent: #00AEEC; border-left-width: 5px; border-left-style: solid; zoom: 0.85;";

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

/** 话题(原子块):content 复合块里的话题行(图标 + 话题名)。没有话题就收起。 */
const topic: BlockRenderer<DynamicBlockProps> = ({ node }) =>
	node.topic ? (
		<div
			class="flex items-center gap-[5px] mb-[8px] text-[13px] font-bold [color:var(--bn-accent)]"
			style="--bn-accent: #00AEEC;"
		>
			{SVG_TOPIC}
			{node.topic}
		</div>
	) : null;

/**
 * 正文文字(原子块):`node.text`,即 content 复合块里 `node.body` 的文字那一半。不包壳 ——
 * 与 content 同理,`body` 挂点在富文本自己的根上。一个字都没有就收起。
 */
const text: BlockRenderer<DynamicBlockProps> = ({ node }) => node.text ?? null;

/**
 * 投稿视频那张卡的五块(决策 8 的 2026-09-18 🔗)。从前它们是 `media` 一整块里的部件 ——
 * 整块挪、整块关,右下角的时长角标更是拆不出来。现在各是一块,JSX **逐字照搬**原来那张卡,
 * 只把**排版**留给皮肤:外面那圈灰底圆角容器、封面上角标的定位、三段文字之间的间距,
 * 统统由出厂默认皮肤的块 CSS 用网格拼回去(不造隐形底板块)。
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
 * 时长角标。自己衬一层深色底,不靠「整张封面压暗 + 白字阴影」—— 封面是主体,压暗会让整张图
 * 发灰,而封面右下角是什么颜色完全由 UP 决定,亮底上的白字加弱阴影会糊没。
 * 贴哪个角由皮肤说,所以这里**不写定位**。接口没给时长就收起(直播回放这类)。
 */
const videoDuration: BlockRenderer<DynamicBlockProps> = ({ node }) =>
	node.video?.duration ? (
		<span class="px-[6px] py-[2px] rounded-[4px] bg-black/60 text-white text-[12px] font-bold leading-[1.4]">
			{node.video.duration}
		</span>
	) : null;

const videoTitle: BlockRenderer<DynamicBlockProps> = ({ node }) =>
	node.video ? (
		<div class="text-[16px] font-bold text-[#18191C] line-clamp-2">{node.video.title}</div>
	) : null;

/** 简介常为空串 —— 空就整块收起,免得标题与播放数之间多出一条空白。 */
const videoDesc: BlockRenderer<DynamicBlockProps> = ({ node }) =>
	node.video?.desc ? (
		<div class="text-[12px] text-[#999] line-clamp-2">{node.video.desc}</div>
	) : null;

const videoStats: BlockRenderer<DynamicBlockProps> = ({ node }) =>
	node.video ? (
		<div class="flex gap-3 text-[12px] text-[#999] items-center">
			<span class="flex items-center gap-[4px]">
				{SVG_VIEW}
				{node.video.views}
			</span>
			<span class="flex items-center gap-[4px]">
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
 * 转发框(原子块):content 复合块里的转发 inset。根**就是**转发框,所以不再挂 `forward` 挂点
 * (那是复合块内部的部件名);框里那张卡照旧交给 `renderForward` 装。不是转发就收起。
 */
const forward: BlockRenderer<DynamicBlockProps> = ({ node, renderForward }) =>
	node.forward ? (
		<div class={FORWARD_INSET_CLASS} style={FORWARD_INSET_STYLE}>
			{renderForward(node.forward)}
		</div>
	) : null;

/**
 * 互动数三件单独摆时自带的观感。
 *
 * 复合块 `stats` 把颜色(`[color:var(--bn-ink-faint)]` + `--bn-ink-faint: #999`)写在**根上**,
 * 三项的数字与图标(`fill="currentColor"`)都靠继承拿到;拆成原子块后没有那个根,所以每件
 * 自己带上 —— 不带的话它们会掉回卡片的深色。根上那句 `justify-around px-[16px]` 是「三项
 * 怎么分一行」的排法,单独摆时归网格管,不带。
 */
const STAT_ATOM_CLASS = "flex items-center gap-[6px] text-[13px] [color:var(--bn-ink-faint)]";
const STAT_ATOM_STYLE = "--bn-ink-faint: #999;";

type DynamicStats = NonNullable<DynamicNode["stats"]>;

/**
 * 一项互动数(原子块):stats 复合块里的那一项(图标 + 数)。没有互动数就收起 —— 转发框里的
 * 原动态本来就不带。
 */
const statAtom =
	(icon: VNode, pick: (s: DynamicStats) => string): BlockRenderer<DynamicBlockProps> =>
	({ node }) =>
		node.stats ? (
			<div class={STAT_ATOM_CLASS} style={STAT_ATOM_STYLE}>
				{icon}
				<span>{pick(node.stats)}</span>
			</div>
		) : null;

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

	additional: ({ node }) =>
		node.additional ? <div class="px-[16px]">{node.additional}</div> : null,

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
