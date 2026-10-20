import { describe, expect, it } from "vite-plus/test";
import { liveDetailsFromRoomInfo, liveTimeToIso } from "../live-card-input.js";

const ROOM = {
	room_id: 5001,
	short_id: 0,
	title: "周年庆典特别直播",
	area_name: "虚拟主播",
	user_cover: "https://i0.hdslb.com/bfs/live/cover.jpg",
	keyframe: "https://i0.hdslb.com/bfs/live/keyframe.jpg",
	description: "<p>每晚八点开播&nbsp;&amp;&nbsp;周末加场</p><br>&lt;b&gt;见动态&lt;/b&gt;",
	online: 12_345,
	live_time: "2026-09-13 20:00:00",
};

describe("liveDetailsFromRoomInfo", () => {
	it("房间信息翻成中立详情，图只带调用方存好的引用", () => {
		expect(
			liveDetailsFromRoomInfo(ROOM, {
				coverRef: `${"a".repeat(64)}.webp`,
				totalViewers: 31_200,
			}),
		).toStrictEqual({
			title: "周年庆典特别直播",
			cover: {
				url: "https://i0.hdslb.com/bfs/live/cover.jpg",
				ref: `${"a".repeat(64)}.webp`,
			},
			category: "虚拟主播",
			url: "https://live.bilibili.com/5001",
			currentViewers: 12_345,
			totalViewers: 31_200,
			description: "每晚八点开播 & 周末加场 见动态",
		});
	});

	it("缺房间数据时不抛，空值不补成 0 或空串", () => {
		expect(liveDetailsFromRoomInfo(null)).toStrictEqual({});
		expect(liveDetailsFromRoomInfo({ ...ROOM, online: "" })).not.toHaveProperty("currentViewers");
	});

	it("封面先房间图、再关键帧；两张都没有就不带 cover", () => {
		expect(liveDetailsFromRoomInfo({ ...ROOM, user_cover: "" }).cover).toEqual({
			url: ROOM.keyframe,
		});
		expect(liveDetailsFromRoomInfo({ ...ROOM, user_cover: "", keyframe: "" })).not.toHaveProperty(
			"cover",
		);
	});
});

describe("liveTimeToIso", () => {
	it("北京时间按 +08:00 读", () => {
		expect(liveTimeToIso("2026-01-01 03:30:15")).toBe("2025-12-31T19:30:15.000Z");
	});

	it("缺失、全零、坏格式都没有时刻", () => {
		for (const raw of [undefined, "", "0000-00-00 00:00:00", "2026-13-45 10:00:00", "昨天"]) {
			expect(liveTimeToIso(raw), String(raw)).toBeUndefined();
		}
	});
});
