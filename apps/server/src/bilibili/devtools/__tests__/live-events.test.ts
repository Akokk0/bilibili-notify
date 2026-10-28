import { describe, expect, it } from "vite-plus/test";
import { GuardLevel, type LiveEvent } from "../../live/protocol/events.js";
import { liveEventScenarios } from "../live-events.js";
import { createLiveRooms } from "../live-rooms.js";
import { biliRegistry, rosterEntry } from "./support/registry.js";

/**
 * A2:弹幕批量 / SC / 上舰 / 礼物 / 进场 —— 都是往房间的事件漏斗塞 LiveEvent。守的是形状:
 * 每一种都得是 blive 会解析出来的那个样子,不然 room-session 的 switch 一路 default 掉,
 * 「塞了没反应」查不出来。弹幕批量另守两件事:条数对、发言人数对(词云要 50 个热词、
 * 总结要 5 位发言人,门槛就是冲这两个数去的)。
 */

const ROSTER = [rosterEntry("100"), rosterEntry("300")];

function setup() {
	const rooms = createLiveRooms();
	const roomIds = new Map([["100", "5050"]]);
	const events: LiveEvent[] = [];
	rooms.observe({
		roomId: 5050,
		onEvent: (ev) => events.push(ev),
		client: { closed: false, close() {} },
	});
	const reg = biliRegistry(
		liveEventScenarios({
			roster: () => ROSTER,
			rooms,
			liveRooms: () => ({ roomIdOf: (externalId) => roomIds.get(externalId) }),
		}),
		ROSTER,
	);
	return { reg, events };
}

describe("直播事件场景", () => {
	it("声明:五个场景都在事件组,都收 creator", () => {
		const { reg } = setup();
		const decls = reg.list();
		expect(decls.map((d) => d.id)).toEqual([
			"bilibili.live.danmaku",
			"bilibili.live.superchat",
			"bilibili.live.guard",
			"bilibili.live.gift",
			"bilibili.live.enter",
		]);
		for (const d of decls) {
			expect(d.group).toBe("event");
			expect(d.params[0]).toMatchObject({ key: "creator", kind: "creator" });
		}
	});

	it("弹幕批量:条数与发言人数照参数来,内容各不相同,时间戳是现在", async () => {
		const { reg, events } = setup();
		const res = await reg.run("bilibili.live.danmaku", { count: 60, senders: 8 });

		expect(events).toHaveLength(60);
		const danmakus = events.filter((e) => e.kind === "danmu");
		expect(danmakus).toHaveLength(60);
		expect(new Set(danmakus.map((e) => e.user.uid)).size).toBe(8);
		expect(new Set(danmakus.map((e) => e.content)).size).toBeGreaterThanOrEqual(50);
		expect(danmakus.every((e) => typeof e.timestamp === "number")).toBe(true);
		expect(res).toMatchObject({ ok: true, summary: expect.stringContaining("60") });
	});

	it("弹幕批量:给了 uid 就全由这一位发 —— 拿来试特别关注的弹幕推送", async () => {
		const { reg, events } = setup();
		await reg.run("bilibili.live.danmaku", { count: 3, senders: 8, uid: "777" });
		const danmakus = events.filter((e) => e.kind === "danmu");
		expect(danmakus.map((e) => e.user.uid)).toEqual([777, 777, 777]);
	});

	it("弹幕批量默认冲门槛:60 条 / 8 人", () => {
		const { reg } = setup();
		const decl = reg.list().find((d) => d.id === "bilibili.live.danmaku");
		expect(decl?.params).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "count", kind: "number", default: 60 }),
				expect.objectContaining({ key: "senders", kind: "number", default: 8 }),
			]),
		);
	});

	it("SC:价格与正文照给,发言人有 uid / name", async () => {
		const { reg, events } = setup();
		await reg.run("bilibili.live.superchat", { price: 50, text: "主播晚上好" });
		expect(events).toEqual([
			expect.objectContaining({
				kind: "superchat",
				price: 50,
				content: "主播晚上好",
				user: expect.objectContaining({ uid: expect.any(Number), name: expect.any(String) }),
			}),
		]);
	});

	it("上舰:等级按枚举转成 GuardLevel,礼物名跟着等级", async () => {
		const { reg, events } = setup();
		await reg.run("bilibili.live.guard", { level: "admiral" });
		expect(events[0]).toMatchObject({
			kind: "guard-buy",
			guardLevel: GuardLevel.Admiral,
			giftName: "提督",
		});
		await reg.run("bilibili.live.guard", {});
		expect(events[1]).toMatchObject({ guardLevel: GuardLevel.Captain, giftName: "舰长" });
	});

	it("礼物:名字 / 数量照给,金瓜子计价", async () => {
		const { reg, events } = setup();
		await reg.run("bilibili.live.gift", { name: "小花花", num: 3 });
		expect(events[0]).toMatchObject({
			kind: "gift",
			giftName: "小花花",
			num: 3,
			coinType: "gold",
			price: expect.any(Number),
		});
	});

	it("进场:用给的 uid;空着回 invalid —— 特别关注是核心的订阅配置,B 站拿不到,得自己填", async () => {
		const { reg, events } = setup();
		await reg.run("bilibili.live.enter", { uid: "12345" });
		expect(events[0]).toMatchObject({ kind: "user-action", action: "enter", user: { uid: 12345 } });

		await expect(reg.run("bilibili.live.enter", {})).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringContaining("特别关注"),
		});
		expect(events).toHaveLength(1);
	});

	it("房间没连上 → 参数错误", async () => {
		const { reg } = setup();
		await expect(reg.run("bilibili.live.superchat", { creator: "300" })).resolves.toMatchObject({
			ok: false,
			code: "invalid",
		});
	});
});
