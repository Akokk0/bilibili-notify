import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { overridableApi } from "../../../devtools/api-overrides.js";
import type { LiveEvent } from "../../live/protocol/events.js";
import { liveScenarios } from "../live.js";
import { createLiveRooms } from "../live-rooms.js";
import { biliRegistry, rosterEntry } from "./support/registry.js";

/**
 * A1:开播 / 下播。往房间的事件漏斗塞 `live-start`,同时让 `fetchLiveRoomInfo` 对那个房间说
 * 「在播」—— room-session 收到开播事件会立刻去拉房间信息,拉到 `live_status: 0` 就当没开;
 * `live_time` 是这一场的身份,得是「现在」而不是上一场的。下播反过来:塞 `live-end`,补丁摘掉。
 *
 * 挑人只看 B 站自己的名单(`ctx.subscriptions()` 那一份):300 还没解析出房号,400 的房间没连上,100 连着。
 */

const ROSTER = [rosterEntry("300"), rosterEntry("400"), rosterEntry("100")];

class FakeApi {
	async fetchLiveRoomInfo(roomId: string) {
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
	const roomIds = new Map([
		["100", "5050"],
		["400", "6060"],
	]);
	const events: LiveEvent[] = [];
	rooms.observe({
		roomId: 5050,
		onEvent: (ev) => events.push(ev),
		client: { closed: false, close() {} },
	});
	const overrides = overridableApi(new FakeApi());
	const reg = biliRegistry(
		liveScenarios({
			roster: () => ROSTER,
			rooms,
			api: () => overrides,
			liveRooms: () => ({ roomIdOf: (externalId) => roomIds.get(externalId) }),
		}),
		ROSTER,
	);
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
	it("声明:事件组、快捷位、creator + title 两个参数", () => {
		const { reg } = setup();
		const decls = reg.list();
		expect(decls.map((d) => d.id)).toEqual(["bilibili.live.start", "bilibili.live.end"]);
		expect(decls[0]).toMatchObject({ group: "event", quick: true });
		expect(decls[0]?.params.map((p) => p.kind)).toEqual(["creator", "text"]);
	});

	it("开播:省略 creator 取名单里第一个直播间连着的;塞 live-start;房间信息从此说在播、live_time 是现在(北京时间)", async () => {
		const { reg, events, api } = setup();
		const res = await reg.run("bilibili.live.start", {});

		expect(events).toEqual([{ kind: "live-start" }]);
		expect(res).toMatchObject({ ok: true, summary: expect.stringContaining("5050") });
		const info = await api.fetchLiveRoomInfo("5050");
		expect(info.data).toMatchObject({
			live_status: 1,
			live_time: "2026-09-06 16:00:00",
			title: "devtools 造的一场直播",
			uid: 100,
		});
		// 别的房间不受影响。
		expect((await api.fetchLiveRoomInfo("7070")).data.live_status).toBe(0);
		expect(res).toMatchObject({
			ok: true,
			active: [{ scenarioId: "bilibili.live.start", label: "假直播中 · UID 100" }],
		});
	});

	it("指定 creator 与标题", async () => {
		const { reg, api } = setup();
		await reg.run("bilibili.live.start", { creator: "100", title: "今晚打老虎" });
		expect((await api.fetchLiveRoomInfo("5050")).data.title).toBe("今晚打老虎");
	});

	it("房号没解析出来 / 房间没连上 / 不在名单里 → 参数错误,说清楚是哪个", async () => {
		const { reg } = setup();
		await expect(reg.run("bilibili.live.start", { creator: "300" })).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringContaining("UID 300"),
		});
		await expect(reg.run("bilibili.live.start", { creator: "400" })).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringContaining("6060"),
		});
		await expect(reg.run("bilibili.live.start", { creator: "200" })).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringContaining("不在名单里"),
		});
	});

	it("下播:塞 live-end,补丁摘掉,生效表清空", async () => {
		const { reg, events, api } = setup();
		await reg.run("bilibili.live.start", {});
		const res = await reg.run("bilibili.live.end", {});

		expect(events).toEqual([{ kind: "live-start" }, { kind: "live-end" }]);
		expect((await api.fetchLiveRoomInfo("5050")).data.live_status).toBe(0);
		expect(res).toMatchObject({ ok: true, active: [] });
	});

	it("收摊 = 对每个假直播中的房间下播", async () => {
		const { reg, events, api } = setup();
		await reg.run("bilibili.live.start", {});
		expect(await reg.reset("bilibili.live.start")).toMatchObject({ ok: true, active: [] });
		expect(events.at(-1)).toEqual({ kind: "live-end" });
		expect((await api.fetchLiveRoomInfo("5050")).data.live_status).toBe(0);
	});

	it("没在假直播的房间也能下播 —— 那是在结束一场真的,回执里说明白", async () => {
		const { reg, events } = setup();
		const res = await reg.run("bilibili.live.end", {});
		expect(events).toEqual([{ kind: "live-end" }]);
		expect(res).toMatchObject({ ok: true, summary: expect.stringContaining("真") });
	});
});
