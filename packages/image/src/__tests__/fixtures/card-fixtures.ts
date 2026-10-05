/**
 * 七种推送卡片的**共享夹具表** —— 一份 props,几条渲染路径。
 *
 * 这些夹具原先长在 `card-baseline.test.ts` 里,只喂快照基准一家;卡片皮肤(ADR-0014)之后
 * 它们还要喂挂点对表(`card-hooks.test.ts`:同一份 props 不走整卡,改走**块级**渲染,逐块看
 * 它挂了哪些 `data-bn`)。两边共用一份,才不会出现「基准盖到的分支挂点没盖到」。
 *
 * 夹具刻意铺开各模板的条件分支(封面有无 / 粉丝数据三态 / VIP 名字色 / 话题 / 附加内容四型 /
 * 图廊三种形态 / 分割线的开头抑制与末尾弹出 …),让一次改动能一次照出问题。夹具里的 URL 都是
 * **形状真实但不存在**的 B 站地址 —— `renderCard` 不取图,不需要真能访问。
 *
 * props 一律照 `image-renderer.ts` 里对应 `generate*Card` 的拼法(含 title / htmlWidth /
 * font),动态卡的 node 经 `nodeFromPost(post, fmt)` 构造,fmt 用固定函数,
 * 不碰真实时钟 —— 所以入参是**异步工厂**(`build()`)而不是一份现成的常量。
 */

import { type CardSkinKind, formatCount } from "@bilibili-notify/internal";
import { htmlToPlain } from "../../html-to-plain";
import { BG_COLORS, getSCLevel, SC_COLORS, SC_LEVELS } from "../../styles";
import type { LiveCardView } from "../../templates/live-card";
import { nodeFromPost } from "../../templates/post-node";
import type { RoastBoardCardProps, RoastSoloCardProps } from "../../templates/roast-card";
import { DYNAMIC_SAMPLE_POSTS } from "./post-fixtures";

// ── 夹具表的形状 ──────────────────────────────────────────────────────────────

/** 渲染一份夹具要的入参。整卡模板退役后没有 `component` 这一项了 —— 夹具走皮肤那条路
 * (`fixtures/skin-render.ts`),卡怎么装由皮肤说了算。 */
export interface CardRenderInput {
	props: Record<string, unknown>;
	options: { title?: string; font?: string; htmlWidth?: number; fontFace?: string };
}

export interface CardFixture {
	/** 快照名(`__snapshots__/card-baseline/<name>.html`),也是夹具的唯一 id。 */
	readonly name: string;
	/** 归到哪张卡的 describe 下(锐评榜单与单人锐评共用一组)。 */
	readonly group: string;
	/** 基准用例的描述,一字照抄原来的 `it(...)`。 */
	readonly label: string;
	readonly kind: CardSkinKind;
	/** 现造一份渲染入参。 */
	readonly build: () => Promise<CardRenderInput>;
}

/**
 * 把整卡入参翻成**块库**(`src/blocks/*`)直接吃的 props —— 同一份夹具走块级渲染那条路。
 * 除动态卡外,块库吃的就是卡片 props 本身;动态块还要一个「内层卡怎么装」。
 *
 * 这里给的是**空装配**:块级的对表只数「这一块自己画出什么」,转发框里那张内层卡怎么摆
 * 是皮肤的事(整卡那条路由 `renderSkinnedCard` 自己往 `renderForward` 里递网格装配),
 * 与块级对表无关。
 */
export function blockPropsOf(kind: CardSkinKind, input: CardRenderInput): unknown {
	if (kind !== "dynamic") return input.props;
	return { node: input.props.node, renderForward: (): [] => [] };
}

/**
 * 剥掉皮肤挂点属性(`data-bn="…"`)。
 *
 * 挂点是加在现有元素上的**纯附加属性**,除它之外一个字节都不该变 —— 所以「逐字节」的基准
 * 与「原子块逐字出现在复合块里」的对表都先剥一遍再比(ADR-0014 决策 9)。
 */
export function stripCardHooks(html: string): string {
	return html.replace(/ data-bn="[^"]*"/g, "");
}

