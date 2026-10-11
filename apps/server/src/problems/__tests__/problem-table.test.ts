/**
 * 问题表:内存里按 (报的人, 关于谁, code) 记一条;同键只换文案,`since` 不动。
 *
 * - 每次变化当场叫订阅方(给问题通知器),「面板重取」那一声按报的人在尾沿合并;
 * - 报的人停下、订阅删了,是宿主在清:变更带 `notify: false`,不许补「已恢复」。
 */

import type { Logger } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	createProblemTable,
	PROBLEMS_CHANGED_COALESCE_MS,
	type ProblemChange,
} from "../problem-table";

function makeLogger() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} satisfies Logger;
}

function makeTable(onChanged?: (reporter: string) => void) {
	const logger = makeLogger();
	let at = Date.parse("2026-10-11T00:00:00.000Z");
	const table = createProblemTable({
		logger,
		onChanged,
		now: () => new Date(at),
	});
	const changes: ProblemChange[] = [];
	table.subscribe((c) => changes.push(c));
	return {
		table,
		logger,
		changes,
		/** 把表里的时钟往后拨。 */
		advance(ms: number) {
			at += ms;
		},
	};
}

const key = { reporter: "src-a", code: "auth_lost" };

describe("createProblemTable 的记与清", () => {
	it("报一条:进表、since 是此刻的 ISO 时间、变更是 opened 且带上 notify", () => {
		const { table, changes } = makeTable();
		table.report({ ...key, message: "登录失效", notify: true });

		expect(table.list()).toEqual([
			{
				reporter: "src-a",
				code: "auth_lost",
				message: "登录失效",
				since: "2026-10-11T00:00:00.000Z",
			},
		]);
		expect(changes).toEqual([
			{
				kind: "opened",
				notify: true,
				problem: {
					reporter: "src-a",
					code: "auth_lost",
					message: "登录失效",
					since: "2026-10-11T00:00:00.000Z",
				},
			},
		]);
	});

	it("notify 缺省是不私聊", () => {
		const { table, changes } = makeTable();
		table.report({ ...key, message: "x" });
		expect(changes[0]?.notify).toBe(false);
	});

	it("同键再报:只换文案,since 不动,变更是 updated", () => {
		const { table, changes, advance } = makeTable();
		table.report({ ...key, message: "第一句", notify: true });
		advance(5_000);
		table.report({ ...key, message: "第二句", notify: true });

		expect(table.list()).toHaveLength(1);
		expect(table.list()[0]?.message).toBe("第二句");
		expect(table.list()[0]?.since).toBe("2026-10-11T00:00:00.000Z");
		expect(changes.map((c) => c.kind)).toEqual(["opened", "updated"]);
		expect(changes[1]?.problem.message).toBe("第二句");
	});

	it("同键再报而文案与 notify 都没变:不算变化,不叫订阅方", () => {
		const { table, changes } = makeTable();
		table.report({ ...key, message: "同一句", notify: true });
		table.report({ ...key, message: "同一句", notify: true });
		expect(changes).toHaveLength(1);
	});

	it("recoveryMessage:变更里带着它;同键再报时它变了也算一次 updated;没变不算", () => {
		const { table, changes } = makeTable();
		table.report({ ...key, message: "话", notify: true, recoveryMessage: "好啦" });
		expect(changes[0]).toMatchObject({ kind: "opened", recoveryMessage: "好啦" });

		table.report({ ...key, message: "话", notify: true, recoveryMessage: "好啦" });
		expect(changes).toHaveLength(1);

		table.report({ ...key, message: "话", notify: true, recoveryMessage: "换个说法" });
		expect(changes).toHaveLength(2);
		expect(changes[1]).toMatchObject({ kind: "updated", recoveryMessage: "换个说法" });

		// 不再给 = 换成没有这一格
		table.report({ ...key, message: "话", notify: true });
		expect(changes).toHaveLength(3);
		expect(changes[2]?.recoveryMessage).toBeUndefined();
		expect("recoveryMessage" in (changes[2] ?? {})).toBe(false);
	});

	it("recoveryMessage 不在对外的 Problem 上:list() 里没有它", () => {
		const { table } = makeTable();
		table.report({ ...key, message: "话", notify: true, recoveryMessage: "好啦" });
		expect(table.list()[0]).not.toHaveProperty("recoveryMessage");
	});

	it("清掉的变更也带着当时的 recoveryMessage", () => {
		const { table, changes } = makeTable();
		table.report({ ...key, message: "话", notify: true, recoveryMessage: "好啦" });
		table.resolve(key);
		expect(changes.at(-1)).toMatchObject({ kind: "closed", recoveryMessage: "好啦" });
	});

	it("键由 (报的人, 关于谁, code) 三格合成:换任何一格都是另一条", () => {
		const { table } = makeTable();
		table.report({ reporter: "a", code: "c", message: "1" });
		table.report({ reporter: "b", code: "c", message: "2" });
		table.report({ reporter: "a", code: "d", message: "3" });
		table.report({ reporter: "a", about: { subscriptionId: "s1" }, code: "c", message: "4" });
		table.report({ reporter: "a", about: { subscriptionId: "s2" }, code: "c", message: "5" });
		expect(table.list()).toHaveLength(5);
	});

	it("list 按 since 先后,交出去的是拷贝", () => {
		const { table, advance } = makeTable();
		table.report({ reporter: "a", code: "first", message: "1" });
		advance(1_000);
		table.report({ reporter: "a", code: "second", message: "2" });

		expect(table.list().map((p) => p.code)).toEqual(["first", "second"]);
		const copy = table.list() as unknown as { message: string }[];
		const first = copy[0];
		if (first) first.message = "被外面改了";
		copy.length = 0;
		expect(table.list()).toHaveLength(2);
		expect(table.list()[0]?.message).toBe("1");
	});

	it("resolve:清掉这一条,变更是 closed,notify 缺省为真;给 false 就带 false", () => {
		const { table, changes } = makeTable();
		table.report({ ...key, message: "x", notify: true });
		table.resolve(key);
		table.report({ ...key, message: "x", notify: true });
		table.resolve(key, { notify: false });

		expect(table.list()).toEqual([]);
		expect(changes.filter((c) => c.kind === "closed").map((c) => c.notify)).toEqual([true, false]);
		expect(changes.find((c) => c.kind === "closed")?.problem.message).toBe("x");
	});

	it("resolve 一条表里没有的:什么都不发生", () => {
		const { table, changes } = makeTable();
		table.report({ reporter: "a", code: "c", message: "x" });
		table.resolve({ reporter: "a", code: "nope" });
		table.resolve({ reporter: "a", about: { subscriptionId: "s1" }, code: "c" });
		expect(table.list()).toHaveLength(1);
		expect(changes).toHaveLength(1);
	});

	it("clearReporter:只清这个报的人名下的,每条带 notify: false", () => {
		const { table, changes } = makeTable();
		table.report({ reporter: "a", code: "c1", message: "1", notify: true });
		table.report({ reporter: "a", about: { subscriptionId: "s1" }, code: "c2", message: "2" });
		table.report({ reporter: "b", code: "c1", message: "3" });
		changes.length = 0;

		table.clearReporter("a");

		expect(table.list().map((p) => p.reporter)).toEqual(["b"]);
		expect(changes.map((c) => [c.kind, c.notify, c.problem.reporter])).toEqual([
			["closed", false, "a"],
			["closed", false, "a"],
		]);
	});

	it("clearSubscription:只清关于这条订阅的(不看报的人),每条带 notify: false", () => {
		const { table, changes } = makeTable();
		table.report({ reporter: "a", about: { subscriptionId: "s1" }, code: "c", message: "1" });
		table.report({ reporter: "b", about: { subscriptionId: "s1" }, code: "c", message: "2" });
		table.report({ reporter: "a", about: { subscriptionId: "s2" }, code: "c", message: "3" });
		table.report({ reporter: "a", code: "c", message: "4" });
		changes.length = 0;

		table.clearSubscription("s1");

		expect(table.list().map((p) => p.message)).toEqual(["3", "4"]);
		expect(changes).toHaveLength(2);
		expect(changes.every((c) => c.kind === "closed" && !c.notify)).toBe(true);
	});

	it("订阅方抛错不影响表,也不影响别的订阅方", () => {
		const { table, logger } = makeTable();
		const seen: string[] = [];
		table.subscribe(() => {
			throw new Error("订阅方坏了");
		});
		table.subscribe((c) => seen.push(c.kind));

		expect(() => table.report({ reporter: "a", code: "c", message: "x" })).not.toThrow();
		expect(table.list()).toHaveLength(1);
		expect(seen).toEqual(["opened"]);
		expect(logger.warn).toHaveBeenCalled();
	});

	it("subscribe 交回的 Disposable 摘掉后不再叫", () => {
		const { table } = makeTable();
		const seen: string[] = [];
		const handle = table.subscribe((c) => seen.push(c.kind));
		table.report({ reporter: "a", code: "c", message: "x" });
		handle.dispose();
		table.report({ reporter: "a", code: "d", message: "y" });
		expect(seen).toEqual(["opened"]);
	});

	it("核心自己记一行日志:开 warn、清 info、只换文案 debug", () => {
		const { table, logger } = makeTable();
		table.report({ ...key, message: "开" });
		expect(logger.warn).toHaveBeenCalledTimes(1);
		table.report({ ...key, message: "换" });
		expect(logger.debug).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		table.resolve(key);
		expect(logger.info).toHaveBeenCalledTimes(1);
	});
});

