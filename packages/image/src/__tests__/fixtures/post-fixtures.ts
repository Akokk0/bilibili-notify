/**
 * 十份 `dynamic-*` 出图基准的输入 —— **`Post` 字面量**(㉑c 第 5 步)。
 *
 * 出图器(本包)只认 `Post`,不认识 B 站原始动态。这十份是 B 站原始夹具(住在 `packages/dynamic` 的
 * `__tests__/fixtures/bili-dynamic-fixtures.ts`)经 `postFromDynamic` 翻出来的样子:本包的基准快照
 * (`card-baseline.test.ts`)拿它们出图,`packages/dynamic` 的 `post-from-dynamic.test.ts` 拿翻译结果与它们逐项对一遍 ——
 * 同一份中间产物夹在两腿中间,「原始数据 → 字节」整条链才都钉着。
 *
 * 经 `@bilibili-notify/image/testing` 给 `packages/dynamic` 的测试用(见 `src/testing.ts`)。夹具的图地址都是不会被访问的假地址。
 *
 * ⚠️ 改这里的字段 = 改出图基准的输入。字节要变就得走批准清单(`approved-card-diffs.ts`),别光 `-u`。
 */

import type { Post } from "@bilibili-notify/internal";

/** 键是基准的样例名(`__snapshots__/card-baseline/<名>.html`)。 */
export const DYNAMIC_SAMPLE_POSTS: Readonly<Record<string, Post>> = {
	"dynamic-av": {
		creator: {
			name: "示例UP·大会员",
			isPremium: true,
		},
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "新视频来啦，记得一键三连！",
		stats: {
			shares: 128,
			comments: 456,
			likes: 7890,
		},
		richText: [
			{
				kind: "text",
				text: "新视频来啦，记得一键三连！",
			},
		],
		video: {
			cover: {
				url: "http://i1.hdslb.com/bfs/archive/15644012e6961428b08a947ec83365747c741d41.jpg",
			},
			title: "因为揭穿了他们的秘密！我们遭到了陷害！MC恐怖地图 毒药",
			description: "剪辑：@示例剪辑师　BGM：示例曲目",
			durationSec: 967,
			views: 18000,
			danmaku: 129,
		},
		label: "投稿了视频",
	},
	"dynamic-draw": {
		creator: {
			name: "示例UP",
			isPremium: false,
		},
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "现场返图来啦，挑了几张最满意的～",
		topic: "周年庆典",
		stats: {
			shares: 128,
			comments: 456,
			likes: 7890,
		},
		attachment: {
			kind: "goods",
			eyebrow: "UP 主推荐",
			items: [
				{
					cover: {
						url: "http://i0.hdslb.com/bfs/mall/goods-0001.jpg",
					},
					name: "示例周边 A",
					price: "￥68",
				},
				{
					cover: {
						url: "http://i0.hdslb.com/bfs/mall/goods-0002.jpg",
					},
					name: "示例周边 B",
					price: "￥128",
				},
				{
					cover: {
						url: "http://i0.hdslb.com/bfs/mall/goods-0003.jpg",
					},
					name: "示例周边 C",
					price: "￥298",
				},
			],
		},
		richText: [
			{
				kind: "text",
				text: "现场返图来啦，挑了几张最满意的～",
			},
		],
		images: [
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/00112233445566778899aabbccddeeff.jpg",
				width: 1440,
				height: 1440,
				isAnimated: false,
			},
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/anim01.gif@1280w_80q_1s.webp?from=dyn",
				width: 1440,
				height: 1440,
				isAnimated: true,
			},
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/anim02.jpg",
				width: 1440,
				height: 1440,
				isAnimated: true,
			},
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/long01.jpg",
				width: 900,
				height: 2700,
				isAnimated: false,
			},
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/p05.jpg",
				width: 1440,
				height: 1440,
				isAnimated: false,
			},
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/p06.jpg",
				width: 1440,
				height: 1440,
				isAnimated: false,
			},
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/p07.jpg",
				width: 1440,
				height: 1440,
				isAnimated: false,
			},
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/p08.jpg",
				width: 1440,
				height: 1440,
				isAnimated: false,
			},
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/p09.jpg",
				width: 1440,
				height: 1440,
				isAnimated: false,
			},
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/p10.jpg",
				width: 1440,
				height: 1440,
				isAnimated: false,
			},
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/p11.jpg",
				width: 1440,
				height: 1440,
				isAnimated: false,
			},
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/p12.jpg",
				width: 1440,
				height: 1440,
				isAnimated: false,
			},
		],
	},
	"dynamic-draw-single": {
		creator: {
			name: "示例UP",
			isPremium: false,
		},
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "新周边到货，开箱图一张。",
		stats: {
			shares: 128,
			comments: 456,
			likes: 7890,
		},
		attachment: {
			kind: "goods",
			eyebrow: "UP 主推荐",
			items: [
				{
					cover: {
						url: "http://i0.hdslb.com/bfs/mall/goods-0001.jpg",
					},
					name: "示例周边 A —— 一个足够长、需要两行才放得下的商品名称示例",
					price: "￥68",
				},
			],
		},
		richText: [
			{
				kind: "text",
				text: "新周边到货，开箱图一张。",
			},
		],
		images: [
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/one01.jpg",
				width: 1920,
				height: 1080,
				isAnimated: false,
			},
		],
	},
	"dynamic-word": {
		creator: {
			name: "示例UP",
			isPremium: false,
		},
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "感谢大家这一年的陪伴 [doge]\n本期鸣谢 @示例剪辑师 与 #周年庆典#\n往期回顾：BV1FTGM69EFQ\n互动抽奖\n详情戳 网页链接",
		stats: {
			shares: 128,
			comments: 456,
			likes: 7890,
		},
		attachment: {
			kind: "card",
			eyebrow: "相关游戏",
			cover: {
				url: "http://i0.hdslb.com/bfs/game/common-cover-0001.png",
			},
			title: "示例游戏：起源",
			lines: [
				{
					text: "官方正版授权",
				},
				{
					text: "已有 12.8万 人预约",
				},
			],
			button: {
				text: "去下载",
				enabled: true,
			},
		},
		richText: [
			{
				kind: "text",
				text: "感谢大家这一年的陪伴 ",
			},
			{
				kind: "emoji",
				text: "[doge]",
			},
			{
				kind: "text",
				text: "\n本期鸣谢 ",
			},
			{
				kind: "mention",
				text: "@示例剪辑师",
				userId: "12345",
			},
			{
				kind: "text",
				text: " 与 ",
			},
			{
				kind: "topic",
				text: "#周年庆典#",
				name: "周年庆典",
			},
			{
				kind: "text",
				text: "\n往期回顾：",
			},
			{
				kind: "link",
				text: "BV1FTGM69EFQ",
				url: "//www.bilibili.com/video/BV1FTGM69EFQ",
			},
			{
				kind: "text",
				text: "\n",
			},
			{
				kind: "link",
				text: "互动抽奖",
				url: "",
			},
			{
				kind: "text",
				text: "\n详情戳 ",
			},
			{
				kind: "link",
				text: "网页链接",
				url: "https://www.bilibili.com",
			},
		],
	},
	"dynamic-forward": {
		creator: {
			name: "示例转发者",
			isPremium: false,
		},
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "这期真的建议看完，后半段有反转。",
		stats: {
			shares: 128,
			comments: 456,
			likes: 7890,
		},
		attachment: {
			kind: "card",
			title: "上周的联动直播",
			lines: [
				{
					text: "09-06 20:00 直播",
				},
				{
					text: "1.1万人预约",
				},
			],
			button: {
				text: "已结束",
				enabled: false,
			},
		},
		richText: [
			{
				kind: "text",
				text: "这期真的建议看完，后半段有反转。",
			},
		],
		repost: {
			creator: {
				name: "示例UP·大会员",
				isPremium: true,
			},
			publishedAt: "2023-11-14T22:13:20.000Z",
			text: "新视频来啦，记得一键三连！",
			richText: [
				{
					kind: "text",
					text: "新视频来啦，记得一键三连！",
				},
			],
			video: {
				cover: {
					url: "http://i1.hdslb.com/bfs/archive/15644012e6961428b08a947ec83365747c741d41.jpg",
				},
				title: "因为揭穿了他们的秘密！我们遭到了陷害！MC恐怖地图 毒药",
				description: "剪辑：@示例剪辑师　BGM：示例曲目",
				durationSec: 967,
				views: 18000,
				danmaku: 129,
			},
			label: "投稿了视频",
		},
	},
	"dynamic-article": {
		creator: {
			name: "示例UP",
			isPremium: false,
		},
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: '第一段：起点 <b>2019</b> & "那年冬天"\n第二段：第一个一万粉\n第三段：第一次线下\n第四段：踩过的坑\n第五段：接下来要做的事\n第六段：这一段会被 5 行截断吃掉\n[脱单doge]第七段：同上',
		stats: {
			shares: 128,
			comments: 456,
			likes: 7890,
		},
		richText: [
			{
				kind: "text",
				text: '第一段：起点 <b>2019</b> & "那年冬天"\n',
			},
			{
				kind: "text",
				text: "第二段：第一个一万粉\n",
			},
			{
				kind: "text",
				text: "第三段：第一次线下\n",
			},
			{
				kind: "text",
				text: "第四段：踩过的坑\n",
			},
			{
				kind: "text",
				text: "第五段：接下来要做的事\n",
			},
			{
				kind: "text",
				text: "第六段：这一段会被 5 行截断吃掉\n",
			},
			{
				kind: "emoji",
				text: "[脱单doge]",
			},
			{
				kind: "text",
				text: "第七段：同上",
			},
		],
		article: {
			title: "年度总结：我们是怎么把一个小频道做起来的",
			images: [
				{
					url: "http://i0.hdslb.com/bfs/article/superlong.jpg",
					width: 900,
					height: 4800,
					isAnimated: false,
				},
			],
		},
		label: "投稿了专栏",
	},
	"dynamic-with-additional": {
		creator: {
			name: "示例UP",
			isPremium: false,
		},
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "下周的直播定了，先放两张预告图。",
		stats: {
			shares: 128,
			comments: 456,
			likes: 7890,
		},
		attachment: {
			kind: "card",
			title: "周年庆典直播预约",
			lines: [
				{
					text: "预计 09-20 20:00 直播",
				},
				{
					text: "2.3万人预约",
				},
				{
					text: "参与抽奖：限定手办 ×3",
				},
			],
			button: {
				text: "预约",
				enabled: true,
			},
		},
		richText: [
			{
				kind: "text",
				text: "下周的直播定了，先放两张预告图。",
			},
		],
		images: [
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/pre01.jpg",
				width: 1440,
				height: 1440,
				isAnimated: false,
			},
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/pre02.jpg",
				width: 1440,
				height: 1440,
				isAnimated: false,
			},
		],
	},
	"dynamic-custom-layout": {
		creator: {
			name: "示例UP",
			isPremium: false,
		},
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "流程图放这儿，配合上期视频看。",
		stats: {
			shares: 128,
			comments: 456,
			likes: 7890,
		},
		attachment: {
			kind: "video",
			cover: {
				url: "http://i1.hdslb.com/bfs/archive/d75b1c5900112233445566778899aabbccddeeff.jpg",
			},
			title: "上一期：我们是怎么被坑的",
			durationSec: 29,
			subtitle: "2654观看 102弹幕",
		},
		richText: [
			{
				kind: "text",
				text: "流程图放这儿，配合上期视频看。",
			},
		],
		images: [
			{
				url: "http://i0.hdslb.com/bfs/new_dyn/mid-long.jpg",
				width: 1000,
				height: 1600,
				isAnimated: true,
			},
		],
	},
	"dynamic-charge-only": {
		creator: {
			name: "示例UP",
			isPremium: false,
		},
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "",
		stats: {
			shares: 128,
			comments: 456,
			likes: 7890,
		},
		locked: {
			icon: {
				url: "http://i0.hdslb.com/bfs/dynamic/charge-badge-0001.png",
			},
			title: "充电专属",
			hint: "为 示例UP 充电即可查看完整内容",
		},
	},
	"dynamic-unrenderable": {
		creator: {
			name: "示例UP",
			isPremium: false,
		},
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "",
		stats: {
			shares: 128,
			comments: 456,
			likes: 7890,
		},
		notice: "示例UP分享了收藏夹，我暂时无法渲染，请自行查看",
	},
};
