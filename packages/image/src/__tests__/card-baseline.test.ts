/**
 * 七种推送卡片的**现状快照**(模板重构的验收基准)。
 *
 * 这份文件刻意钉的是 `renderCard()` 出的**完整 HTML 字节**(含 UnoCSS 生成的整段
 * CSS),与本包「只测块装配契约、不测 HTML / CSS 拼装」的惯例是直接冲突的 —— 冲突
 * 是**有意的,且只限模板重构期**:接下来要把各模板拆成块,验收标准就是「重构前后逐
 * 字节一致」,那就只有字节本身能当基准。重构落地后这份基准要么删掉、要么降级成几条
 * 结构断言;别把它当长期的版式测试用 —— 任何 restyle 都会让它整片变红,那正是它此刻
 * 该做的事。
 *
 * 夹具刻意铺开各模板的条件分支(封面有无 / 粉丝数据三态 / VIP 名字色 / 话题 / 附加
 * 内容四型 / 图廊三种形态 / 分割线的开头抑制与末尾弹出 …),让一次重构能一次照出问题。
 * 夹具里的 URL 都是**形状真实但不存在**的 B 站地址 —— `renderCard` 不取图,不需要
 * 真能访问。
 *
 * props 一律照 `image-renderer.ts` 里对应 `generate*Card` 的拼法(含 title /
 * htmlWidth / font),动态卡的 node 经 `buildDynamicNode(dynamic, false, fmt)` 构造,
 * fmt 用固定函数,不碰真实时钟。
 */

import { type CardBlock, DIVIDER_TYPE, type GuardLayout } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { numberToStr } from "../format";
import { renderCard } from "../render";
import { BG_COLORS, getSCLevel, SC_COLORS, SC_LEVELS } from "../styles";
import { DynamicCard } from "../templates/dynamic-card";
import { buildDynamicNode, type NodeFormatters } from "../templates/dynamic-content";
import { GuardCard } from "../templates/guard-card";
import { LiveCard } from "../templates/live-card";
import {
	RoastBoardCard,
	type RoastBoardCardProps,
	RoastSoloCard,
	type RoastSoloCardProps,
} from "../templates/roast-card";
import { SCCard } from "../templates/sc-card";
import { WordCloudCard } from "../templates/wordcloud-card";
import type { Dynamic, RichTextNode } from "../types";

// ── 公共常量 ──────────────────────────────────────────────────────────────────

/** 出厂默认字体(DEFAULT_CARD_STYLE.font)。全部快照固定用它,不传 fontFace。 */
const FONT = "PingFang SC, sans-serif";

/** 出厂默认渐变(DEFAULT_CARD_STYLE)。 */
const COLOR_START = "#e0c3fc";
const COLOR_END = "#8ec5fc";

/** 「自定义背景图已解析成 URL」那一支;真实形态是 data URL,这里用等价的远程 URL。 */
const BG_IMAGE = "http://i0.hdslb.com/bfs/album/bn-custom-background-0001.png";

/** GUARD_LEVEL_IMG(image-renderer 私有,不为测试改导出,按现状抄一份)。 */
const GUARD_IMG = {
	1: "https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/governor-DpDXKEdA.png",
	2: "https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/supervisor-u43ElIjU.png",
	3: "https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/captain-Bjw5Byb5.png",
} as const;

/** 把一份渲染结果钉进 `__snapshots__/card-baseline/<名字>.html`。 */
async function snap(name: string, html: string): Promise<void> {
	await expect(html).toMatchFileSnapshot(`./__snapshots__/card-baseline/${name}.html`);
}

// ── 直播卡 ────────────────────────────────────────────────────────────────────

/** B 站直播间接口里模板真正读到的那几个字段。 */
function liveRoom(over: Record<string, unknown> = {}) {
	return {
		title: "【4K】周年庆典特别直播，今晚不见不散！",
		area_name: "虚拟主播",
		user_cover: "http://i0.hdslb.com/bfs/live/new_room_cover/0a1b2c3d4e5f60718293.jpg",
		keyframe: "http://i0.hdslb.com/bfs/live-key-frame/keyframe0102030405060708.jpg",
		// 富文本简介:htmlToPlain 要把标签与 entity 都剥成纯文本。
		description:
			"<p>每晚八点开播&nbsp;&amp;&nbsp;周末加场</p><br>&lt;b&gt;联系方式见动态&lt;/b&gt;",
		online: 123_456,
		...over,
	};
}

