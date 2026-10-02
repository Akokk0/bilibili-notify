/**
 * 单元测试 —— `broadcastOptionsForPostPart`:一次 broadcastDynamic 交给推送层的选项。
 *
 * 一条 DYNAMIC_TYPE_DRAW 图文动态会发两次 —— 主卡片(part="post")与图集附图
 * (part="post-images")。两者是**同一次推送**(共用 pushId,历史落同一行):图集是主卡
 * 的附加项(`role: "extra"`),而且不再 @全体 —— 否则接收端会被重复艾特(用户报告的 bug)。
 */

import { describe, expect, it } from "vite-plus/test";
import { broadcastOptionsForPostPart } from "../push-like.js";

describe("broadcastOptionsForPostPart", () => {
	it("主卡片(post)→ 只带 pushId,维持按 feature 决定的 @全体,是本体", () => {
		expect(broadcastOptionsForPostPart("post", "p1")).toEqual({ pushId: "p1" });
	});

	it("图集附图(post-images)→ 同 pushId、抑制 @全体、标附加项", () => {
		expect(broadcastOptionsForPostPart("post-images", "p1")).toEqual({
			pushId: "p1",
			allowAtAll: false,
			role: "extra",
		});
	});

	it("没 pushId(屏蔽提示这类独立小推送)→ 不带,让推送层自己起一个", () => {
		expect(broadcastOptionsForPostPart("post", undefined)).toBeUndefined();
	});

	it("图集没 pushId 也照样抑制 @全体 —— 抑制是身份带来的,不是 pushId 带来的", () => {
		expect(broadcastOptionsForPostPart("post-images", undefined)).toEqual({
			allowAtAll: false,
			role: "extra",
		});
	});
});