/**
 * 「这个报的人名下的问题变了」按报的人在尾沿合并:第一次起算,窗口里再变不往后推,窗口到了只叫一次。
 * 订阅方那一路不合并(上面的用例已经钉了「当场叫」)。
 */
describe("createProblemTable 的 onChanged 合并", () => {
	const W = PROBLEMS_CHANGED_COALESCE_MS;
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("窗口里连变几次:窗口到了只叫一次", () => {
		const onChanged = vi.fn();
		const { table } = makeTable(onChanged);
		table.report({ reporter: "a", code: "c1", message: "1" });
		table.report({ reporter: "a", code: "c2", message: "2" });
		table.resolve({ reporter: "a", code: "c1" });
		expect(onChanged).not.toHaveBeenCalled();

		vi.advanceTimersByTime(W);
		expect(onChanged).toHaveBeenCalledTimes(1);
		expect(onChanged).toHaveBeenCalledWith("a");
	});

	it("窗口里再变不往后推:从第一次变起算 W 就发", () => {
		const onChanged = vi.fn();
		const { table } = makeTable(onChanged);
		table.report({ reporter: "a", code: "c1", message: "1" });
		vi.advanceTimersByTime(W - 50);
		table.report({ reporter: "a", code: "c2", message: "2" });
		vi.advanceTimersByTime(50);
		expect(onChanged).toHaveBeenCalledTimes(1);
	});

	it("按报的人各算各的窗口", () => {
		const onChanged = vi.fn();
		const { table } = makeTable(onChanged);
		table.report({ reporter: "a", code: "c", message: "1" });
		table.report({ reporter: "b", code: "c", message: "2" });
		vi.advanceTimersByTime(W);
		expect(onChanged.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
	});

	it("发完之后再变:开新窗口再叫一次", () => {
		const onChanged = vi.fn();
		const { table } = makeTable(onChanged);
		table.report({ reporter: "a", code: "c", message: "1" });
		vi.advanceTimersByTime(W);
		table.report({ reporter: "a", code: "c", message: "2" });
		vi.advanceTimersByTime(W);
		expect(onChanged).toHaveBeenCalledTimes(2);
	});

	it("同键再报而什么都没变:不开窗口", () => {
		const onChanged = vi.fn();
		const { table } = makeTable(onChanged);
		table.report({ reporter: "a", code: "c", message: "1" });
		vi.advanceTimersByTime(W);
		table.report({ reporter: "a", code: "c", message: "1" });
		vi.advanceTimersByTime(W);
		expect(onChanged).toHaveBeenCalledTimes(1);
	});

	it("宿主清也叫(按它清掉的那个报的人)", () => {
		const onChanged = vi.fn();
		const { table } = makeTable(onChanged);
		table.report({ reporter: "a", about: { subscriptionId: "s1" }, code: "c", message: "1" });
		vi.advanceTimersByTime(W);
		onChanged.mockClear();

		table.clearSubscription("s1");
		vi.advanceTimersByTime(W);
		expect(onChanged).toHaveBeenCalledWith("a");

		onChanged.mockClear();
		table.report({ reporter: "b", code: "c", message: "1" });
		vi.advanceTimersByTime(W);
		onChanged.mockClear();
		table.clearReporter("b");
		vi.advanceTimersByTime(W);
		expect(onChanged).toHaveBeenCalledWith("b");
	});

	it("dispose:挂着的那一发不发了", () => {
		const onChanged = vi.fn();
		const { table } = makeTable(onChanged);
		table.report({ reporter: "a", code: "c", message: "1" });
		table.dispose();
		vi.advanceTimersByTime(W * 2);
		expect(onChanged).not.toHaveBeenCalled();
	});

	it("dispose 之后再报的也不再叫", () => {
		const onChanged = vi.fn();
		const { table } = makeTable(onChanged);
		table.dispose();
		table.report({ reporter: "a", code: "c", message: "1" });
		vi.advanceTimersByTime(W * 2);
		expect(onChanged).not.toHaveBeenCalled();
	});

	it("onChanged 抛错记一行 warn(带报的人),别的报的人照发", () => {
		const onChanged = vi.fn((reporter: string) => {
			if (reporter === "a") throw new Error("面板那头坏了");
		});
		const { table, logger } = makeTable(onChanged);
		table.report({ reporter: "a", code: "c", message: "1" });
		table.report({ reporter: "b", code: "c", message: "1" });
		vi.advanceTimersByTime(W);
		expect(onChanged.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
		const warns = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0]));
		expect(warns).toContain("[problems] 通知「问题变了」失败 reporter=a: 面板那头坏了");
	});

	it("onChanged 抛错不带倒表", () => {
		const onChanged = vi.fn(() => {
			throw new Error("面板那头坏了");
		});
		const { table } = makeTable(onChanged);
		table.report({ reporter: "a", code: "c", message: "1" });
		expect(() => vi.advanceTimersByTime(W)).not.toThrow();
	});
});