// ── 公共常量 ──────────────────────────────────────────────────────────────────

/** 出厂默认字体(DEFAULT_CARD_STYLE.font)。全部快照固定用它,不传 fontFace。 */
const FONT = "PingFang SC, sans-serif";

/** GUARD_LEVEL_IMG(image-renderer 私有,不为测试改导出,按现状抄一份)。 */
const GUARD_IMG = {
	1: "https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/governor-DpDXKEdA.png",
	2: "https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/supervisor-u43ElIjU.png",
	3: "https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/captain-Bjw5Byb5.png",
} as const;

// ── 直播卡 ────────────────────────────────────────────────────────────────────

/** 房间封面与关键帧(直播中那张)。 */
const USER_COVER = "http://i0.hdslb.com/bfs/live/new_room_cover/0a1b2c3d4e5f60718293.jpg";
const KEYFRAME = "http://i0.hdslb.com/bfs/live-key-frame/keyframe0102030405060708.jpg";

/**
 * B 站给的房间简介是富文本 —— B 站那头(`biliLiveCardInput`)先剥成纯文本再交给卡片,
 * 夹具照它的产物写。
 */
const RICH_DESCRIPTION =
	"<p>每晚八点开播&nbsp;&amp;&nbsp;周末加场</p><br>&lt;b&gt;联系方式见动态&lt;/b&gt;";

/**
 * 照 `generateNeutralLiveCard` 排好的那一份组 props(块吃的 `LiveCardView`;数字都经
 * formatCount)。
 *
 * 这四份夹具是 **B 站形状**的直播卡(简介走 `htmlToPlain`、封面是 B 站的房间封面 / 关键帧),所以
 * `userface` 是空串:B 站这条路到 3a 之前不给头像(`LiveCardInput.author`),头像块整块收起。夹具直接写
 * 排好的视图、不经 `biliLiveCardInput`,这一格得跟着真实产物手写。拓展直播那条路仍带头像,
 * 头像块的挂点由 `card-hooks.test.ts` 的旁路探针看着,画不画由 `neutral-live-card.test.ts` 钉着。
 */
function liveProps(over: Partial<LiveCardView> = {}): LiveCardView {
	return {
		status: "streaming",
		username: "示例主播",
		userface: "",
		title: "【4K】周年庆典特别直播，今晚不见不散！",
		area: "虚拟主播",
		description: htmlToPlain(RICH_DESCRIPTION),
		cover: USER_COVER,
		hasCover: true,
		time: "开播时间：2026-09-13 20:00:00",
		online: formatCount(123_456),
		likes: "",
		totalViewers: "",
		fans: formatCount(88_800),
		fansChanged: "",
		...over,
	};
}

const liveInput = (
	over: Partial<LiveCardView> = {},
	fontFace?: string,
): (() => Promise<CardRenderInput>) => {
	return async () => ({
		props: liveProps(over),
		options: { title: "直播通知", font: FONT, htmlWidth: 600, ...(fontFace ? { fontFace } : {}) },
	});
};

// ── 动态卡 ────────────────────────────────────────────────────────────────────

/** 出卡器注入的时间格式化器,这里换成固定函数(不碰时钟)。数字走 `formatCount`,与真出卡同一条。 */
const FMT = { time: () => "刚刚" };

/**
 * 十份动态卡的输入是 **`Post` 字面量**({@link DYNAMIC_SAMPLE_POSTS}),经 `nodeFromPost` 造成块吃的节点 ——
 * 与真出卡(`ImageRenderer.generatePostCard`)同一条路。B 站原始夹具住在 `packages/dynamic`,那边的
 * `post-from-dynamic.test.ts` 把它们翻成 `Post` 与这里逐项对一遍(见 `post-fixtures.ts`)。
 */
const dynamicInput = (name: string): (() => Promise<CardRenderInput>) => {
	return async () => {
		const post = DYNAMIC_SAMPLE_POSTS[name];
		if (!post) throw new Error(`post-fixtures 里没有叫「${name}」的作品`);
		return {
			props: { node: nodeFromPost(post, FMT) },
			options: { title: "动态通知", font: FONT, htmlWidth: 600 },
		};
	};
};