/** 照 `generateLiveCard` 的拼法组 props(数字都经 numberToStr)。 */
function liveProps(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		showPopularity: true,
		showArea: true,
		showFans: true,
		cardColorStart: COLOR_START,
		cardColorEnd: COLOR_END,
		glassOpacity: undefined,
		glassClear: false,
		backgroundImage: "",
		data: liveRoom(),
		username: "示例主播",
		userface: "http://i0.hdslb.com/bfs/face/0011223344556677889900aabbccddeeff001122.jpg",
		titleStatus: "开播啦",
		liveTime: "开播时间：2026-09-13 20:00:00",
		liveStatus: 1,
		cover: true,
		coverOverride: undefined,
		onlineNum: numberToStr(123_456),
		likedNum: "",
		watchedNum: "",
		fansNum: numberToStr(88_800),
		fansChanged: "",
		layout: undefined,
		...over,
	};
}

const renderLive = (over: Record<string, unknown> = {}) =>
	renderCard(LiveCard, liveProps(over), { title: "直播通知", font: FONT, htmlWidth: 600 });

/** live-minimal 的版式:块顺序打乱、简介整块隐藏。 */
const LIVE_CUSTOM_LAYOUT: CardBlock[] = [
	{ id: "header", type: "header", visible: true },
	{ id: "divider-1", type: DIVIDER_TYPE, visible: true, marginTop: 10 },
	{ id: "title", type: "title", visible: true, marginTop: 12 },
	{ id: "cover", type: "cover", visible: true, marginTop: 12 },
	{ id: "data", type: "data", visible: true, marginTop: 10 },
	{ id: "desc", type: "desc", visible: false, marginTop: 16 },
];

describe("卡片渲染基准 — 直播卡", () => {
	it("live-streaming：直播中，封面 / 分区 / 人气 / 当前粉丝数全开", async () => {
		await snap("live-streaming", await renderLive());
	});

	it("live-ended：下播(liveStatus=3)，点赞 + 粉丝数变化，自定义封面，简介空走兜底文案", async () => {
		// liveStatus=3 是**模板自己**的下播分支(点赞 / 粉丝数变化);注意 `generateLiveCard`
		// 会先把 3 归一成角标用的 2 再传进来,所以真机上这一支的角标是「已下播」而这里是
		// 「未开播」—— 这条 quirk 属于现状,基准照钉,重构时别顺手"修"掉。
		await snap(
			"live-ended",
			await renderLive({
				data: liveRoom({ description: "" }),
				titleStatus: "下播啦",
				liveTime: "开播时间：2026-09-13 20:00:00",
				liveStatus: 3,
				cover: true,
				coverOverride: "http://i0.hdslb.com/bfs/album/bn-custom-live-cover-0001.png",
				likedNum: numberToStr(20_133),
				fansNum: numberToStr(88_800),
				fansChanged: "+1.2万",
				glassClear: true,
			}),
		);
	});

	it("live-minimal：三个开关全关(数据区整块收起) + 关键帧封面 + 背景图 + 改过顺序的版式", async () => {
		await snap(
			"live-minimal",
			await renderLive({
				showPopularity: false,
				showArea: false,
				showFans: false,
				titleStatus: "正在直播",
				liveTime: "直播时长：2小时13分",
				liveStatus: 2,
				cover: false,
				glassOpacity: 0.45,
				backgroundImage: BG_IMAGE,
				layout: LIVE_CUSTOM_LAYOUT,
			}),
		);
	});

	it("live-with-fontface：带主人自带字体的 @font-face + 累计观看人数(liveStatus=2)", async () => {
		const html = await renderCard(
			LiveCard,
			liveProps({
				titleStatus: "正在直播",
				liveTime: "直播时长：2小时13分",
				liveStatus: 2,
				watchedNum: numberToStr(31_200),
			}),
			{
				title: "直播通知",
				font: FONT,
				htmlWidth: 600,
				// 与 buildFontFace 出的形状一致,data URL 换成固定短串(真实的是整份字体文件)。
				fontFace:
					'@font-face{font-family:"bn-user-font";src:url("data:font/woff2;base64,d09GMgABAAAAAAAY");font-display:block}',
			},
		);
		await snap("live-with-fontface", html);
	});
});

// ── 动态卡 ────────────────────────────────────────────────────────────────────

/** image-renderer 注入的格式化器,这里换成固定函数(不碰时钟)。 */
const fmt: NodeFormatters = { time: () => "刚刚", num: (n: number) => String(n) };

