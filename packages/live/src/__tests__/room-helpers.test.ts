import { describe, expect, it } from "vitest";
import {
	describeLiveRoomDanmuAccessDenied,
	describeLiveRoomDanmuPreflightFallback,
} from "../room-helpers";

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

	it("treats -352 as preflight risk-control fallback instead of hard denial", () => {
		const info = {
			code: -352,
			message: "-352",
			data: null,
		};
		expect(describeLiveRoomDanmuPreflightFallback(info)).toBe("B 站返回 code=-352 message=-352");
		expect(describeLiveRoomDanmuAccessDenied(info)).toBeUndefined();
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