// ── 醒目留言卡 ────────────────────────────────────────────────────────────────

/** 照 `generateSCCard` 的拼法:价格 → 电池 → 档位 → 配色 / 时长。 */
function scProps(price: number, over: Record<string, unknown> = {}): Record<string, unknown> {
	const levelIndex = getSCLevel(price * 10);
	return {
		senderFace: "http://i0.hdslb.com/bfs/face/1122334455667788990011223344556677889900.jpg",
		senderName: "示例观众",
		masterName: "示例主播",
		masterAvatarUrl: "http://i0.hdslb.com/bfs/face/0011223344556677889900aabbccddeeff001122.jpg",
		text: "主播加油！",
		price,
		duration: Object.values(SC_LEVELS)[levelIndex].duration,
		bgColor: SC_COLORS[levelIndex],
		...over,
	};
}

const scInput = (
	price: number,
	over: Record<string, unknown> = {},
): (() => Promise<CardRenderInput>) => {
	return async () => ({
		props: scProps(price, over),
		options: { title: "醒目留言通知", font: FONT, htmlWidth: 290 },
	});
};

// ── 上舰卡 ────────────────────────────────────────────────────────────────────

/** 照 `generateGuardCard` 的拼法组 props。 */
function guardProps(
	guardLevel: 1 | 2 | 3,
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		captainImgUrl: GUARD_IMG[guardLevel],
		guardLevel,
		uname: "示例观众",
		face: "http://i0.hdslb.com/bfs/face/1122334455667788990011223344556677889900.jpg",
		isAdmin: 0,
		masterAvatarUrl: "http://i0.hdslb.com/bfs/face/0011223344556677889900aabbccddeeff001122.jpg",
		masterName: "示例主播",
		bgColor: BG_COLORS[guardLevel],
		...over,
	};
}

const guardInput = (
	guardLevel: 1 | 2 | 3,
	over: Record<string, unknown> = {},
): (() => Promise<CardRenderInput>) => {
	return async () => ({
		props: guardProps(guardLevel, over),
		options: { title: "上舰通知", font: FONT, htmlWidth: 430 },
	});
};

// ── 锐评卡 ────────────────────────────────────────────────────────────────────

const roastUp = (name: string, color: string, avatar?: string) => ({ name, color, avatar });

const BOARD_PROPS: RoastBoardCardProps = {
	days: 30,
	pigeon: {
		...roastUp("示例UP·甲", "#fb7299", "http://i0.hdslb.com/bfs/face/roast-a.jpg"),
		reason: "整整一个月就发了一条，还是转发。",
	},
	// 无头像 → 退首字母圆牌那一支。
	diligent: {
		...roastUp("示例UP·乙", "#2ac864"),
		reason: "周更三条，选题还都没塌，属实勤奋。",
	},
	roast: [
		{
			...roastUp("示例UP·甲", "#fb7299", "http://i0.hdslb.com/bfs/face/roast-a.jpg"),
			comment: "鸽子精本精，建议改名叫月更。",
		},
		{
			...roastUp("示例UP·乙", "#2ac864"),
			comment: "稳得可怕，就是标题一期比一期长。",
		},
	],
	// 刻意不按分数排 —— 卡片自己会排序。
	scores: [
		{ ...roastUp("示例UP·甲", "#fb7299", "http://i0.hdslb.com/bfs/face/roast-a.jpg"), score: 41 },
		{ ...roastUp("示例UP·乙", "#2ac864"), score: 96 },
		{ ...roastUp("示例UP·丙", "#0984e3"), score: 0 },
	],
};

const SOLO_PROPS: RoastSoloCardProps = {
	days: 7,
	up: roastUp("示例UP·甲", "#fb7299", "http://i0.hdslb.com/bfs/face/roast-a.jpg"),
	verdict: "这周唯一的产出是一条「在剪了」，剪了七天，还在剪。",
	score: 32,
	highlights: [
		{ label: "涨粉", comment: "掉了两千，主要掉在周三那条动态之后。" },
		{ label: "互动", comment: "评论区比视频热闹，值得一看。" },
	],
};

// ── 夹具表 ────────────────────────────────────────────────────────────────────

