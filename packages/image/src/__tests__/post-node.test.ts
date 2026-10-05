/**
 * `Post` → 动态卡的节点(`nodeFromPost`,㉑c 第 5 步)。
 *
 * 十份基准快照钉着「`Post` 字面量 → 字节」,这里钉**规则**:皮肤契约的 `dynamic.type` 从形状推,发布时间与
 * `label` 出卡时拼回老位置,标题两种画法,`notice` 的结构,`card` 按有无 `cover` 分两种版式,图只认 `url`,
 * 数字统一经 internal 排版,头像不画。
 */

import type { Post } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, type VNode } from "vue";
import { DYNAMIC_BLOCKS } from "../blocks/dynamic";
import { nodeFromPost } from "../templates/post-node";

const FMT = { time: (seconds: number) => `T${seconds}` };

const htmlOf = (vnode: VNode): Promise<string> =>
	renderToString(createSSRApp({ render: () => vnode }));

function post(over: Partial<Post> = {}): Post {
	return {
		creator: { name: "示例UP" },
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "",
		...over,
	};
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("作者、时间与 label", () => {
	it("名字与大会员;发布时间交给注入的格式化器(unix 秒)", () => {
		const node = nodeFromPost(post({ creator: { name: "某人", isPremium: true } }), FMT);
		expect(node.upName).toBe("某人");
		expect(node.upIsVip).toBe(true);
		expect(node.pubTime).toBe("T1700000000");
		expect(nodeFromPost(post(), FMT).upIsVip).toBe(false);
	});

	it("头像不画:node 没有 avatarUrl,Creator.avatar(图库引用)也不会变成地址", () => {
		const node = nodeFromPost(post({ creator: { name: "某人", avatar: "abc.png" } }), FMT);
		expect(node.avatarUrl).toBeUndefined();
	});

	it("外层卡:label 接在发布时间后(「时间 · 投稿了视频」),没有 headerLabel", () => {
		const node = nodeFromPost(post({ label: "投稿了视频" }), FMT);
		expect(node.pubTime).toBe("T1700000000 · 投稿了视频");
		expect(node.headerLabel).toBeUndefined();
	});

	it("被转发的内层卡:label 接在作者名后(headerLabel),发布时间不带后缀", () => {
		const node = nodeFromPost(post({ text: "转发语", repost: post({ label: "投稿了视频" }) }), FMT);
		expect(node.forward?.headerLabel).toBe("投稿了视频");
		expect(node.forward?.pubTime).toBe("T1700000000");
	});
});

describe("dynamic.type 从形状推", () => {
	it.each([
		["有视频 → AV", { video: { cover: {}, title: "t", description: "" } }, "DYNAMIC_TYPE_AV"],
		["有被转发的原作品 → FORWARD", { repost: post() }, "DYNAMIC_TYPE_FORWARD"],
		["专栏 → ARTICLE", { article: { title: "t" } }, "DYNAMIC_TYPE_ARTICLE"],
		["有图集 → DRAW", { images: [{ url: "u" }] }, "DYNAMIC_TYPE_DRAW"],
		["其余 → WORD", { notice: "无法渲染" }, "DYNAMIC_TYPE_WORD"],
	] as [string, Partial<Post>, string][])("%s", (_label, over, type) => {
		expect(nodeFromPost(post(over), FMT).type).toBe(type);
	});

	it("转发自己带图仍是 FORWARD(转发优先于图集)", () => {
		expect(nodeFromPost(post({ repost: post(), images: [{ url: "u" }] }), FMT).type).toBe(
			"DYNAMIC_TYPE_FORWARD",
		);
	});
});

describe("正文:标题两种画法、notice、充电专属", () => {
	it("title:画在正文上方、排版照普通作品(九行截断的普通路径,标题是 h1)", async () => {
		const node = nodeFromPost(post({ title: "图文标题", text: "正文" }), FMT);
		const html = await htmlOf(node.text as VNode);
		expect(html.indexOf("图文标题")).toBeLessThan(html.indexOf("正文"));
		expect(html).toContain('<h1 class="text-[18px] font-bold mb-2">图文标题</h1>');
	});

	it("article:走专栏那条路(innerHTML,标题是 article.title,换行成 <br><br>)", async () => {
		const node = nodeFromPost(post({ article: { title: "专栏标题" }, text: "甲\n乙" }), FMT);
		const html = await htmlOf(node.text as VNode);
		expect(html).toContain("mb-[8px]");
		expect(html).toContain("甲<br><br>乙");
	});

	it("richText 的片段按种类上色:mention / link 蓝、topic 粉、emoji 与 text 是普通文字", async () => {
		const node = nodeFromPost(
			post({
				text: "@甲#话题#链接[doge]字",
				richText: [
					{ kind: "mention", text: "@甲" },
					{ kind: "topic", text: "#话题#", name: "话题" },
					{ kind: "link", text: "链接", url: "u" },
					{ kind: "emoji", text: "[doge]" },
					{ kind: "text", text: "字" },
				],
			}),
			FMT,
		);
		const html = await htmlOf(node.text as VNode);
		expect(html).toContain('<span class="text-[#00AEEC]">@甲</span>');
		expect(html).toContain('<span class="text-[#FF6699]">#话题#</span>');
		expect(html).toContain('<span class="text-[#00AEEC]">链接</span>');
		expect(html).toContain("[doge]字");
		expect(html).not.toContain("<img");
	});

	it("没有 richText 就把 text 当一段文字画", async () => {
		const node = nodeFromPost(post({ text: "只有纯文字" }), FMT);
		expect(await htmlOf(node.text as VNode)).toContain("只有纯文字");
	});

	it("没有字也没有标题:不画正文", () => {
		expect(nodeFromPost(post(), FMT).text).toBeUndefined();
	});

	it("notice:紧跟正文之后的一句 <p>;正文没有字时只剩这句 <p>", async () => {
		const withBody = nodeFromPost(post({ text: "转发语", notice: "原动态已不可见" }), FMT);
		const html = await htmlOf(withBody.text as VNode);
		expect(html.indexOf("转发语")).toBeLessThan(html.indexOf("<p>原动态已不可见</p>"));
		const alone = nodeFromPost(post({ notice: "无法渲染" }), FMT);
		expect(await htmlOf(alone.text as VNode)).toBe("<p>无法渲染</p>");
	});

	it("locked 替掉正文:徽标图(有地址才画)、标题、说明", async () => {
		const withIcon = nodeFromPost(
			post({
				text: "不会画",
				locked: { icon: { url: "http://x/b.png" }, title: "充电专属", hint: "为 甲 充电" },
			}),
			FMT,
		);
		const html = await htmlOf(withIcon.text as VNode);
		expect(html).toContain('src="http://x/b.png"');
		expect(html).toContain("充电专属");
		expect(html).toContain("为 甲 充电");
		expect(html).not.toContain("不会画");
		const noIcon = nodeFromPost(post({ locked: { title: "t", hint: "h" } }), FMT);
		expect(await htmlOf(noIcon.text as VNode)).not.toContain("<img");
	});
});

describe("图集与视频", () => {
	it("图只认 url:只有 ref 的那张不画;专栏的图取 article.images", () => {
		const node = nodeFromPost(
			post({
				images: [
					{ url: "a" },
					{ ref: "x.png" },
					{ url: "b", width: 1, height: 2, isAnimated: true },
				],
			}),
			FMT,
		);
		expect(node.images).toEqual([
			{ url: "a", width: undefined, height: undefined, animated: undefined },
			{ url: "b", width: 1, height: 2, animated: true },
		]);
		const article = nodeFromPost(post({ article: { title: "", images: [{ url: "c" }] } }), FMT);
		expect(article.images?.map((image) => image.url)).toEqual(["c"]);
	});

	it("视频:播放 / 弹幕 / 时长是数字,由 internal 统一排版;缺哪一格不带哪一格", () => {
		const node = nodeFromPost(
			post({
				video: {
					cover: { url: "c" },
					title: "t",
					description: "d",
					durationSec: 967,
					views: 18_000,
					danmaku: 129,
				},
			}),
			FMT,
		);
		expect(node.video).toEqual({
			cover: "c",
			duration: "16:07",
			title: "t",
			desc: "d",
			views: "1.8万",
			danmaku: "129",
		});
		const bare = nodeFromPost(
			post({ video: { cover: { url: "c" }, title: "t", description: "" } }),
			FMT,
		);
		expect(bare.video).toEqual({ cover: "c", duration: "", title: "t", desc: "" });
	});

	it("durationSec 缺了:时长角标整块收起;为 0 照画「0:00」(缺了才是没有)", async () => {
		const video = (durationSec?: number) =>
			nodeFromPost(
				post({
					video: {
						cover: { url: "c" },
						title: "t",
						description: "",
						...(durationSec === undefined ? {} : { durationSec }),
					},
				}),
				FMT,
			);
		const props = (node: ReturnType<typeof nodeFromPost>) => ({
			node,
			renderForward: (): [] => [],
		});
		expect(DYNAMIC_BLOCKS.videoDuration(props(video()))).toBeNull();
		expect(await htmlOf(DYNAMIC_BLOCKS.videoDuration(props(video(0))) as VNode)).toContain("0:00");
	});
});

describe("互动数与转发", () => {
	it("互动数经 formatCount;没报的那一项空串(那一格不画);三项都没有就整个没有", () => {
		expect(
			nodeFromPost(post({ stats: { shares: 12_345, comments: 9999, likes: 0 } }), FMT).stats,
		).toEqual({
			forward: "1.2万",
			comment: "9999",
			like: "0",
		});
		expect(nodeFromPost(post({ stats: { likes: 7 } }), FMT).stats).toEqual({
			forward: "",
			comment: "",
			like: "7",
		});
		expect(nodeFromPost(post({ stats: {} }), FMT).stats).toBeUndefined();
		expect(nodeFromPost(post(), FMT).stats).toBeUndefined();
	});

	it("被转发的内层卡不展示互动数,即使 repost 自己带着", () => {
		const node = nodeFromPost(
			post({ repost: post({ stats: { shares: 1, comments: 2, likes: 3 } }) }),
			FMT,
		);
		expect(node.forward?.stats).toBeUndefined();
	});
});

describe("附加块", () => {
	it("card 有 cover:通用卡的排法(头部说明 + 封面 + 标题 + 行 + 按钮),无 cover:预约卡的排法", async () => {
		const withCover = nodeFromPost(
			post({
				attachment: {
					kind: "card",
					eyebrow: "相关游戏",
					cover: { url: "c" },
					title: "游戏",
					lines: [{ text: "甲" }, { text: "乙" }],
					button: { text: "去下载", enabled: true },
				},
			}),
			FMT,
		);
		const a = await htmlOf(withCover.additional as VNode);
		expect(a).toContain("相关游戏");
		expect(a).toContain('data-bn="cover"');
		expect(a).toContain("text-[13px] font-bold");
		const noCover = nodeFromPost(
			post({
				attachment: {
					kind: "card",
					title: "预约",
					lines: [{ text: "甲" }],
					button: { text: "已结束", enabled: false },
				},
			}),
			FMT,
		);
		const b = await htmlOf(noCover.additional as VNode);
		expect(b).not.toContain('data-bn="cover"');
		expect(b).toContain("text-[14px] font-bold");
		expect(b).toContain("bg-[#f5f5f5] text-[#999]");
		expect(count(b, 'data-bn="button"')).toBe(1);
	});

	it("没有 attachment:additional 是 null(块收起)", () => {
		expect(nodeFromPost(post(), FMT).additional).toBeNull();
	});
});
