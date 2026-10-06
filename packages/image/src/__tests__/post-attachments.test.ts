/**
 * 作品卡的附加块(`Post.attachment` → `attachment.tsx`)。
 *
 * 出图器按种类直接画封闭联合的三种:`card`(预约卡 / 通用卡)、`goods`(商品)、`video`(引用的视频)。
 * 主人定的原则是「不加字段,形状装不下的就不画」(ADR-0021 决策 22 的 2026-10-05 🔗),所以:
 *
 * - `card`:`lines` 每行只有 `{ text, icon? }`,各占一行、同一个样式(不并排、没有单行变色);按钮只有文字与
 *   可用 / 不可用两态;**有没有 `cover` 选版式**(有封面是通用卡的排法,没有是预约卡的排法);
 * - `goods`:单件画封面、名字与价格,多件只画封面;没有按钮、没有价格后缀;
 * - `video`:封面 + 时长角标 + 标题 + `subtitle`;没有标题上方的说明;
 * - 三种都**没有任何图标**(`icon` 要到 3a 才有图库引用可给;铃铛与购物袋形状里压根没有位置)。
 *
 * 翻译那一头(接口的预约卡 / 通用卡 / 商品 / UGC 怎么落成这三种)在 `packages/dynamic` 的
 * `post-from-dynamic.test.ts`;这里钉的是它们**画成什么样**。
 *
 * 这几样**有快照照见**:预约卡在 `dynamic-with-additional`(可预约、含抽奖行)与 `dynamic-forward`(已结束),
 * 通用卡在 `dynamic-word`,单件商品在 `dynamic-draw-single`,多件商品在 `dynamic-draw`,引用视频在
 * `dynamic-custom-layout`。**只有这里的单测钉、没有快照照见**:只有 desc1 / 只有 desc2 的通用卡、没有价格的商品、
 * eyebrow 空串、没有时长 / subtitle 的视频、封面尺寸类名不被 Fragment 锚点吞掉。
 */

import type { Attachment, Post } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, type VNode } from "vue";
import { nodeFromPost } from "../templates/post-node";
import { renderViaDefaultSkin } from "./fixtures/skin-render";

const FMT = { time: () => "刚刚" };

const htmlOf = (vnode: VNode): Promise<string> =>
	renderToString(createSSRApp({ render: () => vnode }));

function postWith(attachment: Attachment): Post {
	return {
		creator: { name: "示例UP" },
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "正文",
		attachment,
	};
}

