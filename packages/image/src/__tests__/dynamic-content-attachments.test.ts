/**
 * B 站作品卡的附加块与正文,先画成 `Post` 能表达的样子(㉑c 第 4 步,ADR-0021 决策 22 的 2026-10-05 🔗:
 * 形状装不下的,B 站卡到 3a 之前不画)。
 *
 * 目标是下一步「换入口」时十份快照一字不差,所以把所有「形状装不下」的视觉差异在旧入口上先清掉:
 *
 * - 预约卡(→ `Attachment.card`):`lines` 每行只有 `{ text, icon? }`。desc1 / desc2 / desc3 各占一行、同一个
 *   样式(不再同行并排、抽奖行不再标粉);按钮只剩文字与可用 / 不可用两态。
 * - 通用卡(→ `card`):desc1 前的「游戏」边框小标签不画;行与预约卡共用同一个画法。
 * - 商品卡(→ `goods`):按钮「去看看」与价格后的「起」不画;单件画名字与价格、多件只画封面是渲染器自己的事。
 * - 引用视频卡(→ `video`):上方 `head_text` 一行不画;`desc_second` 进 `subtitle` 照画。
 * - 正文:desc 与 opus 摘要两件都有时合成一段(换行连接)、一个 `body` 根;标题照旧画在上方;没有字也没有标题
 *   就不画正文(`Post.text` 空串没有「一个空的 body 根」可对应)。
 *
 * 这几样**有快照照见**:预约卡行与按钮在 `dynamic-with-additional`(可预约、含抽奖行)与 `dynamic-forward`(已结束),
 * 通用卡在 `dynamic-word`,单件商品卡在 `dynamic-draw-single`,引用视频卡在 `dynamic-custom-layout`。
 * **只有这里的单测钉、没有快照照见**:正文合并与空正文、只有 desc1 / 只有 desc2 的通用卡、没有价格的商品、
 * 专栏路径的合并。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, type VNode } from "vue";
import { buildDynamicNode } from "../templates/dynamic-content";
import type { Dynamic } from "../types";

const fmt = { time: () => "刚刚", num: (n: number) => String(n) };

const htmlOf = (vnode: VNode): Promise<string> =>
	renderToString(createSSRApp({ render: () => vnode }));

const text = (t: string) => ({ type: "RICH_TEXT_NODE_TYPE_TEXT", orig_text: t, text: t });

function dyn(type: string, moduleDynamic: Record<string, unknown>): Dynamic {
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
			module_dynamic: moduleDynamic,
			module_stat: { forward: { count: 1 }, comment: { count: 2 }, like: { count: 3 } },
		},
	} as unknown as Dynamic;
}

/** 一条带附加块的动态,附加块画出来的 HTML。 */
async function additionalHtml(additional: unknown): Promise<string> {
	const node = await buildDynamicNode(
		dyn("DYNAMIC_TYPE_WORD", { desc: { text: "", rich_text_nodes: [text("正文")] }, additional }),
		false,
		fmt,
	);
	if (!node.additional) throw new Error("没有附加块");
	return htmlOf(node.additional);
}

/** 一条动态的正文(`text` 那一半)。没有就是 null。 */
async function bodyHtml(type: string, moduleDynamic: Record<string, unknown>) {
	const node = await buildDynamicNode(dyn(type, moduleDynamic), false, fmt);
	return node.text ? htmlOf(node.text) : null;
}

/** 数 `needle` 在 `haystack` 里出现几次。 */
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const LINE = 'class="text-[12px] text-[#999] truncate';

