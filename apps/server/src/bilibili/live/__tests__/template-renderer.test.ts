import { describe, expect, it } from "vite-plus/test";
import { buildRoomLink } from "../template-renderer.js";

describe("buildRoomLink", () => {
	it("有短号用短号，没有用长号", () => {
		expect(buildRoomLink({ short_id: 123, room_id: 5001 })).toBe("https://live.bilibili.com/123");
		expect(buildRoomLink({ short_id: 0, room_id: 5001 })).toBe("https://live.bilibili.com/5001");
	});
});
