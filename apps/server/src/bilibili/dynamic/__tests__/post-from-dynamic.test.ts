/**
 * B 站原始动态 → `Post` 的翻译(㉑c 第 5 步)。
 *
 * 分三段:
 *
 * 1. **链条的这一腿**:十份 B 站原始夹具(`fixtures/bili-dynamic-fixtures.ts`)翻出来的 `Post`,与 `packages/image`
 *    出图基准用的那十份 `Post` 字面量(`@bilibili-notify/image/testing` 的 `DYNAMIC_SAMPLE_POSTS`)逐项相等。出图那一腿
 *    在 image 的 `card-baseline.test.ts`:同一份中间产物夹在两腿中间,「原始数据 → 字节」整条链才都钉着。
 * 2. **`richText` 对得上 `text`**:`normalizePost` 发现片段的字拼起来不等于 `text` 会**悄悄丢掉整份 `richText`**,
 *    正文里的 @ / 话题 / 链接高亮就无声消失。翻译保证对得上,这里有一条直说原因的测试。
 * 3. 翻译表逐条:富文本节点五种片段、标题两种去处、图集与动图判据、视频的数字、附加块、充电专属、「暂时无法渲染」与
 *    「原动态不可见」、转发、互动数、时间。
 */

import { DYNAMIC_SAMPLE_POSTS } from "@bilibili-notify/image/testing";
import { normalizePost, type Post } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n/index.js";
import { emojiUrlsOf, postFromDynamic } from "../post-from-dynamic";
import type { Dynamic } from "../types";
import { BILI_DYNAMIC_SAMPLES, LIVE_RCMD_DYNAMIC } from "./fixtures/bili-dynamic-fixtures";

// ── 小工具 ────────────────────────────────────────────────────────────────────

const text = (t: string) => ({ type: "RICH_TEXT_NODE_TYPE_TEXT", orig_text: t, text: t });
const node = (type: string, t: string, extra: Record<string, unknown> = {}) => ({
	type,
	orig_text: t,
	text: t,
	...extra,
});

/** 造一条最小的原始动态;`moduleDynamic` 由用例给全。 */
function raw(
	type: string,
	moduleDynamic: Record<string, unknown> = {},
	over: Record<string, unknown> = {},
	author: Record<string, unknown> = {},
): Dynamic {
	return {
		basic: {},
		id_str: "1",
		type,
		modules: {
			module_author: {
				face: "http://example.invalid/face.jpg",
				name: "示例UP",
				vip: { type: 0 },
				pub_ts: 1_700_000_000,
				...author,
			},
			module_dynamic: moduleDynamic,
			module_stat: { forward: { count: 1 }, comment: { count: 2 }, like: { count: 3 } },
		},
		...over,
	} as unknown as Dynamic;
}

const desc = (...nodes: unknown[]) => ({ desc: { text: "", rich_text_nodes: nodes } });
const opus = (o: { summary?: unknown[]; title?: string; pics?: unknown[] }) => ({
	major: {
		type: "MAJOR_TYPE_OPUS",
		opus: {
			title: o.title,
			pics: o.pics,
			summary: o.summary === undefined ? undefined : { text: "", rich_text_nodes: o.summary },
		},
	},
});

/** 这条 Post 与它的整串被转发原作品。 */
function chain(post: Post): Post[] {
	return post.repost ? [post, ...chain(post.repost)] : [post];
}

// ── 1. 链条的这一腿 ───────────────────────────────────────────────────────────

describe("十份原始夹具 → 出图基准用的 Post 字面量", () => {
	it("两边是同样的十个样例名", () => {
		expect(Object.keys(BILI_DYNAMIC_SAMPLES).sort()).toEqual(
			Object.keys(DYNAMIC_SAMPLE_POSTS).sort(),
		);
		expect(Object.keys(DYNAMIC_SAMPLE_POSTS)).toHaveLength(10);
	});

	for (const [name, source] of Object.entries(BILI_DYNAMIC_SAMPLES)) {
		it(`${name}:postFromDynamic(原始夹具) 与 Post 字面量逐项相等`, () => {
			expect(postFromDynamic(source)).toEqual(DYNAMIC_SAMPLE_POSTS[name]);
		});
	}

	it("顶层的开播伪动态抛「直播开播动态，不做处理」(动态轮询在这之前就按类型跳过了它)", () => {
		expect(() => postFromDynamic(LIVE_RCMD_DYNAMIC)).toThrow("直播开播动态，不做处理");
	});

	it("转发里的开播伪动态不抛,当一句提示 —— 抛了整张转发卡都出不来", () => {
		const post = postFromDynamic(
			raw("DYNAMIC_TYPE_FORWARD", desc(text("转发语")), { orig: LIVE_RCMD_DYNAMIC }),
		);
		expect(post.repost?.notice).toBe("示例UP发布了一条开播动态，我暂时无法渲染，请自行查看");
	});
});

// ── 2. richText 对得上 text ───────────────────────────────────────────────────

describe("richText 对得上 text —— 对不上会被 normalizePost 悄悄丢掉,高亮就无声消失", () => {
	it("十份夹具(含被转发的原作品)里,凡有富文本的作品,翻出来的 richText 都还在、字拼起来等于 text", () => {
		for (const [name, source] of Object.entries(BILI_DYNAMIC_SAMPLES)) {
			for (const post of chain(postFromDynamic(source))) {
				if (post.text === "") continue;
				expect(
					post.richText,
					`${name}:正文有字却没有 richText —— 翻译出来的片段与 text 对不上,被 normalizePost 丢掉了`,
				).toBeDefined();
				expect(post.richText?.map((segment) => segment.text).join("")).toBe(post.text);
			}
		}
	});

	it("这条测试守的机制:片段与 text 对不上,normalizePost 就丢掉 richText、只留 text", () => {
		const post: Post = {
			creator: { name: "某人" },
			publishedAt: "2026-01-01T00:00:00.000Z",
			text: "你好",
			richText: [{ kind: "text", text: "你坏" }],
		};
		expect(normalizePost(post).richText).toBeUndefined();
	});

	it("desc 与摘要合成一段时也对得上(中间夹一个换行片段)", () => {
		const post = postFromDynamic(
			raw("DYNAMIC_TYPE_DRAW", {
				...desc(text("转发语"), node("RICH_TEXT_NODE_TYPE_TOPIC", "#话题#")),
				...opus({ summary: [text("摘要")] }),
			}),
		);
		expect(post.text).toBe("转发语#话题#\n摘要");
		expect(post.richText?.map((segment) => segment.text).join("")).toBe(post.text);
	});
});

