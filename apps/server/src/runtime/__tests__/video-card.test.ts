/**
 * 链接预览伪造的「投稿了视频」动态里的数字(㉑c 第 3 步)。
 *
 * 播放 / 弹幕数手里就是数字,直接放进原始动态(`stat.play` 本来就收 `number | string`),由卡片那头统一
 * `formatCount` 排一次 —— 不在这里先排成「6.5万」再让卡片解析回去。时长原始字段只能是字符串,所以仍先排成
 * 「m:ss」(卡片那头解析成秒再排,往返不失真);换入口那一步直接造 `Post` 时这里不再绕。
 */

import type { VideoInfo } from "@bilibili-notify/api";
import { describe, expect, it } from "vite-plus/test";
import { videoToDynamic } from "../video-card.js";

const INFO: VideoInfo = {
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

describe("videoToDynamic —— 数字", () => {
	const archive = () => {
		const a = videoToDynamic(INFO).modules.module_dynamic.major?.archive;
		if (!a) throw new Error("没有 archive");
		return a;
	};

	it("播放数与弹幕数是原样的数字,不是排好的字", () => {
		expect(archive().stat).toEqual({ play: 65_000, danmaku: 120 });
		expect(typeof archive().stat.play).toBe("number");
	});

	it("时长排成「m:ss」/「h:mm:ss」(原始字段是字符串)", () => {
		expect(archive().duration_text).toBe("1:02:03");
		expect(
			videoToDynamic({ ...INFO, duration: 754 }).modules.module_dynamic.major?.archive
				?.duration_text,
		).toBe("12:34");
	});

	it("互动数同样是数字", () => {
		expect(videoToDynamic(INFO).modules.module_stat).toEqual({
			comment: { count: 30 },
			forward: { count: 15 },
			like: { count: 3000 },
		});
	});
});