function author(over: Record<string, unknown> = {}): Dynamic["modules"]["module_author"] {
	return {
		avatar: {},
		face: "http://i0.hdslb.com/bfs/face/aabbccddeeff00112233445566778899aabbccdd.jpg",
		face_nft: false,
		following: true,
		jump_url: "//space.bilibili.com/2233",
		label: "",
		mid: 2233,
		name: "示例UP",
		pub_action: "",
		pub_action_text: "",
		pub_location_text: "IP属地：上海",
		pub_time: "刚刚",
		pub_ts: 1_700_000_000,
		type: "AUTHOR_TYPE_NORMAL",
		vip: { type: 0 },
		...over,
	} as Dynamic["modules"]["module_author"];
}

function stat(forward = 128, comment = 456, like = 7890) {
	return { forward: { count: forward }, comment: { count: comment }, like: { count: like } };
}

const textNode = (text: string) => ({
	type: "RICH_TEXT_NODE_TYPE_TEXT",
	orig_text: text,
	text,
});

const richNode = (type: string, text: string, extra: Record<string, unknown> = {}) => ({
	type,
	orig_text: text,
	text,
	...extra,
});

const emojiNode = (text: string, iconUrl: string) => ({
	type: "RICH_TEXT_NODE_TYPE_EMOJI",
	orig_text: text,
	text,
	emoji: { icon_url: iconUrl, size: 1, text, type: 1 },
});

type Pic = { width: number; height: number; url: string; size?: number; live_url?: string };

/** 一张普通方图。 */
function pic(over: Partial<Pic> = {}): Pic {
	return {
		width: 1440,
		height: 1440,
		url: "http://i0.hdslb.com/bfs/new_dyn/00112233445566778899aabbccddeeff.jpg",
		size: 233,
		...over,
	};
}

/** 组一条动态。`modules.module_dynamic` 由调用方给全(各类型差异都在里面)。 */
function dynamic(
	type: string,
	moduleDynamic: Record<string, unknown>,
	over: Record<string, unknown> = {},
): Dynamic {
	return {
		basic: { is_only_fans: false },
		id_str: "1000000000000000001",
		type,
		visible: true,
		modules: {
			module_author: author(),
			module_dynamic: moduleDynamic,
			module_stat: stat(),
			...((over.modules as Record<string, unknown>) ?? {}),
		},
		...over,
	} as unknown as Dynamic;
}

/** 照 `generateDynamicCard` 的拼法组 props 并渲染。 */
async function renderDynamic(data: Dynamic, over: Record<string, unknown> = {}): Promise<string> {
	const node = await buildDynamicNode(data, false, fmt);
	return renderCard(
		DynamicCard,
		{
			cardColorStart: COLOR_START,
			cardColorEnd: COLOR_END,
			glassOpacity: undefined,
			glassClear: false,
			backgroundImage: "",
			node,
			layout: undefined,
			...over,
		},
		{ title: "动态通知", font: FONT, htmlWidth: 600 },
	);
}

// ── 动态卡:附加内容(四型) ──────────────────────────────────────────────────

const RESERVE_ACTIVE = {
	type: "ADDITIONAL_TYPE_RESERVE",
	reserve: {
		title: "周年庆典直播预约",
		desc1: { text: "预计 09-20 20:00 直播" },
		desc2: { text: "2.3万人预约" },
		desc3: { text: "参与抽奖：限定手办 ×3", jump_url: "//www.bilibili.com/h5/lottery/result" },
		button: { uncheck: { text: "预约" }, check: { text: "已预约" }, type: 1 },
	},
};

const RESERVE_ENDED = {
	type: "ADDITIONAL_TYPE_RESERVE",
	reserve: {
		title: "上周的联动直播",
		desc1: { text: "09-06 20:00 直播" },
		desc2: { text: "1.1万人预约" },
		// desc3 缺席 —— 没有抽奖的那一支。
		button: { uncheck: { text: "已结束" }, check: { text: "已结束" }, type: 1 },
	},
};

const GOODS_MULTI = {
	type: "ADDITIONAL_TYPE_GOODS",
	goods: {
		head_text: "UP 主推荐",
		items: [
			{
				cover: "http://i0.hdslb.com/bfs/mall/goods-0001.jpg",
				name: "示例周边 A",
				price: "￥68",
				jump_desc: "去看看",
			},
			{
				cover: "http://i0.hdslb.com/bfs/mall/goods-0002.jpg",
				name: "示例周边 B",
				price: "￥128",
				jump_desc: "",
			},
			{
				cover: "http://i0.hdslb.com/bfs/mall/goods-0003.jpg",
				name: "示例周边 C",
				price: "￥298",
				jump_desc: "去看看",
			},
		],
	},
};

