/**
 * 作品行多收的五格(ADR-0027 决策 4 / 12,规矩在 `docs/agents/conventions/stats-collection.md`):从「链接 + 中立的 `Post`」取。
 * 链接在信封上、不在 `Post` 上(`docs/1.0/data-model.md`:`PostReport { postId, url, post }`),其余四格从 `Post` 取。
 */

import type { Post } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import {
	POST_SUMMARY_MAX_CHARS,
	POST_TITLE_MAX_CHARS,
	postEntryExtras,
} from "../post-entry-extras.js";

const base = (over: Partial<Post> = {}): Post => ({
	creator: { name: "某人" },
	publishedAt: "2026-05-16T10:00:00.000Z",
	text: "",
	...over,
});
const URL = "https://example.com/p/1";

afterEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

describe("postEntryExtras", () => {
	it.each([
		[
			"en",
			"Title: 我的标题\nOriginal 原文\nVideo title: Video 原题\n(Reposted from Unknown: Inner 原文)",
		],
		[
			"ja",
			"タイトル：我的标题\nOriginal 原文\n動画タイトル：Video 原题\n（リポスト元 不明：Inner 原文）",
		],
		["zh-TW", "標題：我的标题\nOriginal 原文\n影片標題：Video 原题\n（轉發自 未知：Inner 原文）"],
	] as const)("%s：生成时翻译摘要标签，原内容和已生成摘要保持", (locale, summary) => {
		const post = base({
			title: "我的标题",
			text: "Original 原文",
			video: { cover: {}, title: "Video 原题", description: "", durationSec: 125 },
			repost: base({ creator: { name: "" }, text: "Inner 原文" }),
		});
		const original = structuredClone(post);
		i18n.set({ locale, voice: "plain" });
		const saved = postEntryExtras({ url: URL, post });
		expect(saved).toEqual({ url: URL, title: "我的标题", summary, videoDurationSec: 125 });
		i18n.set({ locale: "zh-CN", voice: "plain" });
		expect(postEntryExtras({ url: URL, post }).summary).toBe(
			"标题：我的标题\nOriginal 原文\n视频标题：Video 原题\n（转发自 未知：Inner 原文）",
		);
		expect(saved.summary).toBe(summary);
		expect(post).toEqual(original);
	});

	it("带视频、话题、正文:五格都有,摘要使用取段函数的标签拼法", () => {
		const post = base({
			text: "今天的正文",
			topic: "旅行",
			label: "投稿了视频",
			video: {
				cover: {},
				title: "一支视频",
				description: "视频简介不进摘要",
				durationSec: 125,
			},
		});
		expect(postEntryExtras({ url: URL, post })).toEqual({
			url: URL,
			title: "一支视频",
			summary: "今天的正文\n视频标题：一支视频",
			topic: "旅行",
			videoDurationSec: 125,
		});
	});

	it("纯文字:只有链接与摘要,其余格不写(不编默认值)", () => {
		const got = postEntryExtras({ url: URL, post: base({ text: "只有一句话" }) });
		expect(got).toEqual({ url: URL, summary: "只有一句话" });
		expect(Object.keys(got)).toEqual(["url", "summary"]);
	});

	it("标题的回退链:作品自己的标题 → 文章标题 → 视频标题", () => {
		expect(
			postEntryExtras({ url: URL, post: base({ title: "自己的", article: { title: "文章" } }) })
				.title,
		).toBe("自己的");
		expect(postEntryExtras({ url: URL, post: base({ article: { title: "文章" } }) }).title).toBe(
			"文章",
		);
	});

	it("摘要按取段函数的标签拼法,转发的原作品并进去", () => {
		const post = base({
			text: "我的话",
			title: "我的标题",
			repost: base({ text: "原作品", creator: { name: "原作者" } }),
		});
		expect(postEntryExtras({ url: URL, post }).summary).toBe(
			"标题：我的标题\n我的话\n（转发自 原作者：原作品）",
		);
	});

	it("摘要截到 200 个字符,按码点截、不截断代理对", () => {
		const long = postEntryExtras({ url: URL, post: base({ text: "字".repeat(300) }) });
		expect([...(long.summary ?? "")]).toHaveLength(POST_SUMMARY_MAX_CHARS);
		expect(POST_SUMMARY_MAX_CHARS).toBe(200);
		// 第 200 个字符是个代理对(😀 占两个 UTF-16 单元):整个留下,不留半个。
		const emoji = postEntryExtras({ url: URL, post: base({ text: `${"a".repeat(199)}😀😀` }) });
		expect(emoji.summary).toBe(`${"a".repeat(199)}😀`);
	});

	it("标题截到 100 个字符(文档没有长度规矩,取个够用的上限)", () => {
		const got = postEntryExtras({ url: URL, post: base({ title: "题".repeat(150) }) });
		expect([...(got.title ?? "")]).toHaveLength(POST_TITLE_MAX_CHARS);
		expect(POST_TITLE_MAX_CHARS).toBe(100);
	});

	it("拼不出字、没有链接 → 对应格不写", () => {
		expect(postEntryExtras({ url: "", post: base() })).toEqual({});
		expect(postEntryExtras({ url: URL, post: base({ text: "   " }) })).toEqual({ url: URL });
	});

	it("视频时长没有就不写(直播回放这类),话题空串不写", () => {
		const got = postEntryExtras({
			url: URL,
			post: base({ topic: "", video: { cover: {}, title: "", description: "" } }),
		});
		expect(got).toEqual({ url: URL });
	});
});
