/**
 * 拓展详情页那个「上报问题」框背后的记录(ADR-0019 决策 60):每个拓展一段最近 20 条,只在内存。
 *
 * - 满了挤掉最老的 —— 一个系统性的 bug 每条作品记一条,留全了就是一个无底洞;
 * - 按拓展分开 —— 甲拓展刷屏不许把乙拓展那几条挤掉;
 * - 卸载时那一段整个清掉 —— 装回来的是一个新的它,旧账不该挂在新页上。
 * - 记了新的就叫面板重取,**按拓展、在尾沿合并**:一个系统性的 bug 每条作品记一条,不许刷出一串帧。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SubscriptionReportProblem } from "../context.js";
import {
	createReportProblemLog,
	REPORT_PROBLEMS_CHANGED_COALESCE_MS,
	REPORT_PROBLEMS_KEPT,
} from "../report-problems.js";

function problem(extensionId: string, n: number): SubscriptionReportProblem {
	return {
		extensionId,
		at: 1_000 + n,
		kind: "post",
		externalId: `person-${n}`,
		subscriptionIds: [],
		outcome: "dropped",
		reasons: [`第 ${n} 条`],
	};
}

describe("createReportProblemLog", () => {
	it("每个拓展留最近 20 条,新的在前;满了挤掉最老的", () => {
		const log = createReportProblemLog();
		for (let n = 1; n <= 25; n++) log.record(problem("douyin", n));

		const kept = log.list("douyin");
		expect(REPORT_PROBLEMS_KEPT).toBe(20);
		expect(kept).toHaveLength(20);
		expect(kept.map((p) => p.externalId)).toEqual(
			Array.from({ length: 20 }, (_, i) => `person-${25 - i}`),
		);
	});

	it("按拓展分开:一个刷屏挤不掉另一个的", () => {
		const log = createReportProblemLog();
		log.record(problem("kuaishou", 0));
		for (let n = 1; n <= 30; n++) log.record(problem("douyin", n));

		expect(log.list("kuaishou").map((p) => p.externalId)).toEqual(["person-0"]);
		expect(log.list("douyin")).toHaveLength(20);
		expect(log.list("nobody")).toEqual([]);
	});

	it("卸载清空:只清那一个拓展的", () => {
		const log = createReportProblemLog();
		log.record(problem("douyin", 1));
		log.record(problem("kuaishou", 2));

		log.clear("douyin");

		expect(log.list("douyin")).toEqual([]);
		expect(log.list("kuaishou")).toHaveLength(1);
	});

	it("交出去的是一份拷贝:调用方改它不动记录", () => {
		const log = createReportProblemLog();
		log.record(problem("douyin", 1));
		(log.list("douyin") as SubscriptionReportProblem[]).length = 0;
		expect(log.list("douyin")).toHaveLength(1);
	});
});

/**
 * 记了新的一条 → 叫面板重取(`onChanged`,宿主接到 bus 的 `extension-report-problems-changed`)。
 * 自己一个窗口,**不与 `ctx.statusChanged()` 共用**:那一声说的是「拓展的视图变了」,混在一起的话桥每喊
 * 一次都要多拉一遍拓展表,而上报问题每记一条又要多重读一次视图。
 */
describe("记了新的就叫面板重取", () => {
	const W = REPORT_PROBLEMS_CHANGED_COALESCE_MS;
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("一阵 50 条只发一次,落在窗口尾沿;窗口过了再记,另起一发", () => {
		const changed: string[] = [];
		const log = createReportProblemLog({ onChanged: (id) => changed.push(id) });
		for (let n = 1; n <= 50; n++) log.record(problem("douyin", n));
		vi.advanceTimersByTime(W - 1);
		expect(changed).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(changed).toEqual(["douyin"]);

		log.record(problem("douyin", 51));
		vi.advanceTimersByTime(W);
		expect(changed).toEqual(["douyin", "douyin"]);
	});

	/** 窗口不因为又记了一条就往后推 —— 一直在报坏东西的拓展,面板那个框照样按窗口刷新。 */
	it("一直在记也按窗口发,不会被饿死", () => {
		const changed: string[] = [];
		const log = createReportProblemLog({ onChanged: (id) => changed.push(id) });
		for (let t = 0; t < W * 10; t += W / 5) {
			log.record(problem("douyin", t));
			vi.advanceTimersByTime(W / 5);
		}
		expect(changed).toHaveLength(10);
	});

	it("按拓展合并:两个拓展各发各的", () => {
		const changed: string[] = [];
		const log = createReportProblemLog({ onChanged: (id) => changed.push(id) });
		log.record(problem("douyin", 1));
		log.record(problem("kuaishou", 1));
		log.record(problem("douyin", 2));
		vi.advanceTimersByTime(W);
		expect(changed.sort()).toEqual(["douyin", "kuaishou"]);
	});

	it("卸载清掉时挂着的那一发不发了;收摊之后也不发", () => {
		const changed: string[] = [];
		const log = createReportProblemLog({ onChanged: (id) => changed.push(id) });
		log.record(problem("douyin", 1));
		log.clear("douyin");
		log.record(problem("kuaishou", 1));
		log.dispose();
		vi.advanceTimersByTime(W * 10);
		expect(changed).toEqual([]);
	});
});