const GOODS_SINGLE = {
	type: "ADDITIONAL_TYPE_GOODS",
	goods: {
		head_text: "UP 主推荐",
		items: [
			{
				cover: "http://i0.hdslb.com/bfs/mall/goods-0001.jpg",
				name: "示例周边 A —— 一个足够长、需要两行才放得下的商品名称示例",
				price: "￥68",
				// jump_desc 空串 → 走「去看看」兜底。
				jump_desc: "",
			},
		],
	},
};

const COMMON_GAME = {
	type: "ADDITIONAL_TYPE_COMMON",
	common: {
		sub_type: "game",
		head_text: "相关游戏",
		cover: "http://i0.hdslb.com/bfs/game/common-cover-0001.png",
		title: "示例游戏：起源",
		desc1: "官方正版授权",
		desc2: "已有 12.8万 人预约",
		button: { jump_style: { text: "去下载" }, jump_url: "//www.biligame.com/detail" },
	},
};

const UGC_LINKED = {
	type: "ADDITIONAL_TYPE_UGC",
	ugc: {
		id_str: "117000193967716",
		head_text: "相关视频",
		title: "上一期：我们是怎么被坑的",
		desc_second: "2654观看 102弹幕",
		jump_url: "//www.bilibili.com/video/BV1Zn366gEJe",
		cover: "http://i1.hdslb.com/bfs/archive/d75b1c5900112233445566778899aabbccddeeff.jpg",
		duration: "00:29",
		multi_line: true,
	},
};

// ── 动态卡:各类型夹具 ────────────────────────────────────────────────────────

/** DYNAMIC_TYPE_AV —— 视频投稿。作者是大会员(名字走粉色),带「投稿了视频」标签。 */
const AV_DYNAMIC = ((): Dynamic => {
	const d = dynamic("DYNAMIC_TYPE_AV", {
		desc: {
			text: "新视频来啦，记得一键三连！",
			rich_text_nodes: [textNode("新视频来啦，记得一键三连！")] as RichTextNode,
		},
		major: {
			type: "MAJOR_TYPE_ARCHIVE",
			archive: {
				badge: { text: "投稿视频" },
				cover: "http://i1.hdslb.com/bfs/archive/15644012e6961428b08a947ec83365747c741d41.jpg",
				duration_text: "16:07",
				title: "因为揭穿了他们的秘密！我们遭到了陷害！MC恐怖地图 毒药",
				desc: "剪辑：@示例剪辑师　BGM：示例曲目",
				stat: { play: "1.8万", danmaku: "129" },
				bvid: "BV1FTGM69EFQ",
				jump_url: "//www.bilibili.com/video/BV1FTGM69EFQ",
			},
		},
	});
	d.modules.module_author = author({ name: "示例UP·大会员", vip: { type: 1 } });
	return d;
})();

/** DYNAMIC_TYPE_DRAW —— 图文。12 张图(铺 9 张 + `+3`),含动图 / 长图角标;带话题 + 多件商品。 */
const DRAW_DYNAMIC = dynamic("DYNAMIC_TYPE_DRAW", {
	topic: { id: 1, name: "周年庆典", jump_url: "//www.bilibili.com/topic/1" },
	major: {
		type: "MAJOR_TYPE_OPUS",
		opus: {
			fold_action: ["展开"],
			jump_url: "//www.bilibili.com/opus/1000000000000000001",
			summary: {
				text: "现场返图来啦",
				rich_text_nodes: [textNode("现场返图来啦，挑了几张最满意的～")] as RichTextNode,
			},
			pics: [
				pic(),
				// `.gif` 藏在处理后缀与 query 后面 —— 削掉两截才认得出来。
				pic({ url: "http://i0.hdslb.com/bfs/new_dyn/anim01.gif@1280w_80q_1s.webp?from=dyn" }),
				// live_url 非空 = B 站自己标的动图。
				pic({
					url: "http://i0.hdslb.com/bfs/new_dyn/anim02.jpg",
					live_url: "http://i0.hdslb.com/bfs/new_dyn/anim02.mp4",
				}),
				// 高 > 宽 ×2 → 长图角标 + object-top。
				pic({ width: 900, height: 2700, url: "http://i0.hdslb.com/bfs/new_dyn/long01.jpg" }),
				pic({ url: "http://i0.hdslb.com/bfs/new_dyn/p05.jpg" }),
				pic({ url: "http://i0.hdslb.com/bfs/new_dyn/p06.jpg" }),
				pic({ url: "http://i0.hdslb.com/bfs/new_dyn/p07.jpg" }),
				pic({ url: "http://i0.hdslb.com/bfs/new_dyn/p08.jpg" }),
				pic({ url: "http://i0.hdslb.com/bfs/new_dyn/p09.jpg" }),
				pic({ url: "http://i0.hdslb.com/bfs/new_dyn/p10.jpg" }),
				pic({ url: "http://i0.hdslb.com/bfs/new_dyn/p11.jpg" }),
				pic({ url: "http://i0.hdslb.com/bfs/new_dyn/p12.jpg" }),
			],
		},
	},
	additional: GOODS_MULTI,
});

