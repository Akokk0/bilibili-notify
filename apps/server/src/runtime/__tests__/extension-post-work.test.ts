/**
 * 拓展报的作品 → 平台中立的作品(ADR-0019 决策 55 / 66 / 69 / 71 / 72 / 77)。
 *
 * 装配(`deliverWork`)只认 `NeutralWork` 那几格;卡片只认 `DynamicNode`。这里钉的是「拓展交的那张表」
 * 翻过去之后每一格从哪来:套进 B 站哪种动态类型、发布时间与动作后缀照 B 站卡的写法、只铺前 9 张图、
 * 宽高 BN 自己读、视频与互动数排成 B 站的样子、AI 看的正文与图、模板里的名字与叫法。
 *
 * node 从 `renderCard` 递给渲染器的那一刻截下来 —— 那就是它交出去的样子。
 */

import {
	BLOCKED_IMG_PLACEHOLDER,
	type DynamicNode,
	type ImageRenderer,
} from "@bilibili-notify/image";
import type { SubscriptionReportValue } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import {
	extensionPostFilterText,
	extensionPostWork,
	POST_COMMENT_IMAGE_MAX_BYTES,
} from "../extension-post-work.js";

type Post = SubscriptionReportValue<"post">;

const AUTHOR = { name: "作者甲", avatarUrl: "data:image/png;base64,QVZBVEFS" };

/** 本机时区的 2026-09-24 12:00:05 —— 卡上印出来就是这一刻,与跑测试的时区无关。 */
const PUBLISHED = new Date(2026, 8, 24, 12, 0, 5).getTime();
const TIME = "2026年09月24日 12:00:05";

const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];

/** 一张宽高真写在文件头里的 png;`tag` 塞进尾巴,好让每张的字节(也就是 data URL)各不相同。 */
function png(width: number, height: number, tag = 0, padTo = 0): Uint8Array {
	const head = [
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		...u32be(13),
		...Buffer.from("IHDR"),
		...u32be(width),
		...u32be(height),
		8,
		6,
		0,
		0,
		0,
		tag,
	];
	const bytes = new Uint8Array(Math.max(head.length, padTo));
	bytes.set(head);
	return bytes;
}

function gif(width: number, height: number): Uint8Array {
	return new Uint8Array([...Buffer.from("GIF89a"), ...u16le(width), ...u16le(height), 0, 0, 0]);
}

