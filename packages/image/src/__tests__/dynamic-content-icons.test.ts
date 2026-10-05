/**
 * B 站作品卡到 3a 之前**不画 `Post` 装不下的小图标与表情图**(ADR-0021 决策 22 的 2026-10-05 🔗)。
 *
 * `RichText` 的 `link.icon`、`emoji.image` 与附加块 `lines[].icon` 都只收图库引用,B 站的要到 3a 才存进
 * 图库;`Attachment` 的 `button` 只有 `text` / `enabled`、`goods.eyebrow` 是纯文字,预约按钮上的铃铛与商品
 * 卡标题前的购物袋压根没有位置。所以 B 站这条路:
 *
 * - 正文里 BV / AV 链接前的视频图标、抽奖链接前的抽奖图标不画(链接文字与颜色照旧);
 * - 表情不画图,当文字画它的 `text`(「[doge]」),普通路径与专栏 innerHTML 路径一样;
 * - 预约卡抽奖行前的图标、预约按钮上的铃铛、商品卡 `head_text` 前的购物袋不画。
 *
 * 不受影响的:出卡器自己的图标(话题 / 播放 / 弹幕 / 三个互动数)、充电专属徽标(`locked.icon` 是
 * `PostImage`,带 `url` 能画)、拓展作品那条路(`buildPlainText`,话题 span 照旧)。
 *
 * 这几样**有快照照见**:表情 / 视频图标 / 抽奖图标在 `dynamic-word`,抽奖行与铃铛在
 * `dynamic-with-additional`,购物袋在 `dynamic-draw` 与 `dynamic-draw-single`。**只有这里的单测钉、
 * 没有快照照见**:专栏路径的表情(夹具里那个表情落在 5 行截断之外,画不出来)、AV 号链接(夹具只有 BV 号)、
 * 已结束的预约卡与不带抽奖行的预约卡(本来就没有铃铛 / 抽奖行)。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, type VNode } from "vue";
import { DYNAMIC_BLOCKS } from "../blocks/dynamic";
import { parseRichText } from "../rich-text";
import { buildDynamicNode, buildPlainText } from "../templates/dynamic-content";
import type { Dynamic, RichTextNode } from "../types";

const fmt = { time: () => "刚刚", num: (n: number) => String(n) };

const htmlOf = (vnode: VNode): Promise<string> =>
	renderToString(createSSRApp({ render: () => vnode }));

const text = (t: string) => ({ type: "RICH_TEXT_NODE_TYPE_TEXT", orig_text: t, text: t });
const rich = (type: string, t: string) => ({ type, orig_text: t, text: t });
const emoji = (t: string, iconUrl: string) => ({
	type: "RICH_TEXT_NODE_TYPE_EMOJI",
	orig_text: t,
	text: t,
	emoji: { icon_url: iconUrl, size: 1, text: t, type: 1 },
});

const EMOJI_URL = "http://i0.hdslb.com/bfs/emote/doge.png";

function wordDynamic(nodes: unknown[], additional?: unknown, type = "DYNAMIC_TYPE_WORD"): Dynamic {
	return {
		basic: {},
		id_str: "1",
		type,
		visible: true,
		modules: {
			module_author: {
				avatar: {},
				face: "face.jpg",
				face_nft: false,
				following: false,
				jump_url: "",
				label: "",
				mid: 1,
				name: "示例UP",
				pub_action: "",
				pub_action_text: "",
				pub_location_text: "",
				pub_time: "刚刚",
				pub_ts: 0,
				type: "AUTHOR_TYPE_NORMAL",
				vip: { type: 0 },
			},
			module_dynamic: {
				desc: { text: "", rich_text_nodes: nodes as RichTextNode },
				additional,
			},
			module_stat: { forward: { count: 1 }, comment: { count: 2 }, like: { count: 3 } },
		},
	} as unknown as Dynamic;
}

/** 一条动态的正文(`text` 那一半)画出来的 HTML。 */
async function bodyHtml(nodes: unknown[]): Promise<string> {
	const node = await buildDynamicNode(wordDynamic(nodes), false, fmt);
	if (!node.text) throw new Error("这条动态没有正文");
	return htmlOf(node.text);
}