/** 单图图文 —— 普通比例(既不长也不超长)那一支,配单件商品卡。 */
const DRAW_SINGLE_DYNAMIC = dynamic("DYNAMIC_TYPE_DRAW", {
	major: {
		type: "MAJOR_TYPE_OPUS",
		opus: {
			fold_action: ["展开"],
			jump_url: "//www.bilibili.com/opus/1000000000000000002",
			summary: {
				text: "新周边到货",
				rich_text_nodes: [textNode("新周边到货，开箱图一张。")] as RichTextNode,
			},
			pics: [pic({ width: 1920, height: 1080, url: "http://i0.hdslb.com/bfs/new_dyn/one01.jpg" })],
		},
	},
	additional: GOODS_SINGLE,
});

/** DYNAMIC_TYPE_WORD —— 纯文字。富文本把 emoji / @ / 话题 / BV / 抽奖 / 外链全走一遍。 */
const WORD_DYNAMIC = dynamic("DYNAMIC_TYPE_WORD", {
	desc: {
		text: "感谢大家",
		rich_text_nodes: [
			textNode("感谢大家这一年的陪伴 "),
			emojiNode(
				"[doge]",
				"http://i0.hdslb.com/bfs/emote/4191e94d4b0d8e69f6d1b6d5b6b6f0a3d1c9a1a1.png",
			),
			textNode("\n本期鸣谢 "),
			richNode("RICH_TEXT_NODE_TYPE_AT", "@示例剪辑师", { rid: "12345" }),
			textNode(" 与 "),
			richNode("RICH_TEXT_NODE_TYPE_TOPIC", "#周年庆典#", { jump_url: "//t.bilibili.com/topic/1" }),
			textNode("\n往期回顾："),
			richNode("RICH_TEXT_NODE_TYPE_BV", "BV1FTGM69EFQ", {
				rid: "BV1FTGM69EFQ",
				jump_url: "//www.bilibili.com/video/BV1FTGM69EFQ",
			}),
			textNode("\n"),
			richNode("RICH_TEXT_NODE_TYPE_LOTTERY", "互动抽奖", { rid: "998877" }),
			textNode("\n详情戳 "),
			richNode("RICH_TEXT_NODE_TYPE_WEB", "网页链接", { jump_url: "https://www.bilibili.com" }),
		] as unknown as RichTextNode,
	},
	additional: COMMON_GAME,
});

/** DYNAMIC_TYPE_FORWARD —— 转发一条视频投稿(内层不带互动数、类型标签挂在名字后)。 */
const FORWARD_DYNAMIC = ((): Dynamic => {
	const d = dynamic("DYNAMIC_TYPE_FORWARD", {
		desc: {
			text: "这期真的建议看完",
			rich_text_nodes: [textNode("这期真的建议看完，后半段有反转。")] as RichTextNode,
		},
		additional: RESERVE_ENDED,
	});
	d.modules.module_author = author({ name: "示例转发者", mid: 4455 });
	d.orig = AV_DYNAMIC;
	return d;
})();

/** DYNAMIC_TYPE_ARTICLE —— 专栏。走 parseRichTextArticle(innerHTML 骨架 + 5 行截断),配超长单图。 */
const ARTICLE_DYNAMIC = dynamic("DYNAMIC_TYPE_ARTICLE", {
	major: {
		type: "MAJOR_TYPE_OPUS",
		opus: {
			fold_action: ["展开"],
			jump_url: "//www.bilibili.com/opus/1000000000000000003",
			title: "年度总结：我们是怎么把一个小频道做起来的",
			summary: {
				text: "年度总结",
				rich_text_nodes: [
					// 转义面也一并钉住:尖括号 / & / 引号都必须变成实体。
					textNode('第一段：起点 <b>2019</b> & "那年冬天"\n'),
					textNode("第二段：第一个一万粉\n"),
					textNode("第三段：第一次线下\n"),
					textNode("第四段：踩过的坑\n"),
					textNode("第五段：接下来要做的事\n"),
					textNode("第六段：这一段会被 5 行截断吃掉\n"),
					emojiNode("[脱单doge]", "http://i0.hdslb.com/bfs/emote/tuodan-doge.png"),
					textNode("第七段：同上"),
				] as unknown as RichTextNode,
			},
			pics: [
				// 高 > 宽 ×2 → 固定 400px 高、object-cover object-top 那一支,角标「长图」。
				pic({ width: 900, height: 4800, url: "http://i0.hdslb.com/bfs/article/superlong.jpg" }),
			],
		},
	},
});

