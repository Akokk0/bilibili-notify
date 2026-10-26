import { describe, expect, it } from "vite-plus/test";
import { normalizePost, type Post } from "../post";

const creator = { name: "阿梓" };

function post(over: Partial<Post> = {}): Post {
	return { creator, publishedAt: "2026-10-05T08:00:00.000Z", text: "", ...over };
}

describe("normalizePost —— 片段的字拼起来必须等于正文", () => {
	it("对得上:richText 留着,回的就是原对象", () => {
		const p = post({
			text: "看 #新歌# @小明",
			richText: [
				{ kind: "text", text: "看 " },
				{ kind: "topic", text: "#新歌#", name: "新歌" },
				{ kind: "text", text: " " },
				{ kind: "mention", text: "@小明", externalId: "42" },
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
