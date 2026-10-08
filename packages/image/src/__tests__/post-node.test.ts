/**
 * `Post` → 动态卡的节点(`nodeFromPost`,㉑c 第 5 步)。
 *
 * 十份基准快照钉着「`Post` 字面量 → 字节」,这里钉**规则**:发布时间与 `label` 在节点上分开、默认皮肤的块把它们
 * 拼回老位置,标题两种画法,`notice` 的结构,`card` 按有无 `cover` 分两种版式,图认 `ref`
 * (经注入的解析口)与 `url`、都没有画占位,数字统一经 internal 排版,头像只认引用。
 */

import type { Post } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, type VNode } from "vue";
import { POST_BLOCKS } from "../blocks/post";
import { buildCardData } from "../skin/card-data";
import { BLOCKED_IMG_PLACEHOLDER } from "../skin/render-skin";
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
		expect(node.creatorName).toBe("某人");
		expect(node.creatorIsPremium).toBe(true);
		expect(node.time).toBe("T1700000000");
		expect(nodeFromPost(post(), FMT).creatorIsPremium).toBe(false);
	});

	it("头像:Creator.avatar 是图库引用,经注入的解析口变成地址;没有引用就没有头像地址", () => {
		const imageUrl = (ref: string) =>
			ref === "abc.png" ? "data:image/png;base64,FACE" : undefined;
		const withRef = nodeFromPost(post({ creator: { name: "某人", avatar: "abc.png" } }), {
			...FMT,
			imageUrl,
		});
		expect(withRef.creatorAvatarUrl).toBe("data:image/png;base64,FACE");
		expect(nodeFromPost(post(), { ...FMT, imageUrl }).creatorAvatarUrl).toBeUndefined();
	});

	it("头像引用解析不到(或没注入解析口):给占位,留一块空的头像位,不抛", () => {
		const gone = nodeFromPost(post({ creator: { name: "某人", avatar: "gone.png" } }), {
			...FMT,
			imageUrl: () => undefined,
		});
		expect(gone.creatorAvatarUrl).toBe(BLOCKED_IMG_PLACEHOLDER);
		expect(
			nodeFromPost(post({ creator: { name: "某人", avatar: "gone.png" } }), FMT).creatorAvatarUrl,
		).toBe(BLOCKED_IMG_PLACEHOLDER);
	});

	it("外层卡:time 只有时间,label 单独一格(拼成「时间 · 投稿了视频」是默认皮肤时间块的事),也不是被转发的那层", () => {
		const node = nodeFromPost(post({ label: "投稿了视频" }), FMT);
		expect(node.time).toBe("T1700000000");
		expect(node.label).toBe("投稿了视频");
		expect(node.isReposted).toBeUndefined();
	});

	it("被转发的内层卡:time 只有时间、label 单独一格,并标明自己是被转发的那层;没有 label 就不给这一格", () => {
		const node = nodeFromPost(post({ text: "转发语", repost: post({ label: "投稿了视频" }) }), FMT);
		expect(node.repost?.label).toBe("投稿了视频");
		expect(node.repost?.time).toBe("T1700000000");
		expect(node.repost?.isReposted).toBe(true);
		expect("label" in nodeFromPost(post({ repost: post() }), FMT)).toBe(false);
	});
});

/**
 * 作品卡的动作标签(`label`):视图上时间只装时间、标签单独一格(内外层卡都填);皮肤字段 `post.time` 只是时间、
 * `post.label` 两层都有值;默认皮肤的 `name` / `time` 两块把它们拼回从前那一行字 —— 外层拼进「时间 · 标签」,
 * 被转发的内层接在名字后。(㉔a 先钉的是改名前的现状:`dynamic.time` 外层带标签后缀、`dynamic.action` 外层为空,
 * 默认皮肤画出的字 ㉔b 一个没变。)
 * 验红:把 `post-node.tsx` 里 `label` / `isReposted` 的赋值删掉,或把 `blocks/post.tsx` 里拼标签的位置对调。
 */