/** 带附加内容的图文:2 张图(两列图廊)+ 可预约的预约卡(含抽奖行)。 */
const WITH_ADDITIONAL_DYNAMIC = dynamic("DYNAMIC_TYPE_DRAW", {
	desc: {
		text: "下周的直播定了",
		rich_text_nodes: [textNode("下周的直播定了，先放两张预告图。")] as RichTextNode,
	},
	major: {
		type: "MAJOR_TYPE_OPUS",
		opus: {
			fold_action: ["展开"],
			jump_url: "//www.bilibili.com/opus/1000000000000000004",
			pics: [
				pic({ url: "http://i0.hdslb.com/bfs/new_dyn/pre01.jpg" }),
				pic({ url: "http://i0.hdslb.com/bfs/new_dyn/pre02.jpg" }),
			],
		},
	},
	additional: RESERVE_ACTIVE,
});

/** 自定义版式用的动态:单张「长图」(高 > 宽但不足两倍)+ 关联视频小卡。 */
const CUSTOM_LAYOUT_DYNAMIC = dynamic("DYNAMIC_TYPE_DRAW", {
	major: {
		type: "MAJOR_TYPE_OPUS",
		opus: {
			fold_action: ["展开"],
			jump_url: "//www.bilibili.com/opus/1000000000000000005",
			summary: {
				text: "流程图放这儿",
				rich_text_nodes: [textNode("流程图放这儿，配合上期视频看。")] as RichTextNode,
			},
			pics: [
				// 高 > 宽、但不到两倍 → inline-block + max-height:400px 那一支;live_url 让角标出「动图」。
				pic({
					width: 1000,
					height: 1600,
					url: "http://i0.hdslb.com/bfs/new_dyn/mid-long.jpg",
					live_url: "http://i0.hdslb.com/bfs/new_dyn/mid-long.mp4",
				}),
			],
		},
	},
	additional: UGC_LINKED,
});

/** 充电专属且未充电:接口把 module_dynamic 整体清空 → 占位提示(带徽标图那一支)。 */
const CHARGE_ONLY_DYNAMIC = ((): Dynamic => {
	const d = dynamic("DYNAMIC_TYPE_DRAW", {});
	d.basic = { is_only_fans: true };
	d.modules.module_author = author({
		icon_badge: {
			text: "充电专属",
			icon: "http://i0.hdslb.com/bfs/dynamic/charge-badge-0001.png",
		},
	});
	return d;
})();

/** 「我暂时无法渲染」那一族(收藏夹分享)。附加内容会被显式清成 null,块自动收起。 */
const UNRENDERABLE_DYNAMIC = dynamic("DYNAMIC_TYPE_MEDIALIST", {
	major: { type: "MAJOR_TYPE_MEDIALIST" },
	additional: COMMON_GAME,
});

/** 动态卡自定义版式:头像行挪到最后、互动数隐藏、末尾留一条会被弹掉的分割线。 */
const DYNAMIC_CUSTOM_LAYOUT: CardBlock[] = [
	{ id: "content", type: "content", visible: true },
	{ id: "divider-1", type: DIVIDER_TYPE, visible: true, marginTop: 12 },
	{ id: "additional", type: "additional", visible: true, marginTop: 12 },
	{ id: "divider-2", type: DIVIDER_TYPE, visible: true, marginTop: 12 },
	{ id: "header", type: "header", visible: true, marginTop: 12 },
	{ id: "stats", type: "stats", visible: false, marginTop: 12 },
	{ id: "divider-3", type: DIVIDER_TYPE, visible: true, marginTop: 12 },
];

