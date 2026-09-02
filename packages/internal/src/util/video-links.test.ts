/**
 * 链接解析的第一道:从一段聊天文本里挑出 B 站视频引用。
 *
 * 只认三种形态 —— bilibili.com 域下的 /video/BV…、/video/av…,以及 b23.tv 短链。
 * 别的域名里哪怕路径长得一样也不认:群里发的链接是别人的输入,解析结果会驱动
 * 服务端去发请求,认错域名就是让任意站点指挥我们去连它。
 */

import { describe, expect, it } from "vite-plus/test";
import { extractVideoLinks } from "./video-links";

describe("extractVideoLinks", () => {
	it("认出正文里的 BV 链接,带不带尾斜杠都一样", () => {
		expect(extractVideoLinks("看这个 https://www.bilibili.com/video/BV1zMtU6uEEb/ 好看")).toEqual([
			{ kind: "bvid", bvid: "BV1zMtU6uEEb" },
		]);
		expect(extractVideoLinks("https://www.bilibili.com/video/BV1zMtU6uEEb")).toEqual([
			{ kind: "bvid", bvid: "BV1zMtU6uEEb" },
		]);
	});

	it("查询串与分 P 参数不影响识别", () => {
		expect(
			extractVideoLinks(
				"https://www.bilibili.com/video/BV1zMtU6uEEb/?p=2&vd_source=abc&spm_id_from=333.1007",
			),
		).toEqual([{ kind: "bvid", bvid: "BV1zMtU6uEEb" }]);
	});

	it("移动端域名与 av 号链接", () => {
		expect(extractVideoLinks("https://m.bilibili.com/video/av170001?p=1")).toEqual([
			{ kind: "aid", aid: "170001" },
		]);
		expect(extractVideoLinks("http://bilibili.com/video/BV1zMtU6uEEb")).toEqual([
			{ kind: "bvid", bvid: "BV1zMtU6uEEb" },
		]);
	});

	it("b23.tv 短链原样交出去,由调用方去解", () => {
		expect(extractVideoLinks("分享 https://b23.tv/abc123 一下")).toEqual([
			{ kind: "short", url: "https://b23.tv/abc123" },
		]);
	});

	it("同一个视频出现两次只算一次,不同视频按出现顺序", () => {
		const text =
			"https://www.bilibili.com/video/BV1zMtU6uEEb 和 https://b23.tv/xyz 还有 https://www.bilibili.com/video/BV1zMtU6uEEb/";
		expect(extractVideoLinks(text)).toEqual([
			{ kind: "bvid", bvid: "BV1zMtU6uEEb" },
			{ kind: "short", url: "https://b23.tv/xyz" },
		]);
	});

	it("别的域名里长得像的路径不认;没有链接就是空", () => {
		expect(extractVideoLinks("https://evil.example/video/BV1zMtU6uEEb")).toEqual([]);
		expect(extractVideoLinks("https://notbilibili.com/video/BV1zMtU6uEEb")).toEqual([]);
		expect(extractVideoLinks("今天天气不错")).toEqual([]);
		expect(extractVideoLinks("")).toEqual([]);
	});
});
