/**
 * **重投之后这一行算什么状态**(ADR-0017 决策 15、16)。
 *
 * 人工重推**追加进原行**,不新开行也不替换 —— 行模型一个字不动,「失败过并被补上」
 * 是事实,排查时「什么时候失败、隔多久补上」正是最有用的信息。代价是一行里会出现
 * 同一条消息的好几次尝试,四态的算法必须跟着改口径:
 *
 * **每条消息的身份 = `retryOf ?? 它自己的下标`;每个身份只认它最后一次的结果。**
 *
 * 🔴 **不能简化成「按 role 取最后一次」** —— 同一个 role 下有好几条时会把不同的消息
 * 混成一个:补好了 extra1,整行就变绿,而 extra2 还躺着没送到。本文件里「补了一条、
 * 另一条还欠着」那一条就是钉这个的,按 role 那种写法在它面前必红。
 *
 * 老行没有 `retryOf`,每条消息自成一号,算出来与从前**逐字节一样** —— 盘上的老数据
 * 一条都不用迁移(ADR-0017 背景 5:`status` 是写入时算好存在盘上的,读侧不重算)。
 * 端到端那半仍归 `record.test.ts` 的「四态」;这里直接钉纯函数,因为**重投的消息进不了
 * `record()` 那条路** —— 引擎推送永远不产生 `retryOf`,只有重推那条新路径会。
 */

import { randomUUID } from "node:crypto";
import type { HistoryMessage } from "@bilibili-notify/internal";
import { HistoryMessageSchema } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { computeStatus } from "../store.js";

const T1 = randomUUID();
const OK = { ok: true, latencyMs: 5 };
const FAIL = { ok: false, latencyMs: 7, err: "boom" };

/** 一条消息。`retryOf` 给了就是某一号的重投。 */
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

describe("HistoryMessageSchema — retryOf", () => {
	it("带 retryOf 的消息存得进、读得回", () => {
		const parsed = HistoryMessageSchema.parse({
			payload: { kind: "text", text: "补发的卡片" },
			role: "main",
			result: OK,
			retryOf: 0,
		});
		expect(parsed.retryOf).toBe(0);
	});

	it("老消息没有 retryOf → undefined,不是 0", () => {
		const parsed = HistoryMessageSchema.parse({
			payload: { kind: "text", text: "卡片" },
			role: "main",
			result: OK,
		});
		// 0 是一个**合法的身份号**(本体那一号)。默认值填 0 会让每条老消息都自称
		// 「我是第 0 条的重投」,整行的身份全部塌成一个。
		expect(parsed.retryOf).toBeUndefined();
	});

	it("retryOf 只收非负整数", () => {
		const base = { payload: { kind: "text", text: "x" }, role: "main", result: OK };
		expect(HistoryMessageSchema.safeParse({ ...base, retryOf: -1 }).success).toBe(false);
		expect(HistoryMessageSchema.safeParse({ ...base, retryOf: 1.5 }).success).toBe(false);
		expect(HistoryMessageSchema.safeParse({ ...base, retryOf: 3 }).success).toBe(true);
	});
});

describe("computeStatus — 重投按身份号算", () => {
	it("唯一失败的那条被补上 → delivered", () => {
		const before = [msg("main", OK), msg("extra", FAIL)];
		expect(computeStatus(T1, before)).toBe("partial");
		expect(computeStatus(T1, [...before, msg("extra", OK, 1)])).toBe("delivered");
	});

	/**
	 * 🔴 定案里那句 ⚠️ 的守卫。两条 extra 都没到,只补好了头一条:
	 *
	 * - 按**身份号**算:一号补绿了、二号还是红的 → 仍是 partial ✅
	 * - 按 **role 取最后一次**算:role=extra 的最后一次是刚补好的那条 → 整行变绿 ❌
	 *
	 * 后一种写法在真实场景里的样子是:主人点了「只补没到的」,词云补上了、总结还躺着,
	 * 面板却告诉他全送到了,按钮也跟着消失 —— 那条总结永远补不回来。
	 */
	it("补了一条、另一条还欠着 → 仍是 partial(不许按 role 取最后一次)", () => {
		const before = [msg("main", OK), msg("extra", FAIL), msg("extra", FAIL)];
		expect(computeStatus(T1, before)).toBe("partial");
		expect(computeStatus(T1, [...before, msg("extra", OK, 1)])).toBe("partial");
		// 两条都补上了才算全到。
		expect(computeStatus(T1, [...before, msg("extra", OK, 1), msg("extra", OK, 2)])).toBe(
			"delivered",
		);
	});

	it("本体补上了、附加还欠着 → 从 failed 翻成 partial", () => {
		const before = [msg("main", FAIL), msg("extra", FAIL)];
		expect(computeStatus(T1, before)).toBe("failed");
		expect(computeStatus(T1, [...before, msg("main", OK, 0)])).toBe("partial");
	});

	it("重投又失败 → 状态不变,按钮继续可按", () => {
		const before = [msg("main", FAIL)];
		expect(computeStatus(T1, [...before, msg("main", FAIL, 0)])).toBe("failed");
	});

	it("同一号补了两次,最后一次说了算(先成后败也认最后那次)", () => {
		const before = [msg("main", OK), msg("extra", FAIL)];
		const twice = [...before, msg("extra", OK, 1), msg("extra", FAIL, 1)];
		expect(computeStatus(T1, twice)).toBe("partial");
	});

	/**
	 * 决策 17 让「本来还有 N 条没发」也落进行里(`result` 缺省)。这样的一号补上之后
	 * 要能翻绿 —— 否则那几条会永远把行钉在 partial 上。
	 */
	it("从没发出去的那一条(没有 result)被补上 → delivered", () => {
		const before = [msg("main", OK), msg("extra")];
		expect(computeStatus(T1, before)).toBe("partial");
		expect(computeStatus(T1, [...before, msg("extra", OK, 1)])).toBe("delivered");
	});

	it("无目标行不受影响,补了也还是 no-targets", () => {
		expect(computeStatus(null, [msg("main"), msg("main", OK, 0)])).toBe("no-targets");
	});
});

describe("computeStatus — 老行一个字不变", () => {
	// 没有 retryOf 时每条消息自成一号,「每号取最后一次」退化成「逐条看自己的结果」。
	// 这几条与 `record.test.ts` 的「四态」同源,搬到这里是为了在改口径时当场照出回归。
	it.each<[string, HistoryMessage[], string]>([
		["全到 → delivered", [msg("main", OK), msg("extra", OK)], "delivered"],
		["本体到了、附加没到 → partial", [msg("main", OK), msg("extra", FAIL)], "partial"],
		["本体没到 → failed", [msg("main", FAIL), msg("extra", OK)], "failed"],
		["本体分两条、第二条失败 → partial", [msg("main", OK), msg("main", FAIL)], "partial"],
		["只有附加项、还失败了 → failed", [msg("extra", FAIL)], "failed"],
		["有目标却一条结果都没有 → failed", [msg("main")], "failed"],
	])("%s", (_name, messages, status) => {
		expect(computeStatus(T1, messages)).toBe(status);
	});

	// `[].every` 恒真 —— 一行消息都没有的有目标行不挡住它就会顶着「已送达」进面板与
	// 今日 KPI。老算法靠「有没有结果」挡,新算法靠「有没有身份」挡,两边都得挡住。
	it("有目标、一条消息都没有 → 不是 delivered", () => {
		expect(computeStatus(T1, [])).toBe("failed");
	});
});
