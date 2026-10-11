/**
 * 问题通知器:听问题表的变化,把 `notify` 为真的问题私聊给主人。
 *
 * - 节流键是 报的人 + code(不含对象),窗口 60 秒;「已恢复」另用一张表、各算各的。
 * - 「真私聊过」= `notifyMaster` 回了 ok。节流时间戳只在送到时才记,否则再送会被自己的节流吞掉。
 * - 没送到、且失败码属于「稍后可重试」的,问题还开着就按 10 秒 / 30 秒 / 60 秒 / 5 分钟 / 15 分钟再送,用完记 warn。
 * - 清掉时只有真私聊过的才补「已恢复：」,引的是当初真发出去的那句;宿主清(来源停下、订阅删了)不补。
 *
 * 全程假时钟。推进用 `advanceTimersByTimeAsync`,别用 `waitFor`(撞上假定时器会死锁)。
 */

import { type DeliveryResult, fail, type Logger, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { deferred } from "../../__tests__/support/track-context";
import { createProblemNotifier } from "../problem-notifier";
import { createProblemTable, type ProblemTable } from "../problem-table";

const sent = (): DeliveryResult => ok({ latencyMs: 1 });

function makeLogger() {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

function setup(
	notifyImpl: (text: string) => Promise<DeliveryResult> = async () => sent(),
	extra: { onNotify?: (text: string) => void } = {},
) {
	const logger = makeLogger();
	const table = createProblemTable({ logger: makeLogger() });
	const notify = vi.fn((text: string) => {
		extra.onNotify?.(text);
		return notifyImpl(text);
	});
	const tracked: Promise<unknown>[] = [];
	const notifier = createProblemNotifier({
		table,
		notify,
		serviceCtx: {
			track: (task) => void tracked.push(task),
			setTimeout: (fn, ms) => {
				const timer = setTimeout(fn, ms);
				return { dispose: () => clearTimeout(timer) };
			},
		},
		logger,
	});
	return { table, notify, notifier, logger, tracked };
}

/** 让已经排上的微任务(发送的回执)跑完。 */
const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function open(table: ProblemTable, over: Partial<Parameters<ProblemTable["report"]>[0]> = {}) {
	table.report({
		reporter: "src",
		code: "auth_lost",
		message: "登录失效了",
		notify: true,
		...over,
	});
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("问题私聊:发不发、发几条", () => {
	it("notify 缺省(假)的问题不私聊", async () => {
		const { table, notify } = setup();
		table.report({ reporter: "src", code: "c", message: "只进表" });
		await flush();
		expect(notify).not.toHaveBeenCalled();
	});

	it("notify 为真:发 message 原文,发送登记进 track", async () => {
		const { table, notify, tracked } = setup();
		open(table);
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("登录失效了");
		expect(tracked).toHaveLength(1);
	});

	it("同 报的人+code 60 秒内的第二条(哪怕关于别的订阅)被吞,不同 code 各发,窗口外重新放行", async () => {
		const { table, notify } = setup();
		open(table, { about: { subscriptionId: "s1" }, code: "stopped", message: "房间 1" });
		await flush();
		open(table, { about: { subscriptionId: "s2" }, code: "stopped", message: "房间 2" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);

		open(table, { code: "other", message: "别的事" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(2);

		await advance(60_000);
		open(table, { about: { subscriptionId: "s3" }, code: "stopped", message: "房间 3" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(3);
		expect(notify).toHaveBeenLastCalledWith("房间 3");
	});

	it("同键有一条正在发:同一秒来的十个对象只发一条", async () => {
		const gate = deferred<DeliveryResult>();
		const { table, notify } = setup(() => gate.promise);
		for (let n = 0; n < 10; n++) {
			open(table, { about: { subscriptionId: `s${n}` }, code: "stopped", message: `房间 ${n}` });
		}
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);
		gate.resolve(sent());
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("只换文案(updated):已经私聊过的不再发", async () => {
		const { table, notify } = setup();
		open(table, { message: "一" });
		await flush();
		await advance(120_000);
		open(table, { message: "二" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("notify 从假变真、且没私聊过:当一次新的开处理", async () => {
		const { table, notify } = setup();
		open(table, { notify: false, message: "先只进表" });
		await flush();
		expect(notify).not.toHaveBeenCalled();
		open(table, { notify: true, message: "现在要说了" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("现在要说了");
	});

	it("notifyMaster 抛错:记 warn、不往外传、不再送", async () => {
		const { table, notify, logger } = setup(async () => {
			throw new Error("通道炸了");
		});
		open(table);
		await flush();
		await advance(20 * 60_000);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalled();
	});
});

describe("没送到的再送", () => {
	it("头一次没送到、10 秒后送到:恰好两次,送到即停;节流时间戳只在送到时记", async () => {
		const results = [fail("unavailable", "连接还没上线"), sent()];
		const { table, notify } = setup(async () => results.shift() ?? sent());
		open(table);
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);

		await advance(9_999);
		expect(notify).toHaveBeenCalledTimes(1);
		await advance(1);
		expect(notify).toHaveBeenCalledTimes(2);

		await advance(20 * 60_000);
		expect(notify).toHaveBeenCalledTimes(2);
	});

	it("再送的间隔是 10 秒、30 秒、60 秒、5 分钟、15 分钟,五次用完记一行 warn 不再试", async () => {
		const { table, notify, logger } = setup(async () => fail("unavailable", "一直连不上"));
		open(table);
		await flush();
		const schedule = [10_000, 30_000, 60_000, 300_000, 900_000];
		let expected = 1;
		for (const gap of schedule) {
			await advance(gap - 1);
			expect(notify).toHaveBeenCalledTimes(expected);
			await advance(1);
			expected += 1;
			expect(notify).toHaveBeenCalledTimes(expected);
		}
		expect(expected).toBe(6);
		const warnsBefore = logger.warn.mock.calls.length;
		await advance(60 * 60_000);
		expect(notify).toHaveBeenCalledTimes(6);
		expect(warnsBefore).toBeGreaterThan(0);
		expect(logger.warn.mock.calls.some((c) => String(c[0]).includes("放弃"))).toBe(true);
	});

	it.each(["unavailable", "timeout", "rate_limited"] as const)("失败码 %s 会再送", async (code) => {
		const results = [fail(code, "稍后"), sent()];
		const { table, notify } = setup(async () => results.shift() ?? sent());
		open(table);
		await flush();
		await advance(10_000);
		expect(notify).toHaveBeenCalledTimes(2);
	});

	it.each(["not_configured", "invalid", "indeterminate", "unknown", "not_found"] as const)(
		"失败码 %s 不再送",
		async (code) => {
			const { table, notify } = setup(async () => fail(code, "不会好"));
			open(table);
			await flush();
			await advance(30 * 60_000);
			expect(notify).toHaveBeenCalledTimes(1);
		},
	);

	it("问题清了:挂着的再送作废", async () => {
		const { table, notify } = setup(async () => fail("unavailable", "没连上"));
		open(table);
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		await advance(30 * 60_000);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("再送发的是那一刻的 message", async () => {
		const results = [fail("unavailable", "没连上"), sent()];
		const { table, notify } = setup(async () => results.shift() ?? sent());
		open(table, { message: "旧的话" });
		await flush();
		open(table, { message: "新的话" });
		await advance(10_000);
		expect(notify).toHaveBeenLastCalledWith("新的话");
	});

	it("再送时同键已经被别的条目送到了:吞掉,不重复", async () => {
		const results = [fail("unavailable", "没连上"), sent()];
		const { table, notify } = setup(async () => results.shift() ?? sent());
		open(table, { about: { subscriptionId: "s1" }, code: "stopped", message: "房间 1" });
		await flush();
		open(table, { about: { subscriptionId: "s2" }, code: "stopped", message: "房间 2" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(2);
		await advance(10_000);
		expect(notify).toHaveBeenCalledTimes(2);
	});

	it("通知器停下:挂着的再送作废,不再听表", async () => {
		const { table, notify, notifier } = setup(async () => fail("unavailable", "没连上"));
		open(table);
		await flush();
		notifier.dispose();
		await advance(30 * 60_000);
		expect(notify).toHaveBeenCalledTimes(1);
		open(table, { code: "other" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);
	});
});

describe("已恢复", () => {
	it("真私聊过的问题被报的人清掉:补「已恢复：」+ 当初真发出去的那句(不是后来换过的文案)", async () => {
		const { table, notify } = setup();
		open(table, { message: "当初那句" });
		await flush();
		open(table, { message: "后来换的文案" });
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenLastCalledWith("已恢复：当初那句");
	});

	it("没真私聊过的(notify 假)清掉不发", async () => {
		const { table, notify } = setup();
		open(table, { notify: false });
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		expect(notify).not.toHaveBeenCalled();
	});

	it("被节流吞掉的那条清掉不发", async () => {
		const { table, notify } = setup();
		open(table, { about: { subscriptionId: "s1" }, code: "stopped", message: "房间 1" });
		open(table, { about: { subscriptionId: "s2" }, code: "stopped", message: "房间 2" });
		await flush();
		notify.mockClear();
		table.resolve({ reporter: "src", about: { subscriptionId: "s2" }, code: "stopped" });
		await flush();
		expect(notify).not.toHaveBeenCalled();
	});

	it("头一次没送到的(没真私聊过)清掉不发", async () => {
		const { table, notify } = setup(async () => fail("not_configured", "没配主人"));
		open(table);
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("报的人明说 notify: false 的清掉不发", async () => {
		const { table, notify } = setup();
		open(table);
		await flush();
		notify.mockClear();
		table.resolve({ reporter: "src", code: "auth_lost" }, { notify: false });
		await flush();
		expect(notify).not.toHaveBeenCalled();
	});

	it("宿主清(来源停下、订阅删了)不发", async () => {
		const { table, notify } = setup();
		open(table, { code: "a", message: "来源级" });
		await advance(60_000);
		open(table, { about: { subscriptionId: "s1" }, code: "b", message: "订阅级" });
		await flush();
		notify.mockClear();
		table.clearReporter("src");
		await flush();
		expect(notify).not.toHaveBeenCalled();

		open(table, { about: { subscriptionId: "s9" }, code: "c", message: "又一条" });
		await flush();
		notify.mockClear();
		table.clearSubscription("s9");
		await flush();
		expect(notify).not.toHaveBeenCalled();
	});

	it("「已恢复」另用一张节流表:问题刚发过,60 秒内修好照样补;同键 60 秒内第二条恢复被吞", async () => {
		const { table, notify } = setup();
		open(table, { about: { subscriptionId: "s1" }, code: "stopped", message: "房间 1" });
		await flush();
		table.resolve({ reporter: "src", about: { subscriptionId: "s1" }, code: "stopped" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenLastCalledWith("已恢复：房间 1");

		// 窗口外,又一条问题送出去,然后在同一个恢复窗口内连着修好两条
		await advance(60_000);
		open(table, { about: { subscriptionId: "s2" }, code: "stopped", message: "房间 2" });
		await flush();
		await advance(60_000);
		open(table, { about: { subscriptionId: "s3" }, code: "stopped", message: "房间 3" });
		await flush();
		notify.mockClear();
		table.resolve({ reporter: "src", about: { subscriptionId: "s2" }, code: "stopped" });
		table.resolve({ reporter: "src", about: { subscriptionId: "s3" }, code: "stopped" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("「已恢复」没送到只记 warn,不再送", async () => {
		const results = [sent(), fail("unavailable", "没连上")];
		const { table, notify, logger } = setup(async () => results.shift() ?? sent());
		open(table);
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		await advance(30 * 60_000);
		expect(notify).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenCalled();
	});

	it("发送还在路上时问题就被清了:送到之后照样算真私聊过,补「已恢复」", async () => {
		const gate = deferred<DeliveryResult>();
		const { table, notify } = setup(() => gate.promise);
		open(table, { message: "在路上" });
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);
		gate.resolve(sent());
		await flush();
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenLastCalledWith("已恢复：在路上");
	});

	it("发送还在路上时被宿主清掉:送到之后不补「已恢复」", async () => {
		const gate = deferred<DeliveryResult>();
		const { table, notify } = setup(() => gate.promise);
		open(table, { message: "在路上" });
		await flush();
		table.clearReporter("src");
		gate.resolve(sent());
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);
	});
});