/** 一条动态的附加块画出来的 HTML。 */
async function additionalHtml(additional: unknown): Promise<string> {
	const node = await buildDynamicNode(wordDynamic([text("正文")], additional), false, fmt);
	if (!node.additional) throw new Error("这条动态没有附加块");
	return htmlOf(node.additional);
}

describe("正文里的链接图标 —— 不画,文字与颜色照旧", () => {
	/** 验红:把 `rich-text.tsx` 里 BV / AV 那支改回带 `SVG_VIDEO_INLINE`,前两条红。 */
	it("BV 号与 AV 号链接:只剩链接文字,颜色还是 B 站蓝", async () => {
		const html = await bodyHtml([
			rich("RICH_TEXT_NODE_TYPE_BV", "BV1FTGM69EFQ"),
			text(" "),
			rich("RICH_TEXT_NODE_TYPE_AV", "av170001"),
		]);
		expect(html).not.toContain("<svg");
		expect(html).toContain('<span class="text-[#00AEEC]">BV1FTGM69EFQ</span>');
		expect(html).toContain('<span class="text-[#00AEEC]">av170001</span>');
	});

	it("抽奖链接:只剩链接文字,颜色还是 B 站蓝", async () => {
		const html = await bodyHtml([rich("RICH_TEXT_NODE_TYPE_LOTTERY", "互动抽奖")]);
		expect(html).not.toContain("<svg");
		expect(html).toContain('<span class="text-[#00AEEC]">互动抽奖</span>');
	});

	it("网页 / 话题 / @ 这几种本来就没有图标,画法不变", async () => {
		const html = await bodyHtml([
			rich("RICH_TEXT_NODE_TYPE_WEB", "网页链接"),
			rich("RICH_TEXT_NODE_TYPE_TOPIC", "#话题#"),
			rich("RICH_TEXT_NODE_TYPE_AT", "@某人"),
		]);
		expect(html).toContain('<span class="text-[#00AEEC]">网页链接</span>');
		expect(html).toContain('<span class="text-[#FF6699]">#话题#</span>');
		expect(html).toContain('<span class="text-[#00AEEC]">@某人</span>');
	});
});

describe("表情 —— 不画图,当文字画它的 text", () => {
	/** 验红:把 `rich-text.tsx` 普通路径里的 `node.emoji` 那一支改回画 `<img>`,这条红。 */
	it("普通路径:「[doge]」按文字画在原位置,没有 <img>,表情图地址也不出现", async () => {
		const html = await bodyHtml([text("感谢大家 "), emoji("[doge]", EMOJI_URL), text("\n下一行")]);
		expect(html).not.toContain("<img");
		expect(html).not.toContain(EMOJI_URL);
		expect(html).toContain("感谢大家 [doge]<br>下一行");
	});

	/** 验红:把专栏路径里的 `node.emoji` 那一支改回拼 `<img>`,这条红(这条只有单测钉,快照照不见)。 */
	it("专栏路径:同样当文字(转义后拼进 innerHTML),没有 <img>,表情图地址不进 HTML", () => {
		const rt = [text("前"), emoji("[脱单doge]", EMOJI_URL), text("后")] as unknown as RichTextNode;
		const vnode = parseRichText(rt, undefined, true) as unknown as {
			props?: { innerHTML?: string };
		};
		const html = vnode.props?.innerHTML ?? "";
		expect(html).toBe("前[脱单doge]后");
		expect(html).not.toContain(EMOJI_URL);
	});

	it("专栏路径:表情的 text 里带标签也是转义的,不因为改走文字而松口子", () => {
		const rt = [emoji("<b>[x]</b>", EMOJI_URL)] as unknown as RichTextNode;
		const vnode = parseRichText(rt, undefined, true) as unknown as {
			props?: { innerHTML?: string };
		};
		expect(vnode.props?.innerHTML).toBe("&lt;b&gt;[x]&lt;/b&gt;");
	});
});

