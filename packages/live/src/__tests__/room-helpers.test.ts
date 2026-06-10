import { describe, expect, it } from "vitest";
import { describeLiveRoomDanmuAccessDenied } from "../room-helpers";

describe("describeLiveRoomDanmuAccessDenied", () => {
	it("accepts a complete danmu info response", () => {
		expect(
			describeLiveRoomDanmuAccessDenied({
				code: 0,
				data: { token: "token", host_list: [{ host: "example.com" }] },
			}),
		).toBeUndefined();
	});

	it("rejects upstream non-zero responses without exposing token-like data", () => {
		expect(
			describeLiveRoomDanmuAccessDenied({
				code: -400,
				message: "room is encrypted",
				data: null,
			}),
		).toBe("B 站返回 code=-400 message=room is encrypted");
	});

	it("rejects missing token or host list", () => {
		expect(
			describeLiveRoomDanmuAccessDenied({
				code: 0,
				data: { host_list: [{ host: "example.com" }] },
			}),
		).toBe("B 站未返回弹幕 token");

		expect(
			describeLiveRoomDanmuAccessDenied({
				code: 0,
				data: { token: "token", host_list: [] },
			}),
		).toBe("B 站未返回弹幕服务器列表");
	});
});