describe("预约卡 → card:行同一个样式,各占一行;按钮只剩文字与两态", () => {
	const reserve = (over: Record<string, unknown> = {}, buttonText = "预约") => ({
		type: "ADDITIONAL_TYPE_RESERVE",
		reserve: {
			title: "直播预约",
			desc1: { text: "09-20 20:00 直播" },
			desc2: { text: "2.3万人预约" },
			desc3: { text: "参与抽奖：限定手办" },
			button: { uncheck: { text: buttonText }, check: { text: "已预约" }, type: 1 },
			...over,
		},
	});

	/** 验红:把 desc1 / desc2 改回并排在一个 `flex gap-2` 里,或把 desc3 改回标粉,这条红。 */
	it("desc1 / desc2 / desc3 各占一行、同一个样式 —— 不并排、抽奖行不标粉", async () => {
		const html = await additionalHtml(reserve());
		expect(html).toContain(
			`<div ${LINE} mb-[2px]">09-20 20:00 直播</div><div ${LINE} mb-[2px]">2.3万人预约</div><div ${LINE}">参与抽奖：限定手办</div>`,
		);
		expect(html).not.toContain("FF6699");
		expect(html).not.toContain("flex gap-2");
	});

	it("没有 desc3:两行,最后一行不留下边距", async () => {
		const html = await additionalHtml(reserve({ desc3: undefined }));
		expect(count(html, LINE)).toBe(2);
		expect(html).toContain(`<div ${LINE}">2.3万人预约</div>`);
	});

	it("按钮:可预约是粉底白字、已结束是灰底灰字,里面直接是文字(没有 span、没有 flex 空壳)", async () => {
		const open = await additionalHtml(reserve());
		expect(open).toContain('data-bn="button"');
		expect(open).toMatch(/bg-\[#FB7299\] text-white">预约<\/div>/);
		expect(open).not.toContain("inline-flex");
		expect(open).not.toContain("<span");

		const ended = await additionalHtml(reserve({ desc3: undefined }, "已结束"));
		expect(ended).toMatch(/bg-\[#f5f5f5\] text-\[#999\]">已结束<\/div>/);
	});
});

describe("通用卡 → card:不画「游戏」小标签;行与预约卡同一个画法", () => {
	const common = (over: Record<string, unknown> = {}) => ({
		type: "ADDITIONAL_TYPE_COMMON",
		common: {
			sub_type: "game",
			head_text: "相关游戏",
			cover: "http://i0.hdslb.com/bfs/game/c.png",
			title: "示例游戏",
			desc1: "官方正版授权",
			desc2: "已有 12.8万 人预约",
			button: { jump_style: { text: "去下载" }, jump_url: "" },
			...over,
		},
	});

	/** 验红:把 desc1 前改回带 `subTypeLabel` 那个边框小标签,这条红。 */
	it("sub_type 是 game 也不画「游戏」标签;desc1 / desc2 是共用的两行", async () => {
		const html = await additionalHtml(common());
		expect(html).not.toContain("游戏</span>");
		expect(html).not.toContain("border-[#FB7299]");
		expect(html).toContain(
			`<div ${LINE} mb-[2px]">官方正版授权</div><div ${LINE}">已有 12.8万 人预约</div>`,
		);
		// 头部说明、封面、按钮照画。
		expect(html).toContain("相关游戏");
		expect(html).toContain('data-bn="cover"');
		expect(html).toMatch(/data-bn="button"[^>]*>去下载<\/div>/);
	});

	it("只有 desc1 或只有 desc2:单独的一行就是最后一行,不留下边距", async () => {
		const only1 = await additionalHtml(common({ desc2: undefined }));
		expect(only1).toContain(`<div ${LINE}">官方正版授权</div>`);
		const only2 = await additionalHtml(common({ desc1: undefined }));
		expect(only2).toContain(`<div ${LINE}">已有 12.8万 人预约</div>`);
		expect(count(only2, LINE)).toBe(1);
	});
});

describe("商品卡 → goods:不画按钮与「起」;单件 / 多件的排法保留", () => {
	const item = (name: string, over: Record<string, unknown> = {}) => ({
		cover: "http://i0.hdslb.com/bfs/mall/g.jpg",
		name,
		price: "￥68",
		jump_desc: "",
		...over,
	});
	const goods = (items: unknown[]) => ({
		type: "ADDITIONAL_TYPE_GOODS",
		goods: { head_text: "UP 主推荐", items },
	});

	/** 验红:把价格行改回带「起」,或把按钮改回 `jump_desc || "去看看"`,这条红。 */
	it("单件:名字与价格照画,没有「起」,没有按钮(即使接口给了 jump_desc)", async () => {
		const html = await additionalHtml(goods([item("单品", { jump_desc: "立即购买" })]));
		expect(html).toContain("单品");
		expect(html).toContain("￥68");
		expect(html).not.toContain("起");
		expect(html).not.toContain("去看看");
		expect(html).not.toContain("立即购买");
		expect(html).not.toContain('data-bn="button"');
	});

	it("单件:价格是单独一行(没有只装一个 span 的 flex 空壳)", async () => {
		const html = await additionalHtml(goods([item("单品")]));
		expect(html).toContain('<div class="text-[14px] text-[#FF6699] font-bold">￥68</div>');
		expect(html).not.toContain("items-baseline");
	});

	it("单件没有价格:不画价格那一行", async () => {
		const html = await additionalHtml(goods([item("单品", { price: undefined })]));
		expect(html).toContain("单品");
		expect(html).not.toContain("FF6699");
	});

	it("多件:只画封面,不画名字、价格与按钮", async () => {
		const html = await additionalHtml(goods([item("甲"), item("乙")]));
		expect(count(html, 'data-bn="cover"')).toBe(2);
		expect(html).not.toContain("甲");
		expect(html).not.toContain("￥68");
		expect(html).not.toContain('data-bn="button"');
	});
});

describe("eyebrow:商品卡与通用卡上方的说明,没有字就不画", () => {
	const EYEBROW = "flex items-center gap-1 text-[12px] text-[#999] mb-[6px]";

	/** 验红:把 `cardEyebrow` 改回无条件画,这条红(从前接口给空串的 head_text 会留一条空行)。 */
	it("head_text 是空串:商品卡与通用卡都不留空行;有字照画", async () => {
		const goods = (head: string) => ({
			type: "ADDITIONAL_TYPE_GOODS",
			goods: { head_text: head, items: [{ cover: "c", name: "n", price: "￥1", jump_desc: "" }] },
		});
		const common = (head: string) => ({
			type: "ADDITIONAL_TYPE_COMMON",
			common: { sub_type: "game", head_text: head, cover: "c", title: "t", desc1: "d" },
		});
		for (const make of [goods, common]) {
			expect(await additionalHtml(make(""))).not.toContain(EYEBROW);
			expect(await additionalHtml(make("说明"))).toContain(`<div class="${EYEBROW}">说明</div>`);
		}
	});
});

describe("引用视频卡 → video:不画 head_text;subtitle 与时长照画", () => {
	const ugc = (over: Record<string, unknown> = {}) => ({
		type: "ADDITIONAL_TYPE_UGC",
		ugc: {
			id_str: "1",
			head_text: "相关视频",
			title: "关联视频",
			desc_second: "2654观看 102弹幕",
			jump_url: "",
			cover: "http://i1.hdslb.com/bfs/archive/c.jpg",
			duration: "00:29",
			multi_line: true,
			...over,
		},
	});

	/** 验红:把 `head_text` 那一行改回画出来,这条红。 */
	it("head_text 非空也不画;根就是卡本身(没有只装一张卡的外层壳)", async () => {
		const html = await additionalHtml(ugc());
		expect(html).not.toContain("相关视频");
		expect(html).toMatch(/^<div data-bn="card" class="bg-black\/4 rounded-lg p-\[10px\]">/);
		expect(html).toContain("关联视频");
		expect(html).toContain("2654观看 102弹幕");
		expect(html).toContain(">0:29<");
	});
});

describe("正文:desc 与 opus 摘要合成一段、一个 body 根", () => {
	const opus = (summary: unknown[] | undefined, title?: string) => ({
		major: {
			type: "MAJOR_TYPE_OPUS",
			opus: {
				fold_action: [],
				jump_url: "",
				title,
				summary: summary === undefined ? undefined : { text: "", rich_text_nodes: summary },
			},
		},
	});
	const desc = (nodes: unknown[]) => ({ desc: { text: "", rich_text_nodes: nodes } });

	/** 验红:把 `buildBasicText` 改回两件各画一个根,这条红(从前两件都有时是两个 `body` 根)。 */
	it("两件都有:一个 body 根,desc 在前、摘要在后,换行连接", async () => {
		const html = await bodyHtml("DYNAMIC_TYPE_DRAW", {
			...desc([text("转发语")]),
			...opus([text("图文摘要")]),
		});
		expect(html).not.toBeNull();
		expect(count(html as string, 'data-bn="body"')).toBe(1);
		expect(html).toContain("转发语<br>图文摘要");
	});

	it("两件都有且有标题:标题只有一个,画在合成的这段正文上方", async () => {
		const html = await bodyHtml("DYNAMIC_TYPE_DRAW", {
			...desc([text("转发语")]),
			...opus([text("图文摘要")], "图文标题"),
		});
		expect(count(html as string, "<h1")).toBe(1);
		expect((html as string).indexOf("图文标题")).toBeLessThan((html as string).indexOf("转发语"));
	});

	it("只有 desc 或只有摘要:不多出换行,画法同从前", async () => {
		const onlyDesc = await bodyHtml("DYNAMIC_TYPE_WORD", desc([text("只有 desc")]));
		expect(onlyDesc).toContain("只有 desc");
		expect(onlyDesc).not.toContain("<br>");
		const onlySummary = await bodyHtml("DYNAMIC_TYPE_DRAW", opus([text("只有摘要")]));
		expect(onlySummary).toContain("只有摘要");
		expect(onlySummary).not.toContain("<br>");
	});

	it("一边是空数组:不当成有一段,也不多出换行", async () => {
		const html = await bodyHtml("DYNAMIC_TYPE_DRAW", { ...desc([]), ...opus([text("图文摘要")]) });
		expect(count(html as string, 'data-bn="body"')).toBe(1);
		expect(html).not.toContain("<br>");
	});

	/** 验红:把 `buildBasicText` 改回「有数组就画」,这条红(从前会画出一个空的 body 根)。 */
	it("没有字也没有标题:不画正文(Post.text 空串没有「空 body 根」可对应)", async () => {
		expect(await bodyHtml("DYNAMIC_TYPE_WORD", desc([]))).toBeNull();
		expect(await bodyHtml("DYNAMIC_TYPE_DRAW", opus([]))).toBeNull();
		expect(await bodyHtml("DYNAMIC_TYPE_DRAW", { ...desc([]), ...opus([]) })).toBeNull();
	});

	it("没有字、有标题:标题照画(从前摘要是空数组、有标题时就是这样)", async () => {
		const html = await bodyHtml("DYNAMIC_TYPE_DRAW", opus([], "只有标题"));
		expect(html).toContain("只有标题");
	});

	it("标题只跟摘要走:有标题、没有摘要时不画标题(同从前)", async () => {
		const html = await bodyHtml("DYNAMIC_TYPE_DRAW", {
			...desc([text("正文")]),
			...opus(undefined, "孤标题"),
		});
		expect(html).toContain("正文");
		expect(html).not.toContain("孤标题");
	});

	it("专栏路径同样合成一段:一个 body 根,两件之间是一个换行(<br><br>)", async () => {
		const html = await bodyHtml("DYNAMIC_TYPE_ARTICLE", {
			...desc([text("导语")]),
			...opus([text("专栏摘要")], "专栏标题"),
		});
		expect(count(html as string, 'data-bn="body"')).toBe(1);
		expect(html).toContain("导语<br><br>专栏摘要");
		expect(count(html as string, "<h1")).toBe(1);
	});
});