describe("附加块里的小图标 —— 不画,文字照旧", () => {
	const RESERVE = (over: Record<string, unknown> = {}, ended = false) => ({
		type: "ADDITIONAL_TYPE_RESERVE",
		reserve: {
			title: "直播预约",
			desc1: { text: "09-20 20:00 直播" },
			desc2: { text: "2.3万人预约" },
			desc3: { text: "参与抽奖：限定手办" },
			button: { uncheck: { text: ended ? "已结束" : "预约" }, check: { text: "已预约" }, type: 1 },
			...over,
		},
	});

	/** 验红:把 `buildReserveAdditional` 的抽奖行改回带 `SVG_LOTTERY`,这条红。 */
	it("预约卡的抽奖行:只剩粉色的文字,没有前缀图标", async () => {
		const html = await additionalHtml(RESERVE());
		expect(html).not.toContain('aria-label="抽奖"');
		expect(html).toContain("参与抽奖：限定手办");
		expect(html).toContain("text-[#FF6699]");
	});

	/** 验红:把预约按钮改回 `{!isEnded && SVG_BELL}`,这条红。 */
	it("预约按钮:可预约时不画铃铛,按钮文字与粉底照旧", async () => {
		const html = await additionalHtml(RESERVE());
		expect(html).not.toContain("<svg");
		expect(html).toContain("<span>预约</span>");
		expect(html).toContain("bg-[#FB7299] text-white");
	});

	it("已结束的预约卡、不带抽奖行的预约卡:本来就没有图标,画法不变", async () => {
		const html = await additionalHtml(RESERVE({ desc3: undefined }, true));
		expect(html).not.toContain("<svg");
		expect(html).toContain("<span>已结束</span>");
		expect(html).toContain("bg-[#f5f5f5] text-[#999]");
	});

	/** 验红:把 `buildGoodsAdditional` 的 `head_text` 前改回带 `SVG_GOODS`,这条红。 */
	it("商品卡:head_text 前不画购物袋,文字照旧(单件与多件都一样)", async () => {
		const item = (name: string) => ({
			cover: "http://i0.hdslb.com/bfs/mall/g.jpg",
			name,
			price: "￥68",
			jump_desc: "",
		});
		const single = await additionalHtml({
			type: "ADDITIONAL_TYPE_GOODS",
			goods: { head_text: "UP 主推荐", items: [item("单品")] },
		});
		const multi = await additionalHtml({
			type: "ADDITIONAL_TYPE_GOODS",
			goods: { head_text: "UP 主推荐", items: [item("甲"), item("乙")] },
		});
		for (const html of [single, multi]) {
			expect(html).not.toContain("<svg");
			expect(html).toContain("UP 主推荐");
		}
	});
});

describe("不受影响的画法", () => {
	it("拓展作品那条路(buildPlainText):话题 span 照旧,正文里没有任何图标", async () => {
		const vnode = buildPlainText("看看 #旅行# 今天", ["旅行"]);
		expect(vnode).not.toBeNull();
		const html = await htmlOf(vnode as VNode);
		expect(html).toContain('<span class="text-[#FF6699]">#旅行#</span>');
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("<img");
	});

	it("出卡器自己的图标不动:话题、播放、弹幕、互动数的图标都还在", async () => {
		const node = await buildDynamicNode(
			{
				...wordDynamic([text("正文")]),
				modules: {
					...wordDynamic([text("正文")]).modules,
					module_dynamic: {
						topic: { id: 1, name: "示例话题" },
						desc: { text: "", rich_text_nodes: [text("正文")] },
					},
				},
			} as unknown as Dynamic,
			false,
			fmt,
		);
		const props = { node, renderForward: (): [] => [] };
		const topic = DYNAMIC_BLOCKS.topic(props);
		expect(await htmlOf(topic as VNode)).toContain("<svg");
		const likes = DYNAMIC_BLOCKS.likeCount(props);
		expect(await htmlOf(likes as VNode)).toContain('aria-label="点赞"');
		const withVideo = {
			node: {
				...node,
				video: { cover: "c", duration: "1:00", title: "t", desc: "", views: "1", danmaku: "2" },
			},
			renderForward: (): [] => [],
		};
		const stats = await htmlOf(DYNAMIC_BLOCKS.videoStats(withVideo) as VNode);
		expect(stats).toContain('aria-label="播放量"');
		expect(stats).toContain('aria-label="弹幕"');
	});
});
