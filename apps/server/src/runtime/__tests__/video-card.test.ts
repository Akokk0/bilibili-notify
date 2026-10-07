/**
 * 链接预览直接造的「投稿了视频」作品(㉑c 第 5 步)。
 *
 * 手里有现成的数字与秒数,直接填进 `Post`:播放 / 弹幕数原样是数字,时长是秒(`durationSec: info.duration`),
 * 不再伪造一条 B 站原始动态再让翻译层把排好的字解析回来。「投稿了视频」是明说的 `label` —— 从前靠
 * `archive.badge.text === "投稿视频"` 这个隐含耦合。
 */

import { normalizePost } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import type { VideoResponse } from "../../bilibili/api/index.js";
import { videoToPost } from "../video-card.js";

const INFO: VideoResponse = {
	bvid: "BV1zMtU6uEEb",
	aid: 114514,
	title: "示例标题",
	pic: "http://i0.hdslb.com/bfs/archive/cover.jpg",
	desc: "示例简介",
	duration: 3723,
	pubdate: 1756800000,
	tname: "日常",
	owner: { mid: 12345, name: "示例UP", face: "http://i0.hdslb.com/bfs/face/face.jpg" },
	stat: { view: 65_000, danmaku: 120, reply: 30, favorite: 400, coin: 200, share: 15, like: 3000 },
};

describe("videoToPost", () => {
	it("视频:播放 / 弹幕是原样的数字,时长是秒,封面只给地址", () => {
		expect(videoToPost(INFO).video).toEqual({
			cover: { url: "http://i0.hdslb.com/bfs/archive/cover.jpg" },
			title: "示例标题",
			description: "示例简介",
			durationSec: 3723,
			views: 65_000,
			danmaku: 120,
		});
	});

	it("「投稿了视频」是明说的 label;没有动态正文;作者只有名字(头像不给)", () => {
		const post = videoToPost(INFO);
		expect(post.label).toBe("投稿了视频");
		expect(post.text).toBe("");
		expect(post.creator).toEqual({ name: "示例UP" });
	});

	it("发布时间:unix 秒 → ISO;坏时间落在纪元,不抛", () => {
		expect(videoToPost(INFO).publishedAt).toBe("2025-09-02T08:00:00.000Z");
		expect(videoToPost({ ...INFO, pubdate: Number.NaN }).publishedAt).toBe(
			"1970-01-01T00:00:00.000Z",
		);
	});

	it("互动数:分享 / 评论 / 点赞 → shares / comments / likes", () => {
		expect(videoToPost(INFO).stats).toEqual({ shares: 15, comments: 30, likes: 3000 });
	});

	it("过 normalizePost 原样不动(没有 richText 可丢)", () => {
		const post = videoToPost(INFO);
		expect(normalizePost(post)).toBe(post);
	});
});
