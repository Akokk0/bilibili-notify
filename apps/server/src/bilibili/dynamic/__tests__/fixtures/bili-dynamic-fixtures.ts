/**
 * B 站原始动态夹具 —— 十份 `dynamic-*` 出图基准的**输入**(从 `packages/image` 搬来)。
 *
 * 形状真实但不存在的数据:接口原样的字段,图地址都是不会被访问的假地址。`post-from-dynamic.test.ts` 把每一份
 * 翻成 `Post`,与 `packages/image` 的基准用的 `Post` 对一遍(`@bilibili-notify/image/testing` 的 `DYNAMIC_SAMPLE_POSTS`)—
 * 翻译这一腿与出图那一腿共用同一份中间产物,所以「原始数据 → 字节」整条链都钉着。
 */

import type { Dynamic } from "../../types";

// ── 动态卡 ────────────────────────────────────────────────────────────────────

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

/** 开播动态 —— 没有快照,`postFromDynamic` 在顶层直接抛(见 `post-from-dynamic.test.ts` 里那条用例)。 */
export const LIVE_RCMD_DYNAMIC = dynamic("DYNAMIC_TYPE_LIVE_RCMD", {});

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
			rich_text_nodes: [textNode("新视频来啦，记得一键三连！")],
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
				rich_text_nodes: [textNode("现场返图来啦，挑了几张最满意的～")],
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
				rich_text_nodes: [textNode("新周边到货，开箱图一张。")],
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
		],
	},
	additional: COMMON_GAME,
});

/** DYNAMIC_TYPE_FORWARD —— 转发一条视频投稿(内层不带互动数、类型标签挂在名字后)。 */
const FORWARD_DYNAMIC = ((): Dynamic => {
	const d = dynamic("DYNAMIC_TYPE_FORWARD", {
		desc: {
			text: "这期真的建议看完",
			rich_text_nodes: [textNode("这期真的建议看完，后半段有反转。")],
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
				],
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
		rich_text_nodes: [textNode("下周的直播定了，先放两张预告图。")],
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
				rich_text_nodes: [textNode("流程图放这儿，配合上期视频看。")],
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

/** 十份出图基准的原始输入,键是基准的样例名(`__snapshots__/card-baseline/<名>.html`)。 */
export const BILI_DYNAMIC_SAMPLES: Readonly<Record<string, Dynamic>> = {
	"dynamic-av": AV_DYNAMIC,
	"dynamic-draw": DRAW_DYNAMIC,
	"dynamic-draw-single": DRAW_SINGLE_DYNAMIC,
	"dynamic-word": WORD_DYNAMIC,
	"dynamic-forward": FORWARD_DYNAMIC,
	"dynamic-article": ARTICLE_DYNAMIC,
	"dynamic-with-additional": WITH_ADDITIONAL_DYNAMIC,
	"dynamic-custom-layout": CUSTOM_LAYOUT_DYNAMIC,
	"dynamic-charge-only": CHARGE_ONLY_DYNAMIC,
	"dynamic-unrenderable": UNRENDERABLE_DYNAMIC,
};
