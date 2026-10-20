import { describe, expect, it } from "vite-plus/test";
import { describeLiveRoomDanmakuAccessDenied } from "../room-helpers.js";

describe("describeLiveRoomDanmakuAccessDenied", () => {
	it("accepts a complete danmu info", () => {
		expect(
			describeLiveRoomDanmakuAccessDenied({
				token: "token",
				host_list: [{ host: "example.com" }],
			}),
		).toBeUndefined();
	});

	it("rejects a missing body", () => {
		expect(describeLiveRoomDanmakuAccessDenied(null)).toBe("B 站未返回弹幕连接信息");
	});

	it("rejects missing token or host list", () => {
		expect(describeLiveRoomDanmakuAccessDenied({ host_list: [{ host: "example.com" }] })).toBe(
			"B 站未返回弹幕 token",
		);
		expect(describeLiveRoomDanmakuAccessDenied({ token: "token", host_list: [] })).toBe(
			"B 站未返回弹幕服务器列表",
		);
	});
});
