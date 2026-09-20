/**
 * **重推的闸,与「哪几条还没到」**(ADR-0017 决策 6、10-13)。
 *
 * 这一份全是纯函数 —— 闸判什么、不判什么,是这份定案里最容易被想当然改坏的一块,
 * 所以每一档都写清楚**为什么**。
 *
 * 🔴 **挡「这个目标还该不该收」,不挡「现在是不是发消息的好时候」。**
 *
 * - 挡:routing 里已经没有它、目标或连接被停用(决策 10)。那是用户**已经取消了**,
 *   与发送层每次重试前复检 routing 同源。
 * - 挡:这一行正在重推(决策 13)。挡在服务端而不是只靠前端禁用 —— 两个标签页前端
 *   管不着,而后果是真的往群里多发一条。
 * - **不挡**:全局静音、免扰时段、特性总开关(决策 11)。这是主人**此刻按下的显式
 *   动作**,不是引擎自动推送;挡掉他只会以为按钮坏了。
 * - **不挡**:目标不可达(决策 12)—— 那正是重推要解决的东西,让它走正常的退避重试。
 *
 * 顺带一条容易忘的:`no-targets` 行不给按钮(决策 6)。那不是失败是没配目标,而且
 * 压根没有目标可发。
 */

import { randomUUID } from "node:crypto";
import type { HistoryEntry, HistoryMessage, PushStatus } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { originalCount, repushDenial, unsentIndices } from "../repush.js";

const T1 = randomUUID();
const OK = { ok: true, latencyMs: 5 };
const FAIL = { ok: false, latencyMs: 7, err: "boom" };

function msg(
	role: HistoryMessage["role"],
	result?: HistoryMessage["result"],
	retryOf?: number,
): HistoryMessage {
	return {
		payload: { kind: "text", text: "x" },
		role,
		...(result ? { result } : {}),
		...(retryOf !== undefined ? { retryOf } : {}),
	};
}

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		id: randomUUID(),
		pushId: randomUUID(),
		ts: "2026-09-20T08:00:00.000Z",
		kind: "dynamic",
		uid: "u1",
		subscriptionId: randomUUID(),
		targetId: T1,
		status: "failed" as PushStatus,
		messages: [msg("main", FAIL)],
		...over,
	};
}

/** 一切都对的那个入参 —— 每条用例只坏一样。 */
function allow(over: Partial<Parameters<typeof repushDenial>[0]> = {}) {
	return { entry: entry(), routedTargets: [T1], targetEnabled: true, running: false, ...over };
}

describe("originalCount — 这一行本来有几条消息", () => {
	it("没有重投 → 就是消息条数", () => {
		expect(originalCount([msg("main", OK), msg("extra", FAIL)])).toBe(2);
	});

	/**
	 * 重推之后行会变长,但「本来有几条」不变 —— 原件对表靠的就是这个数。拿
	 * `messages.length` 去对,重推一次原件就对不上号、按钮当场灰掉。
	 */
	it("重投不算新的一条", () => {
		expect(originalCount([msg("main", FAIL), msg("main", OK, 0)])).toBe(1);
		expect(
			originalCount([
				msg("main", OK),
				msg("extra", FAIL),
				msg("extra", OK, 1),
				msg("extra", FAIL, 1),
			]),
		).toBe(2);
	});
});

describe("unsentIndices — 「只补没到的」要补哪几条", () => {
	it("全到了 → 一条都不用补", () => {
		expect(unsentIndices([msg("main", OK), msg("extra", OK)])).toEqual([]);
	});

	it("失败的那一条", () => {
		expect(unsentIndices([msg("main", OK), msg("extra", FAIL)])).toEqual([1]);
	});

	// 决策 17 之后,因为前面失败而从没发出去的那几条也在行里(没有 result)。
	it("从没发出去的那几条也算没到", () => {
		expect(unsentIndices([msg("main", OK), msg("extra", FAIL), msg("extra")])).toEqual([1, 2]);
	});

	it("补好了的不再算,补了又失败的还算", () => {
		const base = [msg("main", OK), msg("extra", FAIL), msg("extra", FAIL)];
		expect(unsentIndices([...base, msg("extra", OK, 1)])).toEqual([2]);
		expect(unsentIndices([...base, msg("extra", FAIL, 1)])).toEqual([1, 2]);
	});

	it("升序,不重复", () => {
		const out = unsentIndices([msg("main", FAIL), msg("extra", FAIL), msg("main", FAIL, 0)]);
		expect(out).toEqual([0, 1]);
	});
});

describe("repushDenial — 挡什么", () => {
	it("一切都对 → 放行", () => {
		expect(repushDenial(allow())).toBeNull();
	});

	it("partial 行也放行(那是「有几条没到」)", () => {
		expect(repushDenial(allow({ entry: entry({ status: "partial" }) }))).toBeNull();
	});

	it("已送达的行不给补", () => {
		expect(repushDenial(allow({ entry: entry({ status: "delivered" }) }))).not.toBeNull();
	});

	// 那不是失败是没配目标,而且压根没有目标可发(决策 6)。
	it("无目标行不给补", () => {
		const e = entry({ status: "no-targets", targetId: null });
		expect(repushDenial(allow({ entry: e, routedTargets: [] }))).not.toBeNull();
	});

	it("routing 里已经没有这个目标 → 拒(用户已经取消了)", () => {
		expect(repushDenial(allow({ routedTargets: [] }))).not.toBeNull();
		expect(repushDenial(allow({ routedTargets: [randomUUID()] }))).not.toBeNull();
	});

	it("目标或它所属的连接被停用 → 拒", () => {
		expect(repushDenial(allow({ targetEnabled: false }))).not.toBeNull();
	});

	// 两个标签页各点一下,前端的禁用态管不着彼此,而后果是真的往群里多发一条。
	it("这一行正在补 → 拒", () => {
		expect(repushDenial(allow({ running: true }))).not.toBeNull();
	});

	/**
	 * 🔴 这条守的是**不该挡的那些**。静音 / 免扰 / 特性总开关在这个闸的入参里
	 * **根本不存在** —— 想挡都挡不了,而不是「记得别挡」。
	 *
	 * 哪天有人把它们加进来,这条会红:入参多一把钥匙,这里的键名清单就对不上了。
	 */
	it("闸的入参里没有静音 / 免扰 / 特性开关这些东西", () => {
		expect(Object.keys(allow()).sort()).toEqual([
			"entry",
			"routedTargets",
			"running",
			"targetEnabled",
		]);
	});

	it("每一档拒绝都说得出人话,不是空字符串", () => {
		const denials = [
			repushDenial(allow({ entry: entry({ status: "delivered" }) })),
			repushDenial(allow({ routedTargets: [] })),
			repushDenial(allow({ targetEnabled: false })),
			repushDenial(allow({ running: true })),
		];
		for (const d of denials) expect(d && d.length > 4).toBe(true);
		// 四档各有各的说法,不是同一句敷衍话。
		expect(new Set(denials)).toHaveLength(4);
	});
});