describe("动作标签:视图、皮肤字段与默认皮肤的两块", () => {
	const REPOST_VIDEO = post({
		text: "转发语",
		label: "转发了动态",
		repost: post({ creator: { name: "原UP" }, label: "投稿了视频" }),
	});

	it("皮肤字段:内外层的 post.time 都是纯时间,post.label 都有值", () => {
		const outer = nodeFromPost(REPOST_VIDEO, FMT);
		const inner = outer.repost;
		if (!inner) throw new Error("应有转发内层");
		const o = buildCardData("post", { node: outer });
		const i = buildCardData("post", { node: inner });
		expect(o.post.time).toBe("T1700000000");
		expect(o.post.label).toBe("转发了动态");
		expect(i.post.time).toBe("T1700000000");
		expect(i.post.label).toBe("投稿了视频");
	});

	it("没有 label 的作品:post.time 是纯时间、post.label 为空(内外层一样)", () => {
		const outer = nodeFromPost(post({ repost: post() }), FMT);
		const d = buildCardData("post", { node: outer });
		expect(d.post.time).toBe("T1700000000");
		expect(d.post.label).toBe("");
		const inner = outer.repost;
		if (!inner) throw new Error("应有转发内层");
		expect(buildCardData("post", { node: inner }).post.label).toBe("");
	});

	/** 默认皮肤的 `name` / `time` 块画出的文字(去掉标签)。 */
	async function lineOf(block: "creatorName" | "time", node: ReturnType<typeof nodeFromPost>) {
		const vnode = POST_BLOCKS[block]?.({ node, renderForward: () => [] });
		if (!vnode) throw new Error(`${block} 块收起了`);
		return (await htmlOf(vnode)).replace(/<[^>]*>/g, "");
	}

	it("默认皮肤:外层的标签在时间那一行(「时间 · 标签」),名字行只有名字", async () => {
		const outer = nodeFromPost(REPOST_VIDEO, FMT);
		expect(await lineOf("time", outer)).toBe("T1700000000 · 转发了动态");
		expect(await lineOf("creatorName", outer)).toBe("示例UP");
	});

	it("默认皮肤:内层的标签接在名字后(用空格连),时间行只有时间", async () => {
		const inner = nodeFromPost(REPOST_VIDEO, FMT).repost;
		if (!inner) throw new Error("应有转发内层");
		expect(await lineOf("creatorName", inner)).toBe("原UP 投稿了视频");
		expect(await lineOf("time", inner)).toBe("T1700000000");
	});
});