describe("卡片渲染基准 — 动态卡", () => {
	it("dynamic-av：视频投稿(大会员名字色 + 投稿标签 + 主视频卡)", async () => {
		await snap("dynamic-av", await renderDynamic(AV_DYNAMIC));
	});

	it("dynamic-draw：图文九宫格(12 张 → 9 格 + +3，含动图 / 长图角标) + 话题 + 多件商品", async () => {
		await snap("dynamic-draw", await renderDynamic(DRAW_DYNAMIC));
	});

	it("dynamic-draw-single：单张普通比例的图 + 单件商品卡", async () => {
		await snap("dynamic-draw-single", await renderDynamic(DRAW_SINGLE_DYNAMIC));
	});

	it("dynamic-word：纯文字(emoji / @ / 话题 / BV / 抽奖 / 外链 + 换行) + 通用卡", async () => {
		await snap("dynamic-word", await renderDynamic(WORD_DYNAMIC));
	});

	it("dynamic-forward：转发一条视频投稿 + 已结束的预约卡", async () => {
		await snap("dynamic-forward", await renderDynamic(FORWARD_DYNAMIC));
	});

	it("dynamic-article：专栏(标题 + 5 行截断 + emoji + 转义) + 超长单图", async () => {
		await snap("dynamic-article", await renderDynamic(ARTICLE_DYNAMIC));
	});

	it("dynamic-with-additional：两列图廊 + 可预约的预约卡(含抽奖行)", async () => {
		await snap("dynamic-with-additional", await renderDynamic(WITH_ADDITIONAL_DYNAMIC));
	});

	it("dynamic-custom-layout：改顺序 + 隐藏互动数 + 末尾分割线被弹掉 + 关联视频卡", async () => {
		await snap(
			"dynamic-custom-layout",
			await renderDynamic(CUSTOM_LAYOUT_DYNAMIC, {
				layout: DYNAMIC_CUSTOM_LAYOUT,
				glassOpacity: 0.6,
				backgroundImage: BG_IMAGE,
			}),
		);
	});

	it("dynamic-charge-only：充电专属未充电的占位正文", async () => {
		await snap("dynamic-charge-only", await renderDynamic(CHARGE_ONLY_DYNAMIC));
	});

	it("dynamic-unrenderable：「暂时无法渲染」一族，附加内容被清空", async () => {
		await snap("dynamic-unrenderable", await renderDynamic(UNRENDERABLE_DYNAMIC));
	});

	it("dynamic-live-rcmd 没有快照 —— 开播动态在 buildDynamicNode 里直接抛，压根到不了 renderCard", async () => {
		// 现状即如此(`throw new Error("直播开播动态，不做处理")`):开播走直播卡那条路,
		// 动态卡不处理。重构后若这条不再抛,是行为变化,这里会红。
		await expect(
			buildDynamicNode(dynamic("DYNAMIC_TYPE_LIVE_RCMD", {}), false, fmt),
		).rejects.toThrow("直播开播动态");
	});
});

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
		layout: undefined,
		glassOpacity: undefined,
		glassClear: false,
		backgroundImage: "",
		...over,
	};
}

const renderSc = (price: number, over: Record<string, unknown> = {}) =>
	renderCard(SCCard, scProps(price, over), {
		title: "醒目留言通知",
		font: FONT,
		htmlWidth: 290,
	});

/** sc 自定义版式:开头的分割线被抑制、末尾的被弹出,留言块因空文本收起。 */
const SC_CUSTOM_LAYOUT: CardBlock[] = [
	{ id: "divider-0", type: DIVIDER_TYPE, visible: true },
	{ id: "sender", type: "sender", visible: true },
	{ id: "divider-1", type: DIVIDER_TYPE, visible: true, marginTop: 15 },
	{ id: "amount", type: "amount", visible: true, marginTop: 12 },
	{ id: "message", type: "message", visible: true, marginTop: 12 },
	{ id: "divider-2", type: DIVIDER_TYPE, visible: true, marginTop: 12 },
];

describe("卡片渲染基准 — 醒目留言卡", () => {
	it("sc-low：最低档(¥30 → Level1 配色)，留言里的 & < > 与换行都要转义", async () => {
		await snap(
			"sc-low",
			await renderSc(30, {
				text: "  主播加油！\n<b>今天也很好听</b> & 明天见  ",
			}),
		);
	});

	it("sc-high：最高档(¥2000 → Level6 配色)，无主播头像，背景图 + 自定义玻璃", async () => {
		await snap(
			"sc-high",
			await renderSc(2000, {
				senderName: "示例大哥",
				masterAvatarUrl: undefined,
				text: "今晚这首点给所有还没下班的人",
				glassOpacity: 0.5,
				backgroundImage: BG_IMAGE,
			}),
		);
	});

	it("sc-custom-layout：改顺序 + 空留言(块收起) + 首尾分割线的抑制与弹出 + 完全透明", async () => {
		await snap(
			"sc-custom-layout",
			await renderSc(100, {
				text: "",
				layout: SC_CUSTOM_LAYOUT,
				glassClear: true,
			}),
		);
	});
});

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
		layout: undefined,
		glassOpacity: undefined,
		glassClear: false,
		backgroundImage: "",
		...over,
	};
}

