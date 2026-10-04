/**
 * 图库里一张图的显示地址:聊天附件、订阅头像、历史配图与头像快照都只存引用,显示都走图库的同源读口
 * `/api/images/<ref>`(ADR-0022 决策 9、ADR-0036 决策 5)。
 */

import { describe, expect, it } from "vite-plus/test";
import { imageUrl } from "../image-url";

describe("imageUrl", () => {
	it("拼成 /api/images/<ref>(不再是 /api/ai/assets、/api/history/img、/api/subscriptions/:id/avatar)", () => {
		const ref = `${"c".repeat(64)}.webp`;
		expect(imageUrl(ref)).toBe(`/api/images/${ref}`);
	});

	it("引用里要是有不该有的字符,编码一道,不能拼出另一条路径", () => {
		expect(imageUrl("../x.png?a=1")).toBe("/api/images/..%2Fx.png%3Fa%3D1");
	});
});