describe("正文:标题两种画法、notice、充电专属", () => {
	it("title:画在正文上方、排版照普通作品(九行截断的普通路径,标题是 h1)", async () => {
		const node = nodeFromPost(post({ title: "图文标题", text: "正文" }), FMT);
		const html = await htmlOf(node.text as VNode);
		expect(html.indexOf("图文标题")).toBeLessThan(html.indexOf("正文"));
		expect(html).toContain('<h1 class="text-[18px] font-bold mb-2">图文标题</h1>');
	});

	it("article:走专栏那条路(innerHTML,标题是 article.title 且在正文上方,换行成 <br><br>)", async () => {
		const node = nodeFromPost(post({ article: { title: "专栏标题" }, text: "甲\n乙" }), FMT);
		const html = await htmlOf(node.text as VNode);
		expect(html).toContain("mb-[8px]");
		expect(html).toContain("甲<br><br>乙");
		expect(html.indexOf("专栏标题")).toBeLessThan(html.indexOf("甲"));
	});

	it("只有标题没有字:标题照画(正文根里只有 <h1>);article.title 是空串则不画标题", async () => {
		const titled = nodeFromPost(post({ title: "只有标题" }), FMT);
		expect(await htmlOf(titled.text as VNode)).toContain("<h1");
		expect(nodeFromPost(post({ article: { title: "" } }), FMT).text).toBeUndefined();
	});

	it("body 挂点:正文的根只挂 body 这一个(专栏与普通路径各有一个根,都挂)", async () => {
		for (const over of [{ text: "普通正文" }, { article: { title: "" }, text: "专栏正文" }]) {
			const html = await htmlOf(nodeFromPost(post(over), FMT).text as VNode);
			const hooks = [...html.matchAll(/data-bn="([^"]*)"/g)].map((m) => m[1]);
			expect(hooks).toEqual(["body"]);
		}
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

	it("locked 替掉正文:徽标图(给了才画;认图库引用,只有地址画占位)、标题、说明", async () => {
		const withIcon = nodeFromPost(
			post({
				text: "不会画",
				locked: { icon: { ref: "badge.png" }, title: "充电专属", hint: "为 甲 充电" },
			}),
			{ ...FMT, imageUrl: (ref) => (ref === "badge.png" ? "data:image/png;base64,B" : undefined) },
		);
		const html = await htmlOf(withIcon.text as VNode);
		expect(html).toContain('src="data:image/png;base64,B"');
		const urlOnly = nodeFromPost(
			post({ locked: { icon: { url: "http://x/b.png" }, title: "t", hint: "h" } }),
			FMT,
		);
		const urlOnlyHtml = await htmlOf(urlOnly.text as VNode);
		expect(urlOnlyHtml).not.toContain("http://x/b.png");
		expect(urlOnlyHtml).toContain(`src="${BLOCKED_IMG_PLACEHOLDER}"`);
		expect(html).toContain("充电专属");
		expect(html).toContain("为 甲 充电");
		expect(html).not.toContain("不会画");
		const noIcon = nodeFromPost(post({ locked: { title: "t", hint: "h" } }), FMT);
		expect(await htmlOf(noIcon.text as VNode)).not.toContain("<img");
	});
});

describe("被转发的内层卡", () => {
	it("原作品是充电专属:内层卡也画占位,不留空白", async () => {
		const node = nodeFromPost(
			post({
				text: "转发语",
				repost: post({
					creator: { name: "原作者" },
					locked: { title: "充电专属", hint: "为 原作者 充电即可查看完整内容" },
				}),
			}),
			FMT,
		);
		const inner = node.repost;
		expect(inner?.creatorName).toBe("原作者");
		const html = await htmlOf(inner?.text as VNode);
		expect(html).toContain("充电专属");
		expect(html).toContain("为 原作者 充电即可查看完整内容");
	});

	it("内层自己的文字与图各在内层那份里,外层只是转发语", async () => {
		const node = nodeFromPost(
			post({
				text: "转发语",
				repost: post({ text: "原动态的正文", images: [{ url: "a" }, { url: "b" }] }),
			}),
			FMT,
		);
		expect(await htmlOf(node.text as VNode)).not.toContain("原动态的正文");
		expect(node.images).toBeUndefined();
		expect(await htmlOf(node.repost?.text as VNode)).toContain("原动态的正文");
		expect(node.repost?.images).toHaveLength(2);
	});
});

describe("图集与视频", () => {
	it("图只认 ref(经解析口);`ref` 与 `url` 都有时认 `ref`;只有 url、都没有、或引用解析不到画占位", () => {
		const node = nodeFromPost(
			post({
				images: [
					{ url: "a" },
					{ ref: "x.png", url: "ignored" },
					{ ref: "gone.png", url: "also-ignored" },
					{},
					{ url: "b", width: 1, height: 2, isAnimated: true },
				],
			}),
			{ ...FMT, imageUrl: (ref) => (ref === "x.png" ? "data:image/png;base64,X" : undefined) },
		);
		expect(node.images).toEqual([
			{ url: BLOCKED_IMG_PLACEHOLDER, width: undefined, height: undefined, animated: undefined },
			{ url: "data:image/png;base64,X", width: undefined, height: undefined, animated: undefined },
			{ url: BLOCKED_IMG_PLACEHOLDER, width: undefined, height: undefined, animated: undefined },
			{ url: BLOCKED_IMG_PLACEHOLDER, width: undefined, height: undefined, animated: undefined },
			// 宽高与动图标记跟着图走,和画不画得出来无关。
			{ url: BLOCKED_IMG_PLACEHOLDER, width: 1, height: 2, animated: true },
		]);
		const article = nodeFromPost(
			post({ article: { title: "", images: [{ ref: "x.png" }, { url: "c" }] } }),
			{ ...FMT, imageUrl: (ref) => (ref === "x.png" ? "data:image/png;base64,X" : undefined) },
		);
		expect(article.images?.map((image) => image.url)).toEqual([
			"data:image/png;base64,X",
			BLOCKED_IMG_PLACEHOLDER,
		]);
	});

	it("视频:播放 / 弹幕 / 时长是数字,由 internal 统一排版;缺哪一格不带哪一格;封面只认引用", () => {
		const stored = { ...FMT, imageUrl: (ref: string) => (ref === "c.png" ? "c" : undefined) };
		const node = nodeFromPost(
			post({
				video: {
					cover: { ref: "c.png" },
					title: "t",
					description: "d",
					durationSec: 967,
					views: 18_000,
					danmaku: 129,
				},
			}),
			stored,
		);
		expect(node.video).toEqual({
			cover: "c",
			duration: "16:07",
			title: "t",
			description: "d",
			views: "1.8万",
			danmaku: "129",
		});
		// 只有地址的封面画占位,地址不进卡。
		const bare = nodeFromPost(
			post({ video: { cover: { url: "c" }, title: "t", description: "" } }),
			stored,
		);
		expect(bare.video).toEqual({
			cover: BLOCKED_IMG_PLACEHOLDER,
			duration: "",
			title: "t",
			description: "",
		});
	});

	it.each([
		[0, "0:00"],
		[29, "0:29"],
		[967, "16:07"],
		[3723, "1:02:03"],
	])("时长角标:durationSec %d → 「%s」(统一经 formatClock)", async (durationSec, shown) => {
		const node = nodeFromPost(
			post({ video: { cover: { url: "c" }, title: "t", description: "", durationSec } }),
			FMT,
		);
		expect(node.video?.duration).toBe(shown);
	});

	it("播放 / 弹幕统一经 formatCount:整万补一位小数,万以下原样", () => {
		const views = (n: number) =>
			nodeFromPost(
				post({ video: { cover: { url: "c" }, title: "t", description: "", views: n, danmaku: n } }),
				FMT,
			).video;
		expect(views(10_000)).toMatchObject({ views: "1.0万", danmaku: "1.0万" });
		expect(views(18_000)).toMatchObject({ views: "1.8万" });
		expect(views(129)).toMatchObject({ views: "129" });
		expect(views(0)).toMatchObject({ views: "0", danmaku: "0" });
		expect(views(120_000_000)).toMatchObject({ views: "1.2亿" });
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
		expect(POST_BLOCKS.videoDuration(props(video()))).toBeNull();
		expect(await htmlOf(POST_BLOCKS.videoDuration(props(video(0))) as VNode)).toContain("0:00");
	});
});

describe("互动数与转发", () => {
	it("互动数经 formatCount;没报的那一项空串(那一格不画);三项都没有就整个没有", () => {
		expect(
			nodeFromPost(post({ stats: { shares: 12_345, comments: 9999, likes: 0 } }), FMT).stats,
		).toEqual({
			shares: "1.2万",
			comments: "9999",
			likes: "0",
		});
		expect(nodeFromPost(post({ stats: { likes: 7 } }), FMT).stats).toEqual({
			shares: "",
			comments: "",
			likes: "7",
		});
		expect(nodeFromPost(post({ stats: {} }), FMT).stats).toBeUndefined();
		expect(nodeFromPost(post(), FMT).stats).toBeUndefined();
	});

	it("被转发的内层卡不展示互动数,即使 repost 自己带着", () => {
		const node = nodeFromPost(
			post({ repost: post({ stats: { shares: 1, comments: 2, likes: 3 } }) }),
			FMT,
		);
		expect(node.repost?.stats).toBeUndefined();
	});
});

describe("出卡器自己的图标不动", () => {
	it("话题行、播放、弹幕、三个互动数的图标都还在", async () => {
		const node = nodeFromPost(
			post({
				topic: "示例话题",
				video: { cover: { url: "c" }, title: "t", description: "", views: 1, danmaku: 2 },
				stats: { shares: 1, comments: 2, likes: 3 },
			}),
			FMT,
		);
		const props = { node, renderForward: (): [] => [] };
		expect(await htmlOf(POST_BLOCKS.topic(props) as VNode)).toContain("<svg");
		for (const [block, label] of [
			["shareCount", "转发"],
			["commentCount", "评论"],
			["likeCount", "点赞"],
		] as const) {
			expect(await htmlOf(POST_BLOCKS[block](props) as VNode)).toContain(`aria-label="${label}"`);
		}
		const stats = await htmlOf(POST_BLOCKS.videoStats(props) as VNode);
		expect(stats).toContain('aria-label="播放量"');
		expect(stats).toContain('aria-label="弹幕"');
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
		const a = await htmlOf(withCover.attachment as VNode);
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
		const b = await htmlOf(noCover.attachment as VNode);
		expect(b).not.toContain('data-bn="cover"');
		expect(b).toContain("text-[14px] font-bold");
		expect(b).toContain("bg-[#f5f5f5] text-[#999]");
		expect(count(b, 'data-bn="button"')).toBe(1);
	});

	it("没有 attachment:node.attachment 是 null(块收起)", () => {
		expect(nodeFromPost(post(), FMT).attachment).toBeNull();
	});
});