const renderGuard = (guardLevel: 1 | 2 | 3, over: Record<string, unknown> = {}) =>
	renderCard(GuardCard, guardProps(guardLevel, over), {
		title: "上舰通知",
		font: FONT,
		htmlWidth: 430,
	});

/** 徽章靠左 + 内容列改顺序 + 插一条分割线。 */
const GUARD_LEFT_LAYOUT: GuardLayout = {
	badgeSide: "left",
	blocks: [
		{ id: "text", type: "text", visible: true },
		{ id: "divider-1", type: DIVIDER_TYPE, visible: true, marginTop: 8 },
		{ id: "name", type: "name", visible: true, marginTop: 8 },
	],
};

describe("卡片渲染基准 — 上舰卡", () => {
	it("guard-captain：舰长(level 3)，徽章在右，主播名(isAdmin=0)", async () => {
		await snap("guard-captain", await renderGuard(3));
	});

	it("guard-governor：总督(level 1)，房管(isAdmin=1)，背景图 + 完全透明", async () => {
		await snap(
			"guard-governor",
			await renderGuard(1, {
				uname: "示例大哥",
				isAdmin: 1,
				glassClear: true,
				backgroundImage: BG_IMAGE,
			}),
		);
	});

	it("guard-badge-left：提督(level 2)，徽章在左(整列镜像右对齐) + 内容列改顺序 + 分割线", async () => {
		await snap(
			"guard-badge-left",
			await renderGuard(2, { layout: GUARD_LEFT_LAYOUT, glassOpacity: 0.6 }),
		);
	});
});

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
	cardColorStart: COLOR_START,
	cardColorEnd: COLOR_END,
	glassOpacity: undefined,
	glassClear: false,
	backgroundImage: "",
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
	cardColorStart: COLOR_START,
	cardColorEnd: COLOR_END,
	glassOpacity: undefined,
	glassClear: false,
	backgroundImage: BG_IMAGE,
};

describe("卡片渲染基准 — 锐评卡", () => {
	it("roast-board：周报榜单(鸽王 / 勤奋 UP / 逐位锐评 / 评分条，含无头像的首字母圆牌)", async () => {
		await snap(
			"roast-board",
			await renderCard(
				RoastBoardCard,
				{ ...BOARD_PROPS },
				{
					title: "UP 主周报",
					font: FONT,
					htmlWidth: 600,
				},
			),
		);
	});

	it("roast-solo：单人锐评(自适应名字列的评分条 + 亮点行 + 背景图)", async () => {
		await snap(
			"roast-solo",
			await renderCard(
				RoastSoloCard,
				{ ...SOLO_PROPS },
				{
					title: "UP 主锐评",
					font: FONT,
					htmlWidth: 430,
				},
			),
		);
	});
});

// ── 词云卡 ────────────────────────────────────────────────────────────────────

describe("卡片渲染基准 — 词云卡", () => {
	it("wordcloud：卡壳本体(buildWordCloudHtml 在这份 HTML 上再追加词云脚本)", async () => {
		// `generateWordCloudImg` 不直接调 renderCard,而是经 `buildWordCloudHtml`:
		// 后者先 `renderCard(WordCloudCard, …, { title: "弹幕词云", htmlWidth: 720 })`
		// 出这份 HTML,再把两段 static/*.js 与一段初始化脚本塞进 `</body>` 前。
		// 模板重构影响的只有这一半,所以基准钉这一半;那两段脚本是原样读盘拼进去的,
		// 与模板无关(且体量上百 KB,钉进快照只会淹掉真正要比对的部分)。
		await snap(
			"wordcloud",
			await renderCard(
				WordCloudCard,
				{
					masterName: "示例主播",
					masterAvatarUrl:
						"http://i0.hdslb.com/bfs/face/0011223344556677889900aabbccddeeff001122.jpg",
					colorStart: COLOR_START,
					colorEnd: COLOR_END,
				},
				{ title: "弹幕词云", font: FONT, htmlWidth: 720 },
			),
		);
	});
});