const dataUrl = (mime: string, bytes: Uint8Array) =>
	`data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

function post(over: Partial<Post> = {}): Post {
	return {
		id: "p1",
		url: "https://www.douyin.com/video/p1",
		publishedAt: PUBLISHED,
		...over,
	};
}

/** 出一次卡,截下交给渲染器的 node 与样式。 */
async function render(
	p: Post,
	colors: Parameters<ImageRenderer["generateNeutralDynamicCard"]>[1] = {},
): Promise<{ node: DynamicNode; colors: unknown }> {
	const seen: { node?: DynamicNode; colors?: unknown } = {};
	const image = {
		generateNeutralDynamicCard: async (node: DynamicNode, c: unknown) => {
			seen.node = node;
			seen.colors = c;
			return Buffer.from("card");
		},
	} as unknown as ImageRenderer;
	const card = await extensionPostWork(p, { author: AUTHOR }).renderCard(image, colors ?? {});
	expect(card.toString()).toBe("card");
	if (!seen.node) throw new Error("renderCard 没把 node 交给渲染器");
	return { node: seen.node, colors: seen.colors };
}

describe("套进 B 站的动态类型(决策 69),动作写法照 B 站同一种类型", () => {
	it("只有正文:图文字动态(WORD),发布时间照 B 站卡的写法、没有动作后缀", async () => {
		const { node } = await render(post({ text: "第一行\n第二行" }));
		expect(node.type).toBe("DYNAMIC_TYPE_WORD");
		expect(node.pubTime).toBe(TIME);
		expect(node.headerLabel).toBeUndefined();
		expect(node.text).toBeTruthy();
		expect(node.video ?? undefined).toBeUndefined();
	});

	it("有图、没有视频:图文动态(DRAW),同样没有动作后缀", async () => {
		const { node } = await render(post({ images: [png(10, 10)] }));
		expect(node.type).toBe("DYNAMIC_TYPE_DRAW");
		expect(node.pubTime).toBe(TIME);
	});

	it("带视频(图也带也算):视频动态(AV),发布时间后面接「· 投稿了视频」", async () => {
		const { node } = await render(
			post({ video: { title: "一期视频" }, images: [png(10, 10)], text: "看视频" }),
		);
		expect(node.type).toBe("DYNAMIC_TYPE_AV");
		expect(node.pubTime).toBe(`${TIME} · 投稿了视频`);
		expect(node.headerLabel).toBeUndefined();
	});

	it("一个字都没有:正文那一格为空(卡上正文块收起)", async () => {
		const { node } = await render(post({ text: "  \n " }));
		expect(node.text ?? null).toBeNull();
	});
});

describe("话题(决策 55 的 09-24 🔗)", () => {
	it("第一个话题进正文上方那一行标签(B 站卡的 node.topic),其余不进", async () => {
		const { node } = await render(
			post({ text: "走了一天 #城市散步", topics: ["城市散步", "vlog"] }),
		);
		expect(node.topic).toBe("城市散步");
	});

	it("没报话题就没有标签(那一行收起)", async () => {
		expect((await render(post({ text: "只有字 #看着像话题" }))).node.topic).toBeUndefined();
		expect((await render(post({ text: "只有字", topics: [] }))).node.topic).toBeUndefined();
	});
});

describe("卡上的作者、样式", () => {
	it("作者的名字与头像原样上卡(取法见 extension-push-common),不是大会员色", async () => {
		const { node } = await render(post());
		expect(node).toMatchObject({ upName: "作者甲", avatarUrl: AUTHOR.avatarUrl, upIsVip: false });
	});

	it("装配给的样式与皮肤原样交给渲染器", async () => {
		const { colors } = await render(post(), { cardSkin: "my-skin", font: "某字体" });
		expect(colors).toEqual({ cardSkin: "my-skin", font: "某字体" });
	});
});

describe("图廊:只铺前 9 张,宽高 BN 读文件头(决策 55 / 77)", () => {
	it("前 9 张转成 data URL,带宽高;gif 标动图;第 10 张起只计数(图廊折进 +N)", async () => {
		const images = [
			png(100, 300, 0),
			gif(40, 30),
			...Array.from({ length: 10 }, (_, i) => png(64, 64, i + 1)),
		];
		const { node } = await render(post({ images }));
		expect(node.images).toHaveLength(12);
		expect(node.images?.[0]).toEqual({
			url: dataUrl("image/png", images[0] as Uint8Array),
			width: 100,
			height: 300,
			animated: false,
		});
		expect(node.images?.[1]).toEqual({
			url: dataUrl("image/gif", images[1] as Uint8Array),
			width: 40,
			height: 30,
			animated: true,
		});
		expect(node.images?.[8]?.url).toBe(dataUrl("image/png", images[8] as Uint8Array));
		// 第 10 张起不转(不画的图白编一遍 base64),只占着张数。
		for (const rest of node.images?.slice(9) ?? []) expect(rest).toEqual({ url: "" });
	});

	it("宽高读不出来就不带(出卡照样出,只是不判长图)", async () => {
		const broken = png(10, 10).slice(0, 20);
		// 截断的 png 仍认得出是 png(魔数还在),data URL 照转。
		const { node } = await render(post({ images: [broken] }));
		expect(node.images?.[0]).toEqual({ url: dataUrl("image/png", broken), animated: false });
	});

	it("没有图就没有图廊", async () => {
		const { node } = await render(post({ text: "只有字" }));
		expect(node.images ?? []).toEqual([]);
	});
});

describe("视频那一格照 B 站排(决策 55)", () => {
	it("封面转 data URL,时长排成 m:ss / h:mm:ss,播放数排成「1.2万」,简介原样", async () => {
		const cover = png(16, 9);
		const { node } = await render(
			post({
				video: { cover, title: "一期视频", duration: 123, description: "简介", plays: 12_345 },
			}),
		);
		expect(node.video).toEqual({
			cover: dataUrl("image/png", cover),
			title: "一期视频",
			duration: "2:03",
			desc: "简介",
			views: "1.2万",
		});
		const long = await render(post({ video: { duration: 3725.6 } }));
		expect(long.node.video?.duration).toBe("1:02:05");
	});

	it("没报的格空着:没有播放数就不带(卡上那一项不画),没有封面给透明占位,没有时长不画角标", async () => {
		const { node } = await render(post({ video: { title: "只有标题" } }));
		expect(node.video).toEqual({
			cover: BLOCKED_IMG_PLACEHOLDER,
			title: "只有标题",
			duration: "",
			desc: "",
		});
	});
});

describe("互动数照 B 站卡的排版(决策 55:交数字,BN 排版)", () => {
	it("赞 / 评论 / 转发排成「1.2万」一类;没报的那一项空着(卡上那一项不画)", async () => {
		const { node } = await render(post({ stats: { likes: 12_345, comments: 45 } }));
		expect(node.stats).toEqual({ like: "1.2万", comment: "45", forward: "" });
	});

	it("整格没报就没有互动数(那一排收起)", async () => {
		const { node } = await render(post());
		expect(node.stats).toBeUndefined();
	});
});

describe("装配要的那几格", () => {
	it("链接是事件的 url;名字取作者名;没有图集(决策 72);叫法缺省「动态」,给了照用", () => {
		const work = extensionPostWork(post(), { author: AUTHOR });
		expect(work).toMatchObject({
			link: "https://www.douyin.com/video/p1",
			name: "作者甲",
			isVideo: false,
			postNoun: "动态",
			gallery: [],
		});
		expect(extensionPostWork(post(), { author: AUTHOR, postNoun: "作品" }).postNoun).toBe("作品");
		expect(extensionPostWork(post({ video: {} }), { author: AUTHOR }).isVideo).toBe(true);
	});

	it("AI 的正文 = 作品正文 +「视频标题：…」;拼不出字就是空串(不点评)", () => {
		const text = (p: Post) => extensionPostWork(p, { author: AUTHOR }).commentText;
		expect(text(post({ text: "今天发新歌", video: { title: "新歌 MV" } }))).toBe(
			"今天发新歌\n视频标题：新歌 MV",
		);
		expect(text(post({ text: "只有正文" }))).toBe("只有正文");
		expect(text(post({ video: { title: "只有标题" } }))).toBe("视频标题：只有标题");
		expect(text(post({ text: "   " }))).toBe("");
	});

	it("AI 的图 = 作品图 + 视频封面,前 4 张;单张太大就跳过,让后面的顶上", () => {
		const small = [1, 2, 3].map((i) => png(8, 8, i));
		const huge = png(8, 8, 9, POST_COMMENT_IMAGE_MAX_BYTES + 1);
		const cover = png(8, 8, 7);
		const work = extensionPostWork(
			post({ images: [small[0], huge, small[1], small[2]] as Uint8Array[], video: { cover } }),
			{ author: AUTHOR },
		);
		expect(work.commentImages).toEqual([
			...small.map((b) => dataUrl("image/png", b)),
			dataUrl("image/png", cover),
		]);
		const many = extensionPostWork(
			post({ images: Array.from({ length: 6 }, (_, i) => png(8, 8, i)) }),
			{ author: AUTHOR },
		);
		expect(many.commentImages).toHaveLength(4);
	});
});

describe("过滤看的文字(决策 70)", () => {
	it("作品正文 + 视频标题;都没有是空串", () => {
		expect(extensionPostFilterText(post({ text: "正文", video: { title: "标题" } }))).toBe(
			"正文\n标题",
		);
		expect(extensionPostFilterText(post({ video: { title: "标题" } }))).toBe("标题");
		expect(extensionPostFilterText(post())).toBe("");
	});
});
