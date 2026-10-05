import { describe, expect, it } from "vite-plus/test";
import { normalizePost, type Post, postText } from "../post";

const creator = { name: "阿梓" };

function post(over: Partial<Post> = {}): Post {
	return { creator, publishedAt: "2026-10-05T08:00:00.000Z", text: "", ...over };
}

describe("postText —— 作品文字只有一种拼法(ADR-0028 决策 1)", () => {
	it("plain:正文、文章标题、视频标题各占一行,没有前缀", () => {
		const p = post({
			text: "今天也要加油",
			article: { title: "十月随笔" },
			video: {
				cover: { url: "https://example.com/c.jpg" },
				title: "新歌 MV",
				description: "",
				durationSec: 200,
			},
		});
		expect(postText(p, "plain")).toBe("今天也要加油\n十月随笔\n新歌 MV");
	});

	it("plain:被转发的原作品接在后面,同样三段;空段不占行", () => {
		const p = post({
			text: "转一下",
			repost: post({
				creator: { name: "小明" },
				text: "",
				article: { title: "原文标题" },
				video: { cover: {}, title: "原视频", description: "", durationSec: 1 },
			}),
		});
		expect(postText(p, "plain")).toBe("转一下\n原文标题\n原视频");
	});

	it("plain:只有空白的段不算有字;什么都没有是空串", () => {
		expect(postText(post({ text: "  \n " }), "plain")).toBe("");
		expect(postText(post({ text: " ", article: { title: "标题" } }), "plain")).toBe("标题");
	});

	it("labeled:标题带「标题：」、视频标题带「视频标题：」,正文不带前缀", () => {
		const p = post({
			text: "摘要正文",
			article: { title: "十月随笔" },
			video: { cover: {}, title: "新歌 MV", description: "", durationSec: 200 },
		});
		expect(postText(p, "labeled")).toBe("标题：十月随笔\n摘要正文\n视频标题：新歌 MV");
	});

	it("labeled:转发写成一行「（转发自 X：…）」,括号里用空格连", () => {
		const p = post({
			text: "转一下",
			repost: post({
				creator: { name: "小明" },
				text: "原正文",
				article: { title: "原标题" },
				video: { cover: {}, title: "原视频", description: "", durationSec: 1 },
			}),
		});
		expect(postText(p, "labeled")).toBe(
			"转一下\n（转发自 小明：标题：原标题 原正文 视频标题：原视频）",
		);
	});

	it("labeled:原作品没有字就不写那一行;原作者没名字写「未知」", () => {
		expect(postText(post({ text: "转一下", repost: post() }), "labeled")).toBe("转一下");
		const p = post({ text: "转", repost: post({ creator: { name: "" }, text: "原" }) });
		expect(postText(p, "labeled")).toBe("转\n（转发自 未知：原）");
	});

	it("labeled:首尾空白去掉;拼不出字是空串", () => {
		expect(postText(post({ text: "  你好  " }), "labeled")).toBe("你好");
		expect(postText(post(), "labeled")).toBe("");
	});

	it("有标题但不是文章的作品:标题和文章标题同一个待遇", () => {
		const p = post({ title: "周末出游", text: "今天去了海边" });
		expect(postText(p, "plain")).toBe("今天去了海边\n周末出游");
		expect(postText(p, "labeled")).toBe("标题：周末出游\n今天去了海边");
		const reposted = post({
			text: "转",
			repost: post({ creator: { name: "小明" }, title: "原题", text: "原" }),
		});
		expect(postText(reposted, "labeled")).toBe("转\n（转发自 小明：标题：原题 原）");
	});

	it("两种拼法都不看图、附加块、提示语这些不是作品文字的格", () => {
		const p = post({
			text: "正文",
			notice: "BN 说的话",
			topic: "话题",
			label: "投稿了视频",
			images: [{ url: "https://example.com/a.jpg" }],
			attachment: { kind: "card", title: "预约卡" },
			locked: { title: "充电专属", hint: "解锁后可见" },
		});
		expect(postText(p, "plain")).toBe("正文");
		expect(postText(p, "labeled")).toBe("正文");
	});
});

describe("normalizePost —— 片段的字拼起来必须等于正文", () => {
	it("对得上:richText 留着,回的就是原对象", () => {
		const p = post({
			text: "看 #新歌# @小明",
			richText: [
				{ kind: "text", text: "看 " },
				{ kind: "topic", text: "#新歌#", name: "新歌" },
				{ kind: "text", text: " " },
				{ kind: "mention", text: "@小明", userId: "42" },
			],
		});
		expect(normalizePost(p)).toBe(p);
	});

	it("对不上:丢掉 richText,其余格原样", () => {
		const p = post({
			text: "正文",
			topic: "话题",
			richText: [{ kind: "text", text: "正文多了一个字" }],
		});
		const out = normalizePost(p);
		expect(out).not.toHaveProperty("richText");
		expect(out).toEqual(post({ text: "正文", topic: "话题" }));
	});

	it("被转发的原作品一起查:外层对得上、里层对不上,只丢里层的", () => {
		const outer = [{ kind: "text" as const, text: "转" }];
		const p = post({
			text: "转",
			richText: outer,
			repost: post({ text: "原", richText: [{ kind: "emoji", text: "[doge]" }] }),
		});
		const out = normalizePost(p);
		expect(out.richText).toBe(outer);
		expect(out.repost).toEqual(post({ text: "原" }));
	});

	it("空片段表对空正文算对得上;空片段表对有字的正文算对不上", () => {
		const empty = post({ text: "", richText: [] });
		expect(normalizePost(empty)).toBe(empty);
		expect(normalizePost(post({ text: "有字", richText: [] }))).not.toHaveProperty("richText");
	});
});