export const CARD_FIXTURES: readonly CardFixture[] = [
	{
		name: "live-streaming",
		group: "直播卡",
		kind: "live",
		label: "live-streaming：直播中，封面 / 分区 / 人气 / 当前粉丝数全开",
		build: liveInput(),
	},
	{
		name: "live-ended",
		group: "直播卡",
		kind: "live",
		label:
			"live-ended：下播，点赞 + 累计观看人数(粉丝数变化不上默认卡)，自定义封面，简介空走兜底文案",
		// 下播卡的数据区是「点赞 + 累计观看人数」(ADR-0019 决策 76);粉丝数变化只进下播文案与
		// 皮肤契约,默认卡不画 —— 这份夹具给了它,快照里不该出现。
		build: liveInput({
			status: "end",
			description: "",
			time: "开播时间：2026-09-13 20:00:00",
			cover: "http://i0.hdslb.com/bfs/album/bn-custom-live-cover-0001.png",
			likes: formatCount(20_133),
			totalViewers: formatCount(31_200),
			fansChanged: "+1.2万",
		}),
	},
	{
		name: "live-minimal",
		group: "直播卡",
		kind: "live",
		label: "live-minimal：数据区整块收起 + 关键帧封面 + 改过顺序的版式",
		build: liveInput({
			status: "end",
			time: "直播时长：2小时13分",
			cover: KEYFRAME,
		}),
	},
	{
		name: "live-with-fontface",
		group: "直播卡",
		kind: "live",
		label: "live-with-fontface：带主人自带字体的 @font-face + 累计观看人数(下播)",
		build: liveInput(
			{
				status: "end",
				time: "直播时长：2小时13分",
				likes: formatCount(20_133),
				totalViewers: formatCount(31_200),
			},
			// 与 buildFontFace 出的形状一致,data URL 换成固定短串(真实的是整份字体文件)。
			'@font-face{font-family:"bn-user-font";src:url("data:font/woff2;base64,d09GMgABAAAAAAAY");font-display:block}',
		),
	},

	{
		name: "dynamic-av",
		group: "动态卡",
		kind: "dynamic",
		label: "dynamic-av：视频投稿(大会员名字色 + 投稿标签 + 主视频卡)",
		build: dynamicInput("dynamic-av"),
	},
	{
		name: "dynamic-draw",
		group: "动态卡",
		kind: "dynamic",
		label: "dynamic-draw：图文九宫格(12 张 → 9 格 + +3，含动图 / 长图角标) + 话题 + 多件商品",
		build: dynamicInput("dynamic-draw"),
	},
	{
		name: "dynamic-draw-single",
		group: "动态卡",
		kind: "dynamic",
		label: "dynamic-draw-single：单张普通比例的图 + 单件商品卡",
		build: dynamicInput("dynamic-draw-single"),
	},
	{
		name: "dynamic-word",
		group: "动态卡",
		kind: "dynamic",
		label: "dynamic-word：纯文字(emoji / @ / 话题 / BV / 抽奖 / 外链 + 换行) + 通用卡",
		build: dynamicInput("dynamic-word"),
	},
	{
		name: "dynamic-forward",
		group: "动态卡",
		kind: "dynamic",
		label: "dynamic-forward：转发一条视频投稿 + 已结束的预约卡",
		build: dynamicInput("dynamic-forward"),
	},
	{
		name: "dynamic-article",
		group: "动态卡",
		kind: "dynamic",
		label: "dynamic-article：专栏(标题 + 5 行截断 + emoji + 转义) + 超长单图",
		build: dynamicInput("dynamic-article"),
	},
	{
		name: "dynamic-with-additional",
		group: "动态卡",
		kind: "dynamic",
		label: "dynamic-with-additional：两列图廊 + 可预约的预约卡(含抽奖行)",
		build: dynamicInput("dynamic-with-additional"),
	},
	{
		name: "dynamic-custom-layout",
		group: "动态卡",
		kind: "dynamic",
		label: "dynamic-custom-layout：改顺序 + 隐藏互动数 + 末尾分割线被弹掉 + 关联视频卡",
		build: dynamicInput("dynamic-custom-layout"),
	},
	{
		name: "dynamic-charge-only",
		group: "动态卡",
		kind: "dynamic",
		label: "dynamic-charge-only：充电专属未充电的占位正文",
		build: dynamicInput("dynamic-charge-only"),
	},
	{
		name: "dynamic-unrenderable",
		group: "动态卡",
		kind: "dynamic",
		label: "dynamic-unrenderable：「暂时无法渲染」一族，附加内容被清空",
		build: dynamicInput("dynamic-unrenderable"),
	},

	{
		name: "sc-low",
		group: "醒目留言卡",
		kind: "sc",
		label: "sc-low：最低档(¥30 → Level1 配色)，留言里的 & < > 与换行都要转义",
		build: scInput(30, { text: "  主播加油！\n<b>今天也很好听</b> & 明天见  " }),
	},
	{
		name: "sc-high",
		group: "醒目留言卡",
		kind: "sc",
		label: "sc-high：最高档(¥2000 → Level6 配色)，无主播头像",
		build: scInput(2000, {
			senderName: "示例大哥",
			masterAvatarUrl: undefined,
			text: "今晚这首点给所有还没下班的人",
		}),
	},
	{
		name: "sc-custom-layout",
		group: "醒目留言卡",
		kind: "sc",
		label: "sc-custom-layout：改顺序 + 空留言(块收起) + 首尾分割线的抑制与弹出",
		build: scInput(100, { text: "" }),
	},

	{
		name: "guard-captain",
		group: "上舰卡",
		kind: "guard",
		label: "guard-captain：舰长(level 3)，徽章在右，主播名(isAdmin=0)",
		build: guardInput(3),
	},
	{
		name: "guard-governor",
		group: "上舰卡",
		kind: "guard",
		label: "guard-governor：总督(level 1)，房管(isAdmin=1)",
		build: guardInput(1, {
			uname: "示例大哥",
			isAdmin: 1,
		}),
	},
	{
		name: "guard-badge-left",
		group: "上舰卡",
		kind: "guard",
		label: "guard-badge-left：提督(level 2)，徽章在左(整列镜像右对齐) + 内容列改顺序 + 分割线",
		build: guardInput(2),
	},

	{
		name: "roast-board",
		group: "锐评卡",
		kind: "roastBoard",
		label: "roast-board：周报榜单(鸽王 / 勤奋 UP / 逐位锐评 / 评分条，含无头像的首字母圆牌)",
		build: async () => ({
			props: { ...BOARD_PROPS },
			options: { title: "UP 主周报", font: FONT, htmlWidth: 600 },
		}),
	},
	{
		name: "roast-solo",
		group: "锐评卡",
		kind: "roastSolo",
		label: "roast-solo：单人锐评(自适应名字列的评分条 + 亮点行 + 背景图)",
		build: async () => ({
			props: { ...SOLO_PROPS },
			options: { title: "UP 主锐评", font: FONT, htmlWidth: 430 },
		}),
	},

	{
		name: "wordcloud",
		group: "词云卡",
		kind: "wordcloud",
		label: "wordcloud：卡壳本体(画词脚本另行追加在这份 HTML 上)",
		// 词云出图是**两半**:这份 HTML(卡壳 + 一个空画布 `#wordCloudCanvas`)+ 塞在
		// `</body>` 前的画词脚本(`wordCloudInitScript`,两段 static/*.js 原样读盘拼进去)。
		// 基准只钉前一半:后一半与模板无关,且体量上百 KB,钉进快照只会淹掉真正要比对的部分。
		// ⚠️ 卡壳这一半今天由**皮肤**装配(`generateWordCloudImg` → `renderCardWithSkin`);
		// 这里走的是旧模板那条路,它现在的身份就是「标尺」(见 `templates/block-layout.tsx`)。
		build: async () => ({
			props: {
				masterName: "示例主播",
				masterAvatarUrl:
					"http://i0.hdslb.com/bfs/face/0011223344556677889900aabbccddeeff001122.jpg",
			},
			options: { title: "弹幕词云", font: FONT, htmlWidth: 720 },
		}),
	},
];