// ── 3. 翻译表 ─────────────────────────────────────────────────────────────────

describe("作者与时间", () => {
	it("名字与大会员;头像不给(Creator.avatar 只收图库引用,B 站 3a 才存)", () => {
		const vip = postFromDynamic(raw("DYNAMIC_TYPE_WORD", {}, {}, { vip: { type: 1 } }));
		expect(vip.creator).toEqual({ name: "示例UP", isPremium: true });
		const plain = postFromDynamic(raw("DYNAMIC_TYPE_WORD"));
		expect(plain.creator).toEqual({ name: "示例UP", isPremium: false });
		expect(vip.creator).not.toHaveProperty("avatar");
	});

	it("发布时间:unix 秒(数字或数字字符串)→ ISO;缺了或不是数就落在纪元", () => {
		const iso = (pubTs: unknown) =>
			postFromDynamic(raw("DYNAMIC_TYPE_WORD", {}, {}, { pub_ts: pubTs })).publishedAt;
		expect(iso(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
		expect(iso("1700000000")).toBe("2023-11-14T22:13:20.000Z");
		expect(iso(undefined)).toBe("1970-01-01T00:00:00.000Z");
		expect(iso("昨天")).toBe("1970-01-01T00:00:00.000Z");
		expect(iso(-1)).toBe("1970-01-01T00:00:00.000Z");
	});

	it("话题:module_dynamic.topic.name → topic", () => {
		const post = postFromDynamic(raw("DYNAMIC_TYPE_WORD", { topic: { id: 1, name: "周年庆典" } }));
		expect(post.topic).toBe("周年庆典");
		expect(postFromDynamic(raw("DYNAMIC_TYPE_WORD")).topic).toBeUndefined();
	});
});

describe("富文本节点 → 五种片段", () => {
	const segmentsOf = (...nodes: unknown[]) =>
		postFromDynamic(raw("DYNAMIC_TYPE_WORD", desc(...nodes))).richText;

	/** 验红:让翻译不去掉话题名两头的 `#`,这条红。 */
	it("TOPIC → topic,name 去掉两头的 #(「#话题#」「#话题」都行)", () => {
		expect(
			segmentsOf(
				node("RICH_TEXT_NODE_TYPE_TOPIC", "#周年庆典#"),
				node("RICH_TEXT_NODE_TYPE_TOPIC", "#单边"),
			),
		).toEqual([
			{ kind: "topic", text: "#周年庆典#", name: "周年庆典" },
			{ kind: "topic", text: "#单边", name: "单边" },
		]);
	});

	it("AT → mention,有 rid 带 externalId,没有就不带", () => {
		expect(
			segmentsOf(
				node("RICH_TEXT_NODE_TYPE_AT", "@甲", { rid: "12345" }),
				node("RICH_TEXT_NODE_TYPE_AT", "@乙"),
			),
		).toEqual([
			{ kind: "mention", text: "@甲", externalId: "12345" },
			{ kind: "mention", text: "@乙" },
		]);
	});

	it.each(["BV", "AV", "LOTTERY", "WEB", "CV", "TAOBAO", "GOODS", "VOTE", "OGV_SEASON", "OGV_EP"])(
		"%s → link,没有 icon,url 取 jump_url(没有就是空串)",
		(kind) => {
			const type = `RICH_TEXT_NODE_TYPE_${kind}`;
			expect(
				segmentsOf(node(type, "文字", { jump_url: "//x.example/1" }), node(type, "无址")),
			).toEqual([
				{ kind: "link", text: "文字", url: "//x.example/1" },
				{ kind: "link", text: "无址", url: "" },
			]);
		},
	);

	it("表情 → emoji,只带 text(「[doge]」),不带 image", () => {
		const segments = segmentsOf({
			...node("RICH_TEXT_NODE_TYPE_EMOJI", "[doge]"),
			emoji: { icon_url: "http://example.invalid/e.png", size: 1, text: "[doge]", type: 1 },
		});
		expect(segments).toEqual([{ kind: "emoji", text: "[doge]" }]);
	});

	/**
	 * 安全:表情图地址来自接口(攻击者可控),翻译根本不带 —— `emoji` 片段只有 `text`。原来的专栏转义回归
	 * 守的就是这个地址别拼进 innerHTML;现在它连 `Post` 都进不去。
	 */
	it("表情图地址里的引号 / 标签 breakout:整份 Post 里找不到那个地址", () => {
		const evil = '"><script>alert(1)</script><img src="';
		const post = postFromDynamic(
			raw(
				"DYNAMIC_TYPE_ARTICLE",
				desc({
					...node("RICH_TEXT_NODE_TYPE_EMOJI", ":x:"),
					emoji: { icon_url: evil, size: 1, text: ":x:", type: 1 },
				}),
			),
		);
		const serialized = JSON.stringify(post);
		expect(serialized).not.toContain("alert(1)");
		expect(serialized).not.toContain("icon_url");
		expect(post.richText).toEqual([{ kind: "emoji", text: ":x:" }]);
	});

	it("别的(普通文字、不认识的类型)→ text,换行留在 text 里", () => {
		expect(segmentsOf(text("甲\n乙"), node("RICH_TEXT_NODE_TYPE_SOMETHING_NEW", "新种类"))).toEqual(
			[
				{ kind: "text", text: "甲\n乙" },
				{ kind: "text", text: "新种类" },
			],
		);
	});
});

describe("正文、标题与专栏", () => {
	it("desc 与摘要都有:合成一段 text(换行连接)、一份 richText;只有一件不多出换行", () => {
		const both = postFromDynamic(
			raw("DYNAMIC_TYPE_DRAW", { ...desc(text("转发语")), ...opus({ summary: [text("摘要")] }) }),
		);
		expect(both.text).toBe("转发语\n摘要");
		expect(both.richText).toEqual([
			{ kind: "text", text: "转发语" },
			{ kind: "text", text: "\n" },
			{ kind: "text", text: "摘要" },
		]);
		expect(postFromDynamic(raw("DYNAMIC_TYPE_WORD", desc(text("只有 desc")))).text).toBe(
			"只有 desc",
		);
		expect(
			postFromDynamic(raw("DYNAMIC_TYPE_DRAW", opus({ summary: [text("只有摘要")] }))).text,
		).toBe("只有摘要");
	});

	it("一边是空数组:不夹换行;两边都空:text 是空串、没有 richText", () => {
		const half = postFromDynamic(
			raw("DYNAMIC_TYPE_DRAW", { ...desc(), ...opus({ summary: [text("摘要")] }) }),
		);
		expect(half.text).toBe("摘要");
		const none = postFromDynamic(raw("DYNAMIC_TYPE_DRAW", { ...desc(), ...opus({ summary: [] }) }));
		expect(none.text).toBe("");
		expect(none.richText).toBeUndefined();
	});

	it("带标题的非专栏 opus → title(画在正文上方),不是 article", () => {
		const post = postFromDynamic(
			raw("DYNAMIC_TYPE_DRAW", opus({ title: "图文标题", summary: [text("摘要")] })),
		);
		expect(post.title).toBe("图文标题");
		expect(post.article).toBeUndefined();
	});

	it("没有字、有标题的图文:标题照样带着(信息不丢,出不出卡由出图器定)", () => {
		const post = postFromDynamic(raw("DYNAMIC_TYPE_DRAW", opus({ title: "只有标题" })));
		expect(post.title).toBe("只有标题");
		expect(post.text).toBe("");
	});

	it("专栏 → article(title 与配图),label「投稿了专栏」,不用 title", () => {
		const post = postFromDynamic(
			raw(
				"DYNAMIC_TYPE_ARTICLE",
				opus({
					title: "专栏标题",
					summary: [text("摘要")],
					pics: [{ url: "http://example.invalid/a.jpg", width: 900, height: 4800 }],
				}),
			),
		);
		expect(post.article).toEqual({
			title: "专栏标题",
			images: [
				{ url: "http://example.invalid/a.jpg", width: 900, height: 4800, isAnimated: false },
			],
		});
		expect(post.label).toBe("投稿了专栏");
		expect(post.title).toBeUndefined();
		expect(post.images).toBeUndefined();
	});

	it("专栏里 desc 与摘要也合成一段(换行连接),标题仍只有一个", () => {
		const post = postFromDynamic(
			raw("DYNAMIC_TYPE_ARTICLE", {
				...desc(text("导语")),
				...opus({ title: "专栏标题", summary: [text("专栏摘要")] }),
			}),
		);
		expect(post.text).toBe("导语\n专栏摘要");
		expect(post.article?.title).toBe("专栏标题");
		expect(post.richText?.map((segment) => segment.text).join("")).toBe(post.text);
	});

	it("没有 opus 标题的专栏:article.title 是空串(出图器据此不画标题)", () => {
		const post = postFromDynamic(raw("DYNAMIC_TYPE_ARTICLE", opus({ summary: [text("摘要")] })));
		expect(post.article).toEqual({ title: "" });
	});
});

describe("图集", () => {
	const pic = (url: string, extra: Record<string, unknown> = {}) => ({
		url,
		width: 100,
		height: 200,
		...extra,
	});

	it("图文的图 → images;宽高带着,动图由 live_url 或 .gif 结尾(先削掉 @ 后缀与 query)判", () => {
		const post = postFromDynamic(
			raw(
				"DYNAMIC_TYPE_DRAW",
				opus({
					pics: [
						pic("http://x.example/a.jpg"),
						pic("http://x.example/b.gif@1280w_80q_1s.webp?from=dyn"),
						pic("http://x.example/c.jpg", { live_url: "http://x.example/c.mp4" }),
						pic("http://x.example/d.jpg?x=.gif"),
					],
				}),
			),
		);
		expect(post.images?.map((image) => image.isAnimated)).toEqual([false, true, true, false]);
		expect(post.images?.[0]).toEqual({
			url: "http://x.example/a.jpg",
			width: 100,
			height: 200,
			isAnimated: false,
		});
	});

	it.each([
		["http://x.example/a.gif", true],
		["http://x.example/A.GIF", true],
		["http://x.example/a.png", false],
		["http://x.example/a.jpg@1280w.webp", false],
		["http://x.example/a.webp?from=dyn", false],
	])("动图判据只看削掉 @ 后缀与 query 之后的结尾:%s → %s", (url, animated) => {
		const post = postFromDynamic(raw("DYNAMIC_TYPE_DRAW", opus({ pics: [pic(url)] })));
		expect(post.images?.[0]?.isAnimated).toBe(animated);
	});

	it("老形状图文:只有 major.draw.items(没有 opus.pics)也翻出图,宽高照带", () => {
		const post = postFromDynamic(
			raw("DYNAMIC_TYPE_DRAW", {
				major: {
					type: "MAJOR_TYPE_DRAW",
					draw: {
						items: [
							{ src: "http://x.example/d1.jpg", width: 10, height: 20 },
							{ src: "http://x.example/d2.gif", width: 30, height: 40 },
						],
					},
				},
			}),
		);
		expect(post.images).toEqual([
			{ url: "http://x.example/d1.jpg", width: 10, height: 20, isAnimated: false },
			{ url: "http://x.example/d2.gif", width: 30, height: 40, isAnimated: true },
		]);
	});

	it("两处都有:先 draw.items 后 opus.pics(与图集同序)", () => {
		const post = postFromDynamic(
			raw("DYNAMIC_TYPE_DRAW", {
				major: {
					type: "MAJOR_TYPE_DRAW",
					draw: { items: [{ src: "http://x.example/d.jpg", width: 1, height: 2 }] },
					opus: { pics: [pic("http://x.example/o.jpg")] },
				},
			}),
		);
		expect(post.images?.map((image) => image.url)).toEqual([
			"http://x.example/d.jpg",
			"http://x.example/o.jpg",
		]);
	});

	it("没有图就没有 images 这一格(不是空数组)", () => {
		expect(postFromDynamic(raw("DYNAMIC_TYPE_DRAW", opus({ pics: [] }))).images).toBeUndefined();
		expect(postFromDynamic(raw("DYNAMIC_TYPE_WORD")).images).toBeUndefined();
	});
});

describe("投稿视频", () => {
	const archive = (over: Record<string, unknown> = {}) => ({
		major: {
			type: "MAJOR_TYPE_ARCHIVE",
			archive: {
				badge: { text: "投稿视频" },
				cover: "http://x.example/cover.jpg",
				duration_text: "16:07",
				title: "标题",
				desc: "简介",
				stat: { play: "1.8万", danmaku: "129" },
				...over,
			},
		},
	});

	it("播放 / 弹幕 / 时长先成数字:「1.8万」→ 18000,「16:07」→ 967 秒", () => {
		const post = postFromDynamic(raw("DYNAMIC_TYPE_AV", archive()));
		expect(post.video).toEqual({
			cover: { url: "http://x.example/cover.jpg" },
			title: "标题",
			description: "简介",
			durationSec: 967,
			views: 18_000,
			danmaku: 129,
		});
	});

	it.each([
		["1.8万", 18_000],
		["12.3万", 123_000],
		["129", 129],
		["0", 0],
		[129, 129],
		[12_345, 12_345],
		["1万", 10_000],
		["100万", 1_000_000],
		["1.2亿", 120_000_000],
	])("播放 / 弹幕:接口给 %j → %d", (given, expected) => {
		const post = postFromDynamic(
			raw("DYNAMIC_TYPE_AV", archive({ stat: { play: given, danmaku: given } })),
		);
		expect(post.video?.views).toBe(expected);
		expect(post.video?.danmaku).toBe(expected);
	});

	it.each([
		["16:07", 967],
		["1:02:03", 3723],
		["01:02:03", 3723],
		["03:21", 201],
		["00:29", 29],
		["00:00", 0],
	])("时长:接口给 %j → %d 秒", (given, expected) => {
		expect(
			postFromDynamic(raw("DYNAMIC_TYPE_AV", archive({ duration_text: given }))).video?.durationSec,
		).toBe(expected);
	});

	it.each(["", "abc", "16", "16:60", undefined])("时长认不得 %j → 不带 durationSec", (given) => {
		const post = postFromDynamic(raw("DYNAMIC_TYPE_AV", archive({ duration_text: given })));
		expect(post.video).not.toHaveProperty("durationSec");
	});

	it.each(["", "--", "10万+", "1,234", "abc", null, undefined])(
		"播放 / 弹幕认不得 %j → 不带(不是 NaN)",
		(given) => {
			const post = postFromDynamic(
				raw("DYNAMIC_TYPE_AV", archive({ stat: { play: given, danmaku: given } })),
			);
			expect(post.video).not.toHaveProperty("views");
			expect(post.video).not.toHaveProperty("danmaku");
		},
	);

	it("认不得的那一格不带(不是 NaN、不是 0):时长 / 播放 / 弹幕各自缺各自的", () => {
		const post = postFromDynamic(
			raw("DYNAMIC_TYPE_AV", archive({ duration_text: "", stat: { play: "--", danmaku: 7 } })),
		);
		expect(post.video).not.toHaveProperty("durationSec");
		expect(post.video).not.toHaveProperty("views");
		expect(post.video?.danmaku).toBe(7);
	});

	/** 隐含耦合的显式版:从前 `badge.text === "投稿视频"` 才贴「投稿了视频」;现在它落成 `Post.label`。 */
	it("徽标是「投稿视频」→ label「投稿了视频」;别的徽标(合集 / 课程)没有 label,视频仍是 post.video", () => {
		expect(postFromDynamic(raw("DYNAMIC_TYPE_AV", archive())).label).toBe("投稿了视频");
		const other = postFromDynamic(raw("DYNAMIC_TYPE_AV", archive({ badge: { text: "合集" } })));
		expect(other.label).toBeUndefined();
		expect(other.video?.title).toBe("标题");
	});

	it("archive 缺席:没有 video,也没有 label", () => {
		const post = postFromDynamic(raw("DYNAMIC_TYPE_AV", desc(text("只有一句话"))));
		expect(post.video).toBeUndefined();
		expect(post.label).toBeUndefined();
	});
});

describe("附加块 → Attachment", () => {
	const additional = (value: unknown) =>
		postFromDynamic(raw("DYNAMIC_TYPE_WORD", { additional: value }));

	/** 验红:把预约卡 lines 的顺序颠倒,这条红(出图把 desc1 / desc2 / desc3 依次画成三行)。 */
	it("预约卡 → card:desc1 / desc2 / desc3 依次成行,按钮可用", () => {
		const post = additional({
			type: "ADDITIONAL_TYPE_RESERVE",
			reserve: {
				title: "直播预约",
				desc1: { text: "09-20 20:00" },
				desc2: { text: "2.3万人预约" },
				desc3: { text: "抽奖" },
				button: { uncheck: { text: "预约" }, check: { text: "已预约" } },
			},
		});
		expect(post.attachment).toEqual({
			kind: "card",
			title: "直播预约",
			lines: [{ text: "09-20 20:00" }, { text: "2.3万人预约" }, { text: "抽奖" }],
			button: { text: "预约", enabled: true },
		});
	});

	it("预约卡:按钮写着「已结束」→ 不可用;没有 desc3 就两行;没有按钮就没有 button", () => {
		const ended = additional({
			type: "ADDITIONAL_TYPE_RESERVE",
			reserve: {
				title: "t",
				desc1: { text: "a" },
				desc2: { text: "b" },
				button: { uncheck: { text: "已结束" } },
			},
		}).attachment;
		expect(ended).toEqual({
			kind: "card",
			title: "t",
			lines: [{ text: "a" }, { text: "b" }],
			button: { text: "已结束", enabled: false },
		});
		const noButton = additional({
			type: "ADDITIONAL_TYPE_RESERVE",
			reserve: { title: "t", desc1: { text: "a" }, desc2: { text: "b" } },
		}).attachment;
		expect(noButton).not.toHaveProperty("button");
	});

	it("通用卡 → card:头部说明、封面、标题、有字的 desc 成行、按钮;不带「游戏」标签", () => {
		const post = additional({
			type: "ADDITIONAL_TYPE_COMMON",
			common: {
				sub_type: "game",
				head_text: "相关游戏",
				cover: "http://x.example/c.png",
				title: "游戏名",
				desc1: "",
				desc2: "已有 12.8万 人预约",
				button: { jump_style: { text: "去下载" } },
			},
		});
		expect(post.attachment).toEqual({
			kind: "card",
			eyebrow: "相关游戏",
			cover: { url: "http://x.example/c.png" },
			title: "游戏名",
			lines: [{ text: "已有 12.8万 人预约" }],
			button: { text: "去下载", enabled: true },
		});
	});

	it("通用卡:head_text 为空串不带 eyebrow;没有按钮文字就没有 button", () => {
		const attachment = additional({
			type: "ADDITIONAL_TYPE_COMMON",
			common: { sub_type: "x", head_text: "", cover: "c", title: "t", desc1: "d" },
		}).attachment;
		expect(attachment).not.toHaveProperty("eyebrow");
		expect(attachment).not.toHaveProperty("button");
	});

	it("商品 → goods:head_text 进 eyebrow,每件带封面 / 名字 / 价格;按钮与「起」不带", () => {
		const post = additional({
			type: "ADDITIONAL_TYPE_GOODS",
			goods: {
				head_text: "UP 主推荐",
				items: [
					{ cover: "http://x.example/1.jpg", name: "甲", price: "￥68", jump_desc: "立即购买" },
					{ cover: "http://x.example/2.jpg", name: "乙" },
				],
			},
		});
		expect(post.attachment).toEqual({
			kind: "goods",
			eyebrow: "UP 主推荐",
			items: [
				{ cover: { url: "http://x.example/1.jpg" }, name: "甲", price: "￥68" },
				{ cover: { url: "http://x.example/2.jpg" }, name: "乙" },
			],
		});
	});

	it("引用视频 → video:时长成秒,desc_second 原样进 subtitle,head_text 不带", () => {
		const post = additional({
			type: "ADDITIONAL_TYPE_UGC",
			ugc: {
				head_text: "相关视频",
				title: "关联视频",
				cover: "http://x.example/u.jpg",
				duration: "00:29",
				desc_second: "2654观看 102弹幕",
			},
		});
		expect(post.attachment).toEqual({
			kind: "video",
			cover: { url: "http://x.example/u.jpg" },
			title: "关联视频",
			durationSec: 29,
			subtitle: "2654观看 102弹幕",
		});
	});

	it("引用视频缺 duration / desc_second 或时长认不得:不带 durationSec / subtitle,不出 undefined", () => {
		for (const duration of [undefined, "", "16:60", "abc"]) {
			const attachment = additional({
				type: "ADDITIONAL_TYPE_UGC",
				ugc: { title: "t", cover: "c", duration, desc_second: undefined },
			}).attachment;
			expect(attachment).toEqual({ kind: "video", cover: { url: "c" }, title: "t" });
		}
	});

	it("不认识的类型、type 说是 UGC 却没有 ugc、没有 additional:都没有 attachment", () => {
		expect(additional({ type: "ADDITIONAL_TYPE_SOMETHING" }).attachment).toBeUndefined();
		expect(additional({ type: "ADDITIONAL_TYPE_UGC", ugc: null }).attachment).toBeUndefined();
		expect(additional(undefined).attachment).toBeUndefined();
	});
});

describe("充电专属 → locked", () => {
	const lockedRaw = (type: string, badge?: Record<string, unknown>) =>
		raw(type, {}, { basic: { is_only_fans: true } }, badge ? { icon_badge: badge } : {});

	it("接口带徽标:icon / title 取徽标,hint 用作者名拼好", () => {
		const post = postFromDynamic(
			lockedRaw("DYNAMIC_TYPE_DRAW", { text: "充电专属", icon: "http://x/b.png" }),
		);
		expect(post.locked).toEqual({
			icon: { url: "http://x/b.png" },
			title: "充电专属",
			hint: "为 示例UP 充电即可查看完整内容",
		});
	});

	it("没有徽标:标题兜底「充电专属内容」,没有 icon", () => {
		const post = postFromDynamic(lockedRaw("DYNAMIC_TYPE_AV"));
		expect(post.locked).toEqual({ title: "充电专属内容", hint: "为 示例UP 充电即可查看完整内容" });
	});

	it("不管外层是什么类型都短路,没有正文、视频、图集、label", () => {
		for (const type of ["DYNAMIC_TYPE_AV", "DYNAMIC_TYPE_ARTICLE", "DYNAMIC_TYPE_FORWARD"]) {
			const post = postFromDynamic(lockedRaw(type));
			expect(post.locked).toBeDefined();
			expect(post.text).toBe("");
			expect(post.video).toBeUndefined();
			expect(post.label).toBeUndefined();
			expect(post.article).toBeUndefined();
		}
	});

	it("已充电用户拉到的同一条(is_only_fans 为真但内容齐全)不算锁住", () => {
		const post = postFromDynamic(
			raw("DYNAMIC_TYPE_WORD", desc(text("内容齐全")), { basic: { is_only_fans: true } }),
		);
		expect(post.locked).toBeUndefined();
		expect(post.text).toBe("内容齐全");
	});

	it("被转发的原动态是锁住的:内层带 locked,外层照常", () => {
		const post = postFromDynamic(
			raw("DYNAMIC_TYPE_FORWARD", desc(text("转发语")), { orig: lockedRaw("DYNAMIC_TYPE_DRAW") }),
		);
		expect(post.repost?.locked?.title).toBe("充电专属内容");
		expect(post.text).toBe("转发语");
	});
});

/** 剧集 / 课程 / 合集动态的 major 块:字段写全(含不读的角标、跳转、编号),让夹具像真的。 */
const badge = { bg_color: "#FB7299", color: "#FFFFFF", text: "会员专享" };
const seriesMajor = (over: Record<string, unknown> = {}) => ({
	major: {
		type: "MAJOR_TYPE_PGC",
		pgc: {
			badge,
			cover: "http://x.example/pgc.jpg",
			epid: 1001,
			jump_url: "//www.bilibili.com/bangumi/play/ep1001",
			season_id: 2002,
			stat: { danmaku: "1.2万", play: "34.5万" },
			sub_type: 1,
			title: "第3话 夜幕",
			type: 2,
			...over,
		},
	},
});
const courseMajor = (over: Record<string, unknown> = {}) => ({
	major: {
		type: "MAJOR_TYPE_COURSES",
		courses: {
			badge,
			cover: "http://x.example/course.jpg",
			desc: "更新至第10期",
			id: 3003,
			jump_url: "//www.bilibili.com/cheese/play/ss3003",
			sub_title: "共10节",
			title: "从零学画画",
			...over,
		},
	},
});
const collectionMajor = (over: Record<string, unknown> = {}) => ({
	major: {
		type: "MAJOR_TYPE_UGC_SEASON",
		ugc_season: {
			aid: 4004,
			badge,
			cover: "http://x.example/season.jpg",
			desc: "视频简介",
			disable_preview: 0,
			duration_text: "05:20",
			jump_url: "//www.bilibili.com/video/BV1xx",
			stat: { danmaku: "1.2万", play: "34.5万" },
			title: "第一集 开始",
			...over,
		},
	},
});

describe("剧集 / 课程 / 合集 → 附件的视频卡", () => {
	it("剧集:label「发布了剧集」,封面 + 分集标题 + 播放弹幕句进视频卡,没有 durationSec", () => {
		const post = postFromDynamic(
			raw("DYNAMIC_TYPE_PGC", seriesMajor(), {}, { type: "AUTHOR_TYPE_PGC", name: "某番剧" }),
		);
		expect(post).toEqual({
			creator: { name: "某番剧", isPremium: false },
			publishedAt: "2023-11-14T22:13:20.000Z",
			text: "",
			label: "发布了剧集",
			stats: { shares: 1, comments: 2, likes: 3 },
			attachment: {
				kind: "video",
				cover: { url: "http://x.example/pgc.jpg" },
				title: "第3话 夜幕",
				subtitle: "34.5万观看 1.2万弹幕",
			},
		});
	});

	it("课程:label「发布了课程」,desc(更新状态)进 subtitle,没有 durationSec,不读 sub_title", () => {
		const post = postFromDynamic(raw("DYNAMIC_TYPE_COURSES_SEASON", courseMajor()));
		expect(post).toEqual({
			creator: { name: "示例UP", isPremium: false },
			publishedAt: "2023-11-14T22:13:20.000Z",
			text: "",
			label: "发布了课程",
			stats: { shares: 1, comments: 2, likes: 3 },
			attachment: {
				kind: "video",
				cover: { url: "http://x.example/course.jpg" },
				title: "从零学画画",
				subtitle: "更新至第10期",
			},
		});
	});

	it("合集:label「更新了合集」,duration_text 成秒,UP 写的字进正文,不读 desc(视频简介)", () => {
		const post = postFromDynamic(
			raw(
				"DYNAMIC_TYPE_UGC_SEASON",
				{ ...desc(text("更新啦")), ...collectionMajor() },
				{},
				{ type: "AUTHOR_TYPE_UGC_SEASON", name: "某合集" },
			),
		);
		expect(post).toEqual({
			creator: { name: "某合集", isPremium: false },
			publishedAt: "2023-11-14T22:13:20.000Z",
			text: "更新啦",
			richText: [{ kind: "text", text: "更新啦" }],
			label: "更新了合集",
			stats: { shares: 1, comments: 2, likes: 3 },
			attachment: {
				kind: "video",
				cover: { url: "http://x.example/season.jpg" },
				title: "第一集 开始",
				durationSec: 320,
				subtitle: "34.5万观看 1.2万弹幕",
			},
		});
	});

	it("边角:播放 / 弹幕缺一个、空串、不是字符串 → 没有 subtitle 键;课程 desc 空、合集时长认不出 → 同样不出 undefined", () => {
		const videoOf = (
			type: string,
			majorOf: (over: Record<string, unknown>) => unknown,
			over: object,
		) =>
			postFromDynamic(
				raw(type, majorOf(over as Record<string, unknown>) as Record<string, unknown>),
			).attachment;
		for (const stat of [
			{ play: "34.5万" },
			{ danmaku: "1.2万" },
			{ play: "", danmaku: "1.2万" },
			{ play: "34.5万", danmaku: "" },
			{ play: 345000, danmaku: "1.2万" },
			{ play: "34.5万", danmaku: null },
		]) {
			expect(videoOf("DYNAMIC_TYPE_PGC", seriesMajor, { stat })).toEqual({
				kind: "video",
				cover: { url: "http://x.example/pgc.jpg" },
				title: "第3话 夜幕",
			});
			expect(
				videoOf("DYNAMIC_TYPE_UGC_SEASON", collectionMajor, { stat, duration_text: undefined }),
			).toEqual({
				kind: "video",
				cover: { url: "http://x.example/season.jpg" },
				title: "第一集 开始",
			});
		}
		for (const duration_text of ["", "16:60", "abc"]) {
			expect(videoOf("DYNAMIC_TYPE_UGC_SEASON", collectionMajor, { duration_text })).toEqual({
				kind: "video",
				cover: { url: "http://x.example/season.jpg" },
				title: "第一集 开始",
				subtitle: "34.5万观看 1.2万弹幕",
			});
		}
		for (const desc of ["", undefined, 10]) {
			expect(videoOf("DYNAMIC_TYPE_COURSES_SEASON", courseMajor, { desc })).toEqual({
				kind: "video",
				cover: { url: "http://x.example/course.jpg" },
				title: "从零学画画",
			});
		}
	});

	it("major 块缺席(没有 / 不是对象):退回今天那句 notice,没有正文也没有附加块", () => {
		const cases: [string, Record<string, unknown>, string][] = [
			[
				"DYNAMIC_TYPE_PGC",
				{},
				"示例UP发布了剧集（番剧、电影、纪录片），我暂时无法渲染，请自行查看",
			],
			[
				"DYNAMIC_TYPE_PGC",
				{ major: { type: "MAJOR_TYPE_PGC", pgc: null } },
				"示例UP发布了剧集（番剧、电影、纪录片），我暂时无法渲染，请自行查看",
			],
			["DYNAMIC_TYPE_COURSES_SEASON", {}, "示例UP发布了新课程，我暂时无法渲染，请自行查看"],
			[
				"DYNAMIC_TYPE_UGC_SEASON",
				{ major: { type: "MAJOR_TYPE_UGC_SEASON" } },
				"示例UP更新了合集，我暂时无法渲染，请自行查看",
			],
		];
		for (const [type, moduleDynamic, sentence] of cases) {
			const post = postFromDynamic(
				raw(type, {
					...moduleDynamic,
					additional: {
						type: "ADDITIONAL_TYPE_COMMON",
						common: { head_text: "x", cover: "c", title: "t", desc1: "d" },
					},
				}),
			);
			expect(post.notice).toBe(sentence);
			expect(post.text).toBe("");
			expect(post.label).toBeUndefined();
			expect(post.attachment).toBeUndefined();
		}
	});

	it("被转发的原动态是剧集:内层 repost 带 label 与视频卡", () => {
		const post = postFromDynamic(
			raw("DYNAMIC_TYPE_FORWARD", desc(text("转发语")), {
				orig: raw("DYNAMIC_TYPE_PGC", seriesMajor(), {}, { name: "某番剧" }),
			}),
		);
		expect(post.text).toBe("转发语");
		expect(post.repost?.label).toBe("发布了剧集");
		expect(post.repost?.attachment).toEqual({
			kind: "video",
			cover: { url: "http://x.example/pgc.jpg" },
			title: "第3话 夜幕",
			subtitle: "34.5万观看 1.2万弹幕",
		});
		expect(post.attachment).toBeUndefined();
	});

	it("同时带附加块(预约卡):视频卡覆盖它", () => {
		const reserve = {
			additional: {
				type: "ADDITIONAL_TYPE_RESERVE",
				reserve: { title: "直播预约", desc1: { text: "09-20 20:00" } },
			},
		};
		for (const [type, major] of [
			["DYNAMIC_TYPE_PGC", seriesMajor()],
			["DYNAMIC_TYPE_COURSES_SEASON", courseMajor()],
			["DYNAMIC_TYPE_UGC_SEASON", collectionMajor()],
		] as const) {
			expect(postFromDynamic(raw(type, { ...major, ...reserve })).attachment?.kind).toBe("video");
		}
	});
});

describe("「暂时无法渲染」与「原动态不可见」→ notice", () => {
	it.each([
		["DYNAMIC_TYPE_LIVE", "示例UP发起了直播预约，我暂时无法渲染，请自行查看"],
		["DYNAMIC_TYPE_MEDIALIST", "示例UP分享了收藏夹，我暂时无法渲染，请自行查看"],
		["DYNAMIC_TYPE_MUSIC", "示例UP发行了新歌，我暂时无法渲染，请自行查看"],
		[
			"DYNAMIC_TYPE_COMMON_SQUARE",
			"示例UP发布了装扮｜剧集｜点评｜普通分享，我暂时无法渲染，请自行查看",
		],
		["DYNAMIC_TYPE_NONE", "示例UP发布了一条无效动态"],
		["DYNAMIC_TYPE_SOMETHING_NEW", "示例UP发布了一条我无法识别的动态，请自行查看"],
	])("%s → notice,没有正文也没有附加块", (type, sentence) => {
		const post = postFromDynamic(
			raw(type, {
				additional: {
					type: "ADDITIONAL_TYPE_COMMON",
					common: { head_text: "x", cover: "c", title: "t", desc1: "d" },
				},
			}),
		);
		expect(post.notice).toBe(sentence);
		expect(post.text).toBe("");
		expect(post.attachment).toBeUndefined();
	});

	it("转发但原动态不可见:转发语照样是正文,notice 说明", () => {
		const post = postFromDynamic(raw("DYNAMIC_TYPE_FORWARD", desc(text("转发语"))));
		expect(post.text).toBe("转发语");
		expect(post.notice).toBe("示例UP转发了一条动态，但原动态已不可见");
		expect(post.repost).toBeUndefined();
	});
});

describe("残条(接口缺整段)不抛", () => {
	/** 动态轮询现在先翻译再过滤(㉑e):翻译抛了就是整条动态没法判,所以残条必须翻得过去。验红:去掉 `?? {}`,这几条红。 */
	it("被转发的原动态是 tombstone(modules 整段缺席):转发照常翻,原作品退成一句提示", () => {
		const orig = { id_str: "9", type: "DYNAMIC_TYPE_NONE", basic: {} } as unknown as Dynamic;
		const post = postFromDynamic(raw("DYNAMIC_TYPE_FORWARD", desc(text("转发语")), { orig }));
		expect(post.text).toBe("转发语");
		expect(post.repost?.notice).toBe("发布了一条无效动态");
		expect(post.repost?.creator.name).toBe("");
	});

	it("顶层只有作者段、缺 module_dynamic:翻成一条空正文的作品", () => {
		const item = raw("DYNAMIC_TYPE_WORD");
		delete (item.modules as unknown as Record<string, unknown>).module_dynamic;
		const post = postFromDynamic(item);
		expect(post.text).toBe("");
		expect(post.creator.name).toBe("示例UP");
	});
});

describe("转发与互动数", () => {
	/** 验红:让翻译丢掉 repost,这条红。 */
	it("转发 → repost(整条翻译,内层不带互动数、带自己的 label)", () => {
		const orig = raw("DYNAMIC_TYPE_AV", {
			major: { archive: { badge: { text: "投稿视频" }, cover: "c", title: "视频", stat: {} } },
		});
		const post = postFromDynamic(raw("DYNAMIC_TYPE_FORWARD", desc(text("转发语")), { orig }));
		expect(post.repost?.video?.title).toBe("视频");
		expect(post.repost?.label).toBe("投稿了视频");
		expect(post.repost?.stats).toBeUndefined();
		expect(post.stats).toEqual({ shares: 1, comments: 2, likes: 3 });
	});

	it("转发本身带图也不丢", () => {
		const post = postFromDynamic(
			raw(
				"DYNAMIC_TYPE_FORWARD",
				opus({ pics: [{ url: "http://x/a.jpg", width: 1, height: 1 }] }),
				{
					orig: raw("DYNAMIC_TYPE_WORD"),
				},
			),
		);
		expect(post.images).toHaveLength(1);
	});

	it("互动数:转发 / 评论 / 点赞 → shares / comments / likes;缺 module_stat 就没有 stats", () => {
		expect(postFromDynamic(raw("DYNAMIC_TYPE_WORD")).stats).toEqual({
			shares: 1,
			comments: 2,
			likes: 3,
		});
		const bare = raw("DYNAMIC_TYPE_WORD");
		delete (bare.modules as unknown as Record<string, unknown>).module_stat;
		expect(postFromDynamic(bare).stats).toBeUndefined();
	});
});

describe("宽容:接口缺什么就少什么,不抛", () => {
	it("最小的一条(只有作者名)也翻得出来", () => {
		const minimal = {
			basic: {},
			id_str: "1",
			type: "DYNAMIC_TYPE_WORD",
			modules: { module_author: { name: "甲" }, module_dynamic: {} },
		} as unknown as Dynamic;
		const post = postFromDynamic(minimal);
		expect(post.creator.name).toBe("甲");
		expect(post.text).toBe("");
	});
});

describe("emojiUrlsOf:表情文字 → 图片地址(出卡前抓表情图用)", () => {
	const emojiNode = (code: string, iconUrl: unknown) => ({
		...node("RICH_TEXT_NODE_TYPE_EMOJI", code),
		emoji: { icon_url: iconUrl, size: 1, text: code, type: 1 },
	});

	it("外层正文里的表情收成「文字 → 地址」", () => {
		const item = raw(
			"DYNAMIC_TYPE_WORD",
			desc(text("看"), emojiNode("[doge]", "https://i0.hdslb.com/bfs/emote/doge.png")),
		);

		const urls = emojiUrlsOf(item);

		expect(urls.size).toBe(1);
		expect(urls.get("[doge]")).toBe("https://i0.hdslb.com/bfs/emote/doge.png");
	});

	it("被转发的原动态(含再往里一层)里的表情也收", () => {
		const inner = raw(
			"DYNAMIC_TYPE_WORD",
			desc(emojiNode("[inner]", "https://i0.hdslb.com/bfs/emote/inner.png")),
		);
		const middle = raw(
			"DYNAMIC_TYPE_FORWARD",
			desc(emojiNode("[middle]", "https://i0.hdslb.com/bfs/emote/middle.png")),
			{ orig: inner },
		);
		const item = raw(
			"DYNAMIC_TYPE_FORWARD",
			desc(emojiNode("[outer]", "https://i0.hdslb.com/bfs/emote/outer.png")),
			{ orig: middle },
		);

		expect([...emojiUrlsOf(item)]).toEqual([
			["[outer]", "https://i0.hdslb.com/bfs/emote/outer.png"],
			["[middle]", "https://i0.hdslb.com/bfs/emote/middle.png"],
			["[inner]", "https://i0.hdslb.com/bfs/emote/inner.png"],
		]);
	});

	it("地址不是字符串、是空串、没有 emoji 对象的节点都不收", () => {
		const item = raw(
			"DYNAMIC_TYPE_WORD",
			desc(
				emojiNode("[good]", "https://i0.hdslb.com/bfs/emote/good.png"),
				emojiNode("[empty]", ""),
				emojiNode("[num]", 42),
				emojiNode("[missing]", undefined),
				{ ...node("RICH_TEXT_NODE_TYPE_EMOJI", "[nobody]"), emoji: null },
				text("文字"),
			),
		);

		expect([...emojiUrlsOf(item).keys()]).toEqual(["[good]"]);
	});

	it("键与翻译出的表情片段的 text 逐字相同:专栏摘要、desc 与摘要并存、转发内层都对得上", () => {
		const item = raw(
			"DYNAMIC_TYPE_FORWARD",
			desc(emojiNode("[a]", "https://i0.hdslb.com/bfs/emote/a.png")),
			{
				orig: raw("DYNAMIC_TYPE_ARTICLE", {
					...desc(emojiNode("[b]", "https://i0.hdslb.com/bfs/emote/b.png")),
					...opus({ summary: [emojiNode("[c]", "https://i0.hdslb.com/bfs/emote/c.png")] }),
				}),
			},
		);
		const post = postFromDynamic(item);
		const emojiTexts = [...(post.richText ?? []), ...(post.repost?.richText ?? [])]
			.filter((segment) => segment.kind === "emoji")
			.map((segment) => segment.text);

		expect(emojiTexts).toEqual(["[a]", "[b]", "[c]"]);
		expect([...emojiUrlsOf(item).keys()]).toEqual(emojiTexts);
	});
});

it("recognizes platform badge and reservation status words independently of the output language", () => {
	const state = i18n.state();
	i18n.set({ locale: "en", voice: "plain" });
	const spy = vi.spyOn(i18n.state(), "t").mockReturnValue("Translated label");
	try {
		const video = postFromDynamic(
			raw("DYNAMIC_TYPE_AV", {
				major: {
					type: "MAJOR_TYPE_ARCHIVE",
					archive: {
						badge: { text: "投稿视频" },
						title: "Source title",
						cover: "",
						desc: "",
						stat: {},
					},
				},
			}),
		);
		expect(video.label).toBe("Translated label");
		const reserve = postFromDynamic(
			raw("DYNAMIC_TYPE_WORD", {
				additional: {
					type: "ADDITIONAL_TYPE_RESERVE",
					reserve: {
						title: "Source title",
						desc1: { text: "a" },
						desc2: { text: "b" },
						button: { uncheck: { text: "已结束" } },
					},
				},
			}),
		);
		expect(reserve.attachment).toMatchObject({ button: { text: "已结束", enabled: false } });
	} finally {
		spy.mockRestore();
		i18n.set({ locale: state.locale, voice: state.voice });
	}
});
