import type { LiveEvent } from "@bilibili-notify/blive";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { overridableApi } from "../api-overrides.js";
import { createLiveRooms } from "../live-rooms.js";
import { createDevRegistry, DevParamError } from "../registry.js";
import { liveScenarios, type SubPick } from "../scenarios/live.js";

/**
 * A1:开播 / 下播。往房间的事件漏斗塞 `live-start`,同时让 `getLiveRoomInfo` 对那个房间说
 * 「在播」—— room-session 收到开播事件会立刻去拉房间信息,拉到 `live_status: 0` 就当没开;
 * `live_time` 是这一场的身份,得是「现在」而不是上一场的。下播反过来:塞 `live-end`,补丁摘掉。
 */

const SUBS: SubPick[] = [
	{ id: "s1", uid: "100", name: "甲", enabled: true, roomId: "5050" },
	{ id: "s2", uid: "200", name: "乙", enabled: false, roomId: "6060" },
	{ id: "s3", uid: "300", name: "丙", enabled: true },
];

class FakeApi {
	async getLiveRoomInfo(roomId: string) {
		return {
			code: 0,
			data: {
				uid: 100,
				room_id: Number(roomId),
				short_id: 0,
				live_status: 0,
				live_time: "2026-09-01 20:00:00",
				title: "真标题",
				user_cover: "",
				keyframe: "",
				tags: "",
				area_name: "",
				parent_area_name: "",
			},
		};
	}
}

function setup() {
	const rooms = createLiveRooms();
	const events: LiveEvent[] = [];
	rooms.observe({
		roomId: 5050,
		onEvent: (ev) => events.push(ev),
		client: { closed: false, close() {} },
	});
	const overrides = overridableApi(new FakeApi());
	const reg = createDevRegistry(liveScenarios({ subs: () => SUBS, rooms, api: overrides }));
	return { reg, events, api: overrides.api };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-06T08:00:00.000Z"));
});
afterEach(() => {
	vi.useRealTimers();
});

describe("live.start / live.end", () => {
	it("声明:事件组、快捷位、sub + title 两个参数", () => {
		const { reg } = setup();
		const decls = reg.list();
		expect(decls.map((d) => d.id)).toEqual(["live.start", "live.end"]);
		expect(decls[0]).toMatchObject({ group: "event", quick: true });
		expect(decls[0]?.params.map((p) => p.kind)).toEqual(["sub", "text"]);
	});

	it("开播:省略 sub 取第一个启用且连着的;塞 live-start;房间信息从此说在播、live_time 是现在(北京时间)", async () => {
		const { reg, events, api } = setup();
		const res = await reg.run("live.start", {});

		expect(events).toEqual([{ kind: "live-start" }]);
		expect(res.summary).toContain("5050");
		const info = await api.getLiveRoomInfo("5050");
		expect(info.data).toMatchObject({
			live_status: 1,
			live_time: "2026-09-06 16:00:00",
			title: "devtools 造的一场直播",
			uid: 100,
		});
		// 别的房间不受影响。
		expect((await api.getLiveRoomInfo("7070")).data.live_status).toBe(0);
		expect(res.active).toEqual([{ scenarioId: "live.start", label: "假直播中 · 甲" }]);
	});

	it("指定 sub 与标题", async () => {
		const { reg, api } = setup();
		await reg.run("live.start", { sub: "s1", title: "今晚打老虎" });
		expect((await api.getLiveRoomInfo("5050")).data.title).toBe("今晚打老虎");
	});

	it("房间没连上 → 参数错误,说清楚是哪个", async () => {
		const { reg } = setup();
		await expect(reg.run("live.start", { sub: "s3" })).rejects.toBeInstanceOf(DevParamError);
		await expect(reg.run("live.start", { sub: "s2" })).rejects.toThrow(/6060/);
		await expect(reg.run("live.start", { sub: "nope" })).rejects.toBeInstanceOf(DevParamError);
	});

	it("下播:塞 live-end,补丁摘掉,生效表清空", async () => {
		const { reg, events, api } = setup();
		await reg.run("live.start", {});
		const res = await reg.run("live.end", {});

		expect(events).toEqual([{ kind: "live-start" }, { kind: "live-end" }]);
		expect((await api.getLiveRoomInfo("5050")).data.live_status).toBe(0);
		expect(res.active).toEqual([]);
	});

	it("收摊 = 对每个假直播中的房间下播", async () => {
		const { reg, events, api } = setup();
		await reg.run("live.start", {});
		expect(await reg.reset("live.start")).toEqual([]);
		expect(events.at(-1)).toEqual({ kind: "live-end" });
		expect((await api.getLiveRoomInfo("5050")).data.live_status).toBe(0);
	});

	it("没在假直播的房间也能下播 —— 那是在结束一场真的,回执里说明白", async () => {
		const { reg, events } = setup();
		const res = await reg.run("live.end", {});
		expect(events).toEqual([{ kind: "live-end" }]);
		expect(res.summary).toContain("真");
	});
});