/** 一份附加块画出来的 HTML(就是 `additional` 块里装的那段,即 `node.attachment`)。 */
async function attachmentHtml(attachment: Attachment): Promise<string> {
	const node = nodeFromPost(postWith(attachment), FMT);
	if (!node.attachment) throw new Error("没有附加块");
	return htmlOf(node.attachment);
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const LINE = 'class="text-[12px] text-[#999] truncate';

describe("card 没有封面 → 预约卡的排法:行同一个样式、各占一行,按钮只剩文字与两态", () => {
	const reserve = (over: Partial<Extract<Attachment, { kind: "card" }>> = {}): Attachment => ({
		kind: "card",
		title: "直播预约",
		lines: [{ text: "09-20 20:00 直播" }, { text: "2.3万人预约" }, { text: "参与抽奖：限定手办" }],
		button: { text: "预约", enabled: true },
		...over,
	});

	/** 验红:把行改回并排在一个 `flex gap-2` 里,或把末行改回标粉,这条红。 */
	it("三行各占一行、同一个样式 —— 不并排、末行不标粉;除最后一行外留 2px", async () => {
		const html = await attachmentHtml(reserve());
		expect(html).toContain(
			`<div ${LINE} mb-[2px]">09-20 20:00 直播</div><div ${LINE} mb-[2px]">2.3万人预约</div><div ${LINE}">参与抽奖：限定手办</div>`,
		);
		expect(html).not.toContain("FF6699");
		expect(html).not.toContain("flex gap-2");
	});

	it("两行:最后一行不留下边距", async () => {
		const html = await attachmentHtml(reserve({ lines: [{ text: "甲" }, { text: "乙" }] }));
		expect(count(html, LINE)).toBe(2);
		expect(html).toContain(`<div ${LINE}">乙</div>`);
	});

	it("按钮:可用是粉底白字、不可用是灰底灰字,里面直接是文字(没有 span、没有 flex 空壳)", async () => {
		const open = await attachmentHtml(reserve());
		expect(open).toContain('data-bn="button"');
		expect(open).toMatch(/bg-\[#FB7299\] text-white">预约<\/div>/);
		expect(open).not.toContain("inline-flex");
		expect(open).not.toContain("<span");

		const ended = await attachmentHtml(
			reserve({ lines: [], button: { text: "已结束", enabled: false } }),
		);
		expect(ended).toMatch(/bg-\[#f5f5f5\] text-\[#999\]">已结束<\/div>/);
	});

	it("没有按钮:不画按钮;没有封面:不画封面", async () => {
		const html = await attachmentHtml(reserve({ button: undefined }));
		expect(html).not.toContain('data-bn="button"');
		expect(html).not.toContain('data-bn="cover"');
	});

	it("没有任何图标:抽奖行前、按钮上都没有 svg", async () => {
		expect(await attachmentHtml(reserve())).not.toContain("<svg");
		expect(
			await attachmentHtml(reserve({ button: { text: "已结束", enabled: false } })),
		).not.toContain("<svg");
	});
});

describe("card 有封面 → 通用卡的排法:头部说明、封面、标题、行、按钮", () => {
	const common = (over: Partial<Extract<Attachment, { kind: "card" }>> = {}): Attachment => ({
		kind: "card",
		eyebrow: "相关游戏",
		cover: { url: "http://i0.hdslb.com/bfs/game/c.png" },
		title: "示例游戏",
		lines: [{ text: "官方正版授权" }, { text: "已有 12.8万 人预约" }],
		button: { text: "去下载", enabled: true },
		...over,
	});

	it("两行是共用的两行(与预约卡同一个画法);没有任何小标签", async () => {
		const html = await attachmentHtml(common());
		expect(html).toContain(
			`<div ${LINE} mb-[2px]">官方正版授权</div><div ${LINE}">已有 12.8万 人预约</div>`,
		);
		expect(html).not.toContain("border-[#FB7299]");
		expect(html).not.toContain("<svg");
		// 头部说明、封面、按钮照画。
		expect(html).toContain("相关游戏");
		expect(html).toContain('data-bn="cover"');
		expect(html).toMatch(/data-bn="button"[^>]*>去下载<\/div>/);
	});

	it("只有一行:单独的一行就是最后一行,不留下边距", async () => {
		const html = await attachmentHtml(common({ lines: [{ text: "只有一行" }] }));
		expect(html).toContain(`<div ${LINE}">只有一行</div>`);
		expect(count(html, LINE)).toBe(1);
	});

	it("没有按钮:不画按钮;不可用的按钮是灰底", async () => {
		expect(await attachmentHtml(common({ button: undefined }))).not.toContain('data-bn="button"');
		expect(await attachmentHtml(common({ button: { text: "已下架", enabled: false } }))).toMatch(
			/bg-\[#f5f5f5\] text-\[#999\] text-\[12px\][^>]*>已下架<\/div>/,
		);
	});
});

describe("goods:单件画封面、名字与价格,多件只画封面;没有按钮与「起」", () => {
	const item = (name: string, price?: string) => ({
		cover: { url: "http://i0.hdslb.com/bfs/mall/g.jpg" },
		name,
		...(price === undefined ? {} : { price }),
	});
	const goods = (items: ReturnType<typeof item>[], eyebrow = "UP 主推荐"): Attachment => ({
		kind: "goods",
		eyebrow,
		items,
	});

	/** 验红:把价格行改回带「起」,或把按钮加回去,这条红。 */
	it("单件:名字与价格照画,价格单独一行,没有「起」、没有按钮、没有图标", async () => {
		const html = await attachmentHtml(goods([item("单品", "￥68")]));
		expect(html).toContain("单品");
		expect(html).toContain('<div class="text-[14px] text-[#FF6699] font-bold">￥68</div>');
		expect(html).not.toContain("起");
		expect(html).not.toContain('data-bn="button"');
		expect(html).not.toContain("items-baseline");
		expect(html).not.toContain("<svg");
		expect(html).toContain("UP 主推荐");
	});

	it("单件没有价格:不画价格那一行", async () => {
		const html = await attachmentHtml(goods([item("单品")]));
		expect(html).toContain("单品");
		expect(html).not.toContain("FF6699");
	});

	it("多件:只画封面,不画名字、价格与按钮", async () => {
		const html = await attachmentHtml(goods([item("甲", "￥68"), item("乙", "￥99")]));
		expect(count(html, 'data-bn="cover"')).toBe(2);
		expect(html).not.toContain("甲");
		expect(html).not.toContain("￥68");
		expect(html).not.toContain('data-bn="button"');
	});

	it("eyebrow 空串:商品卡与通用卡都不留空行;有字照画", async () => {
		const eyebrow = "flex items-center gap-1 text-[12px] text-[#999] mb-[6px]";
		const common = (head: string): Attachment => ({
			kind: "card",
			eyebrow: head,
			cover: { url: "c" },
			title: "t",
			lines: [{ text: "d" }],
		});
		for (const make of [(head: string) => goods([item("n", "￥1")], head), common]) {
			expect(await attachmentHtml(make(""))).not.toContain(eyebrow);
			expect(await attachmentHtml(make("说明"))).toContain(`<div class="${eyebrow}">说明</div>`);
		}
	});
});

describe("video:封面 + 时长角标 + 标题 + subtitle;没有标题上方的说明", () => {
	const video = (over: Partial<Extract<Attachment, { kind: "video" }>> = {}): Attachment => ({
		kind: "video",
		cover: { url: "http://i1.hdslb.com/bfs/archive/d75b1c59.jpg" },
		title: "中国人能飞~✈️✈️✈️",
		durationSec: 29,
		subtitle: "2654观看 102弹幕",
		...over,
	});

	it("封面、时长(「0:29」,由 formatClock 排)、标题、subtitle 原样都画;根就是卡本身", async () => {
		const html = await attachmentHtml(video());
		expect(html).toMatch(/^<div data-bn="card" class="bg-black\/4 rounded-lg p-\[10px\]">/);
		expect(html).toContain("中国人能飞~✈️✈️✈️");
		expect(html).toContain(">0:29<");
		expect(html).toContain("2654观看 102弹幕");
		expect(html).toContain("http://i1.hdslb.com/bfs/archive/d75b1c59.jpg");
	});

	it.each([
		[0, "0:00"],
		[29, "0:29"],
		[967, "16:07"],
		[3723, "1:02:03"],
	])("durationSec %d → 角标「%s」", async (durationSec, shown) => {
		expect(await attachmentHtml(video({ durationSec }))).toContain(`>${shown}<`);
	});

	it("缺 durationSec / subtitle:照样出卡,没有角标、没有副标题行,不渲染 undefined", async () => {
		const html = await attachmentHtml(video({ durationSec: undefined, subtitle: undefined }));
		expect(html).toContain("中国人能飞~✈️✈️✈️");
		expect(html).not.toContain("undefined");
		expect(html).not.toContain("rounded-[3px]");
		expect(html).not.toContain("truncate");
	});

	// 见 render-uno-scan.test.ts:UnoCSS 扫的是渲染后的整份 HTML,Fragment 锚点
	// `<!--[-->` 里那个落单的 `[` 会一路吃到后面第一个 `]`,把中途的类名并成无效
	// token。被吞的类名只要别处复用过就看不出问题,而视频卡的封面尺寸是全卡唯一
	// 的 —— 一旦被吞,封面就没了尺寸约束,而构建 / 类型 / lint 全绿。
	it("封面尺寸类名真的生成了 CSS 规则,没被 Fragment 锚点吞掉", async () => {
		const node = nodeFromPost(postWith(video()), FMT);
		const html = await renderViaDefaultSkin("post", { node }, { htmlWidth: 600 });
		const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
		for (const cls of ["w-[140px]", "h-[80px]"]) {
			// UnoCSS 输出里类名的方括号是反斜杠转义的:`w-[140px]` → `.w-\[140px\]{…}`。
			const selector = `.${cls.replace(/[[\]]/g, (c) => `\\${c}`)}`;
			expect(
				css.includes(`${selector}{`) || css.includes(`${selector},`),
				`${cls} 的规则没生成`,
			).toBe(true);
		}
	});
});
