/**
 * 问题通知器:听问题表的变化,把 `notify` 为真的问题私聊给主人。
 *
 * - 节流键是 报的人 + code(不含对象),窗口 60 秒;「已恢复」另用一张表、各算各的。
 * - 「真私聊过」= `notifyMaster` 回了 ok。节流时间戳只在送到时才记,否则再送会被自己的节流吞掉。
 * - 没送到、且失败码属于「稍后可重试」的,问题还开着就按 10 秒 / 30 秒 / 60 秒 / 5 分钟 / 15 分钟再送,用完记 warn。
 * - 清掉时只有真私聊过的才补「恢复」:发这条问题自带的 `recoveryMessage`(私聊出去那一刻存下的那句),没带的用通用说法
 *   接当初真发出去的那句;宿主清(来源停下、订阅删了)不补。
 *
 * 全程假时钟。推进用 `advanceTimersByTimeAsync`,别用 `waitFor`(撞上假定时器会死锁)。
 */

import { type DeliveryResult, fail, type Logger, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { deferred } from "../../__tests__/support/track-context";
import { createProblemNotifier, GENERIC_RECOVERY_PREFIX } from "../problem-notifier";
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

/**
 * 被节流吞掉的那一条不能永远没人说(S1):
 * - 吞掉它的那一句所属的问题**还开着、且那一句真送到了**:这条算被那一句盖住了,不补(十个房间同时停监只说一条);
 * - 否则(挡住它的是一条已经清掉的旧事):窗口到点时,它还开着、还要私聊、还没说过,就补说**一次**;
 *   每个键至多挂一个到点的计时器,到点时有好几条符合的只说最早开的那一条。
 * 盖它的那条后来清掉、盖它的那一句没送到这几种,见文件末尾「按节流键对账」。
 */
describe("被节流吞掉的问题:窗口到点时补说", () => {
	const stopped = (n: number) => ({
		about: { subscriptionId: `s${n}` },
		code: "stopped",
		message: `房间 ${n}`,
	});

	// 验红:对账不看窗口(等待时间只算再送那一格),第一、四、五条红;窗口内不标「被盖住」,十个房间那条与旧的节流用例红;
	//       dispose 里不收计时器,最后一条红。
	it("开(送到)→ 清(补已恢复)→ 60 秒内又开:窗口到点补说,主人听到的最后一句不是「好了」", async () => {
		const { table, notify } = setup();
		open(table, { message: "登录失效了" });
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		open(table, { message: "又失效了" });
		await flush();
		expect(notify.mock.calls.map((c) => c[0])).toEqual([
			"登录失效了",
			`${GENERIC_RECOVERY_PREFIX}登录失效了`,
		]);

		await advance(60_000);

		expect(notify.mock.calls.map((c) => c[0])).toEqual([
			"登录失效了",
			`${GENERIC_RECOVERY_PREFIX}登录失效了`,
			"又失效了",
		]);
		// 补说过就不再说
		await advance(10 * 60_000);
		expect(notify).toHaveBeenCalledTimes(3);
	});

	it("十个房间同时停监:仍只有一条,窗口过了也不补(被那一句盖住了)", async () => {
		const { table, notify } = setup();
		for (let n = 0; n < 10; n++) open(table, stopped(n));
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);

		await advance(10 * 60_000);

		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("到点前清掉了:不补说,也没有恢复句", async () => {
		const { table, notify } = setup();
		open(table, { message: "一" });
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		open(table, { message: "二" });
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		notify.mockClear();

		await advance(10 * 60_000);

		expect(notify).not.toHaveBeenCalled();
	});

	it("同键有好几条符合的:每个键只挂一个计时器,到点只说最早开的那一条,其余被它盖住", async () => {
		const { table, notify } = setup();
		open(table, stopped(0));
		await flush();
		table.resolve({ reporter: "src", ...stopped(0) });
		await flush();
		notify.mockClear();
		open(table, stopped(1));
		open(table, stopped(2));
		open(table, stopped(3));
		await flush();
		expect(notify).not.toHaveBeenCalled();

		await advance(60_000);

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("房间 1");
		await advance(10 * 60_000);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("通知器停下:到点的补说作废", async () => {
		const { table, notify, notifier } = setup();
		open(table, { message: "一" });
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		open(table, { message: "二" });
		await flush();
		notify.mockClear();
		expect(vi.getTimerCount()).toBe(1);

		notifier.dispose();
		// 计时器本身也收了(不是只靠到点时看一眼 disposed)
		expect(vi.getTimerCount()).toBe(0);
		await advance(10 * 60_000);

		expect(notify).not.toHaveBeenCalled();
	});
});

/**
 * 发送在路上时「清了又开」(S2):新开的认领这次在途的发送 —— 等于没清过(文案用发出那一刻的,
 * 送达后算新开的这条已说过,不补恢复句);在途的没送到就照新开的这条走再送。
 */
describe("发送在路上时清了又开", () => {
	// 验红:对账时不认领在途的发送(claimSending 不换人),第一条红;在途时被清不记账,第一、三条红。
	it("清了又开:送达后不补「已恢复」,新开的这条算已说过,表里仍开着", async () => {
		const gate = deferred<DeliveryResult>();
		const { table, notify } = setup(() => gate.promise);
		open(table, { message: "风控了" });
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		open(table, { message: "又风控了" });
		await flush();

		gate.resolve(sent());
		await flush();
		await advance(10 * 60_000);

		expect(notify.mock.calls.map((c) => c[0])).toEqual(["风控了"]);
		expect(table.list()).toHaveLength(1);
		// 新开的这条算说过了:它之后真清掉时补一句(用发出那一刻的话)
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		expect(notify).toHaveBeenLastCalledWith(`${GENERIC_RECOVERY_PREFIX}风控了`);
	});

	it("在途的那次没送到:照新开的这条走再送,送到即停", async () => {
		const results: Array<Promise<DeliveryResult>> = [
			Promise.resolve(fail("unavailable", "没连上")),
			Promise.resolve(sent()),
		];
		const gate = deferred<void>();
		const { table, notify } = setup(async () => {
			await gate.promise;
			return (await results.shift()) ?? sent();
		});
		open(table, { message: "风控了" });
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		open(table, { message: "又风控了" });
		await flush();
		gate.resolve();
		await flush();

		await advance(10_000);

		expect(notify.mock.calls.map((c) => c[0])).toEqual(["风控了", "又风控了"]);
		await advance(30 * 60_000);
		expect(notify).toHaveBeenCalledTimes(2);
	});

	it("清了又开又清(最后是清的):送达后补一次「已恢复」", async () => {
		const gate = deferred<DeliveryResult>();
		const { table, notify } = setup(() => gate.promise);
		open(table, { message: "风控了" });
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		open(table, { message: "又风控了" });
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();

		gate.resolve(sent());
		await flush();

		expect(notify.mock.calls.map((c) => c[0])).toEqual([
			"风控了",
			`${GENERIC_RECOVERY_PREFIX}风控了`,
		]);
	});

	it("宿主清了又开(来源重启):同样认领,送达后不补", async () => {
		const gate = deferred<DeliveryResult>();
		const { table, notify } = setup(() => gate.promise);
		open(table, { message: "风控了" });
		await flush();
		table.clearReporter("src");
		open(table, { message: "又风控了" });
		await flush();

		gate.resolve(sent());
		await flush();

		expect(notify.mock.calls.map((c) => c[0])).toEqual(["风控了"]);
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
	it("真私聊过、没带 recoveryMessage 的问题被清掉:通用说法 + 当初真发出去的那句(不是后来换过的文案)", async () => {
		const { table, notify } = setup();
		open(table, { message: "当初那句" });
		await flush();
		open(table, { message: "后来换的文案" });
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenLastCalledWith(`${GENERIC_RECOVERY_PREFIX}当初那句`);
	});

	it("带了 recoveryMessage:清掉时发它,原来的「已恢复：」前缀不再出现", async () => {
		const { table, notify } = setup();
		open(table, { message: "登录失效了", recoveryMessage: "登录好啦" });
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenLastCalledWith("登录好啦");
		expect(notify.mock.calls.some((c) => String(c[0]).startsWith("已恢复："))).toBe(false);
	});

	it("发的是私聊出去那一刻存下的 recoveryMessage,不是后来换过的", async () => {
		const { table, notify } = setup();
		open(table, { message: "当初那句", recoveryMessage: "当初的恢复说法" });
		await flush();
		open(table, { message: "后来换的文案", recoveryMessage: "后来换的恢复说法" });
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		expect(notify).toHaveBeenLastCalledWith("当初的恢复说法");
	});

	it("发送在路上时 recoveryMessage 换了:发的是发出那一刻的,不是路上换的", async () => {
		const gate = deferred<DeliveryResult>();
		const { table, notify } = setup(() => gate.promise);
		open(table, { message: "话", recoveryMessage: "发出时的恢复说法" });
		await flush();
		open(table, { message: "话", recoveryMessage: "路上换的恢复说法" });
		gate.resolve(sent());
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		expect(notify).toHaveBeenLastCalledWith("发出时的恢复说法");
	});

	it("再送时用的是再送那一刻的 recoveryMessage(送到的才算数)", async () => {
		const results = [fail("unavailable", "没连上"), sent()];
		const { table, notify } = setup(async () => results.shift() ?? sent());
		open(table, { message: "话", recoveryMessage: "旧的恢复说法" });
		await flush();
		open(table, { message: "话", recoveryMessage: "新的恢复说法" });
		await advance(10_000);
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		expect(notify).toHaveBeenLastCalledWith("新的恢复说法");
	});

	it("发送还在路上时被清:送到之后发的也是发出那一刻存下的 recoveryMessage", async () => {
		const gate = deferred<DeliveryResult>();
		const { table, notify } = setup(() => gate.promise);
		open(table, { message: "在路上", recoveryMessage: "路上存下的恢复说法" });
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		gate.resolve(sent());
		await flush();
		expect(notify).toHaveBeenLastCalledWith("路上存下的恢复说法");
	});

	it("没真私聊过的(notify 假)清掉不发,哪怕带了 recoveryMessage", async () => {
		const { table, notify } = setup();
		open(table, { notify: false, recoveryMessage: "不会被用到" });
		table.resolve({ reporter: "src", code: "auth_lost" });
		await flush();
		expect(notify).not.toHaveBeenCalled();
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
		expect(notify).toHaveBeenLastCalledWith(`${GENERIC_RECOVERY_PREFIX}房间 1`);

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
		expect(notify).toHaveBeenLastCalledWith(`${GENERIC_RECOVERY_PREFIX}在路上`);
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

/**
 * 「该不该说、什么时候说」按节流键(报的人 + code)对账:每次问题开 / 换 / 清、每次发送落定、每次计时器到点之后,
 * 都重新算这把键欠不欠主人一句话。一条被窗口吞掉的问题算「被盖住」,**当且仅当**吞掉它的那一句所属的问题还开着、
 * 且那一句真送到了;否则它是「欠着的」,窗口一过补说一次(同键欠着好几条只说最早开的,其余改由它盖住)。
 */
describe("按节流键对账", () => {
	const stopped = (n: number) => ({
		about: { subscriptionId: `s${n}` },
		code: "stopped",
		message: `房间 ${n}`,
	});
	const key = (n: number) => ({ reporter: "src", ...stopped(n) });
	const recovered = (n: number) => `${GENERIC_RECOVERY_PREFIX}房间 ${n}`;
	const texts = (notify: { mock: { calls: unknown[][] } }) => notify.mock.calls.map((c) => c[0]);

	// 验红(N1 / R1):「清」之后不对账(closed 分支末尾的 reconcile 去掉),这条与下一条红。
	it("盖它的那条清掉了(窗口已过):被盖住的那条当场补说,不会「说了好了而问题还开着」", async () => {
		const { table, notify } = setup();
		open(table, stopped(0));
		await flush();
		open(table, stopped(1));
		await flush();
		await advance(30 * 60_000);
		expect(texts(notify)).toEqual(["房间 0"]);

		table.resolve(key(0));
		await flush();

		expect(texts(notify)).toEqual(["房间 0", recovered(0), "房间 1"]);
		await advance(30 * 60_000);
		expect(notify).toHaveBeenCalledTimes(3);
		expect(table.list()).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("盖它的那条在窗口内就清掉了:等窗口过完再补说,不提前", async () => {
		const { table, notify } = setup();
		open(table, stopped(0));
		await flush();
		open(table, stopped(1));
		table.resolve(key(0));
		await flush();
		expect(texts(notify)).toEqual(["房间 0", recovered(0)]);

		await advance(59_999);
		expect(notify).toHaveBeenCalledTimes(2);
		await advance(1);

		expect(texts(notify)).toEqual(["房间 0", recovered(0), "房间 1"]);
	});

	// 验红(N2 / S-1):窗口内「被盖住」改成认同键任何一条开着且说过的(不看是不是吞掉它的那一句),这条红。
	it("盖它的其实是一条已经清掉的旧事留下的窗口:同键另有一条老早说过、还开着的也不算盖住,到点补说", async () => {
		const { table, notify } = setup();
		open(table, stopped(0));
		await flush();
		await advance(2 * 60 * 60_000);
		open(table, stopped(1));
		await flush();
		table.resolve(key(1));
		await flush();
		open(table, stopped(2));
		await flush();
		expect(texts(notify)).toEqual(["房间 0", "房间 1", recovered(1)]);

		await advance(60_000);

		expect(texts(notify)).toEqual(["房间 0", "房间 1", recovered(1), "房间 2"]);
		await advance(30 * 60_000);
		expect(notify).toHaveBeenCalledTimes(4);
	});

	// 验红(N3 / S-2):在途的那一发也算盖住(发送落定后不重新对账同键其余的),这条红。
	it("十个房间里先发的那条没送到、再送之前它自己清了:轮到欠着的下一条,档位沿用这把键的", async () => {
		const { table, notify } = setup(async () => fail("unavailable", "没连上"));
		for (let n = 0; n < 10; n++) open(table, stopped(n));
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);
		table.resolve(key(0));
		await flush();
		expect(notify).toHaveBeenCalledTimes(1);

		// 第一档 10 秒:到点轮到房间 1
		await advance(10_000);
		expect(texts(notify)).toEqual(["房间 0", "房间 1"]);
		// 第二档 30 秒(不是从头数的 10 秒)
		await advance(29_999);
		expect(notify).toHaveBeenCalledTimes(2);
		await advance(1);
		expect(texts(notify)).toEqual(["房间 0", "房间 1", "房间 1"]);
	});

	it("同上,再送送到了:其余几条改由它盖住,不再各说一遍", async () => {
		const results = [fail("unavailable", "没连上")];
		const { table, notify } = setup(async () => results.shift() ?? sent());
		for (let n = 0; n < 10; n++) open(table, stopped(n));
		await flush();
		table.resolve(key(0));
		await flush();

		await advance(60 * 60_000);

		expect(texts(notify)).toEqual(["房间 0", "房间 1"]);
		expect(table.list()).toHaveLength(9);
		expect(vi.getTimerCount()).toBe(0);
	});

	// 验红:不可重试的失败不让这把键停下(照样排下一档再送),这条红。
	it("没送到且不可重试(没配主人):同键欠着的其余几条不各试一遍;之后新开一条才再试一次,说的是欠得最久的", async () => {
		const results = [fail("not_configured", "没配主人")];
		const { table, notify } = setup(async () => results.shift() ?? sent());
		for (let n = 0; n < 10; n++) open(table, stopped(n));
		await flush();
		await advance(60 * 60_000);
		// 不可重试:同键此刻欠着的十条都不再试
		expect(notify).toHaveBeenCalledTimes(1);
		table.resolve(key(0));
		await advance(60 * 60_000);
		expect(notify).toHaveBeenCalledTimes(1);

		// 之后新开的照常试;这回送到了,其余的由它盖住
		open(table, stopped(10));
		await flush();
		expect(texts(notify)).toEqual(["房间 0", "房间 1"]);
		await advance(60 * 60_000);
		expect(notify).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("一直没配主人:十个房间同时停监只试一次,之后每新开一条各试一次", async () => {
		const { table, notify } = setup(async () => fail("not_configured", "没配主人"));
		for (let n = 0; n < 10; n++) open(table, stopped(n));
		await advance(60 * 60_000);
		expect(notify).toHaveBeenCalledTimes(1);
		open(table, stopped(10));
		await advance(60 * 60_000);
		expect(notify).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("同键欠着好几条:只说最早开的那一条,其余改由它盖住;它清掉再轮到下一条", async () => {
		const { table, notify } = setup();
		for (let n = 0; n < 4; n++) open(table, stopped(n));
		await flush();
		await advance(10 * 60_000);
		table.resolve(key(0));
		await flush();
		expect(texts(notify)).toEqual(["房间 0", recovered(0), "房间 1"]);
		await advance(10 * 60_000);
		expect(notify).toHaveBeenCalledTimes(3);

		table.resolve(key(1));
		await flush();
		expect(texts(notify)).toEqual(["房间 0", recovered(0), "房间 1", recovered(1), "房间 2"]);
		await advance(10 * 60_000);
		expect(notify).toHaveBeenCalledTimes(5);
	});

	it("没说过的那条(被盖住的)清掉:不补恢复句,盖着的关系照旧", async () => {
		const { table, notify } = setup();
		for (let n = 0; n < 3; n++) open(table, stopped(n));
		await flush();
		table.resolve(key(1));
		await advance(10 * 60_000);
		expect(texts(notify)).toEqual(["房间 0"]);
	});

	// 验红:窗口内不看时间直接发(reconcile 里去掉窗口判断),这条红。
	it("同一把键,上一句送到之后 60 秒内不再有问题私聊(「已恢复」另算)", async () => {
		const deliveredAt: number[] = [];
		const { table } = setup(async () => sent(), {
			onNotify: (text) => {
				if (!text.startsWith(GENERIC_RECOVERY_PREFIX)) deliveredAt.push(Date.now());
			},
		});
		// 一分钟里十几件事:开、清、再开、盖它的清掉
		for (let round = 0; round < 6; round++) {
			open(table, stopped(round));
			await advance(7_000);
			open(table, stopped(round + 100));
			await advance(7_000);
			table.resolve(key(round));
			await advance(7_000);
		}
		// 盖着别人的那几条每 20 秒清掉一条:每清一条就欠下一句,但只能一个窗口说一句
		for (let round = 0; round < 6; round++) {
			table.resolve(key(round + 100));
			await advance(20_000);
		}
		await advance(30 * 60_000);

		expect(deliveredAt.length).toBeGreaterThan(3);
		for (let i = 1; i < deliveredAt.length; i++) {
			expect((deliveredAt[i] ?? 0) - (deliveredAt[i - 1] ?? 0)).toBeGreaterThanOrEqual(60_000);
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("窗口之外新开的当场说:同键有一条说过的开着也不挡", async () => {
		const { table, notify } = setup();
		open(table, stopped(0));
		await flush();
		await advance(60_000);
		open(table, stopped(1));
		await flush();
		expect(texts(notify)).toEqual(["房间 0", "房间 1"]);
	});

	it("五档再送用完:同键欠着的其余几条不再各试一遍,也不留计时器", async () => {
		const { table, notify, logger } = setup(async () => fail("unavailable", "一直连不上"));
		for (let n = 0; n < 10; n++) open(table, stopped(n));
		await flush();

		await advance(3 * 60 * 60_000);

		expect(notify).toHaveBeenCalledTimes(6);
		expect(logger.warn.mock.calls.filter((c) => String(c[0]).includes("放弃"))).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("挂着再送时同键新开一条:当场再试一次(不等那一档),送到后其余的由它盖住", async () => {
		const results = [fail("unavailable", "没连上")];
		const { table, notify } = setup(async () => results.shift() ?? sent());
		open(table, stopped(0));
		await flush();
		open(table, stopped(1));
		await flush();
		// 说的是最早开的那一条
		expect(texts(notify)).toEqual(["房间 0", "房间 0"]);
		await advance(60 * 60_000);
		expect(notify).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("从「不要私聊」换成「要私聊」且没说过:当场说,清掉时补恢复句", async () => {
		const { table, notify } = setup();
		open(table, { code: "risk", message: "风控了", notify: false, recoveryMessage: "解除啦" });
		await advance(5 * 60_000);
		expect(notify).not.toHaveBeenCalled();

		open(table, { code: "risk", message: "风控了", notify: true, recoveryMessage: "解除啦" });
		await flush();
		expect(texts(notify)).toEqual(["风控了"]);

		// 再换回不要私聊:不撤回,也不再说;清掉时照补
		open(table, { code: "risk", message: "风控了", notify: false, recoveryMessage: "解除啦" });
		open(table, { code: "risk", message: "风控了", notify: true, recoveryMessage: "解除啦" });
		await advance(10 * 60_000);
		expect(notify).toHaveBeenCalledTimes(1);
		table.resolve({ reporter: "src", code: "risk" });
		await flush();
		expect(texts(notify)).toEqual(["风控了", "解除啦"]);
	});

	it("在窗口内从「不要私聊」换成「要私聊」:照窗口的规矩(盖它的那条已清,到点补说)", async () => {
		const { table, notify } = setup();
		open(table, stopped(0));
		await flush();
		open(table, { ...stopped(1), notify: false });
		table.resolve(key(0));
		await flush();
		open(table, { ...stopped(1), notify: true });
		await flush();
		expect(texts(notify)).toEqual(["房间 0", recovered(0)]);
		await advance(60_000);
		expect(texts(notify)).toEqual(["房间 0", recovered(0), "房间 1"]);
	});

	// 记一笔 7(钉现状):在途时「清(补恢复)→ 以不带私聊重开」。重开的那条明说不要私聊,不认领那句说出去的话;
	// 送达后照旧对已清的那条补恢复句 —— 与「那一发瞬间送到」时的次序(说 → 清并补恢复 → 静默重开)结果一致。
	it("在途时清了、又以不带私聊重开:不认领,送达后照补恢复句,重开的那条没说过", async () => {
		const gate = deferred<DeliveryResult>();
		const { table, notify } = setup(() => gate.promise);
		open(table, { message: "风控了" });
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });
		open(table, { message: "又风控了", notify: false });
		await flush();

		gate.resolve(sent());
		await flush();

		expect(texts(notify)).toEqual(["风控了", `${GENERIC_RECOVERY_PREFIX}风控了`]);
		expect(table.list()).toHaveLength(1);
		// 重开的那条没说过:清掉不再补
		table.resolve({ reporter: "src", code: "auth_lost" });
		await advance(10 * 60_000);
		expect(notify).toHaveBeenCalledTimes(2);
	});

	// 验红:这条由三道闸合钉(落定看 disposed、对账看 disposed、dispose 清账),单去一道不红;三道同时去掉才红。
	it("dispose 之后:没有计时器;在途的发送没送到,也不排再送", async () => {
		const gate = deferred<DeliveryResult>();
		const { table, notify, notifier } = setup(() => gate.promise);
		for (let n = 0; n < 3; n++) open(table, stopped(n));
		await flush();

		notifier.dispose();
		expect(vi.getTimerCount()).toBe(0);
		gate.resolve(fail("unavailable", "没连上"));
		await flush();

		expect(vi.getTimerCount()).toBe(0);
		await advance(60 * 60_000);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	// 验红:发送落定时不看 disposed(照样记账),这条红(多出一句「已恢复」)。
	it("dispose 之后:在途时已被清掉的那条送到了,也不补「已恢复」、不记 warn", async () => {
		const gate = deferred<DeliveryResult>();
		const { table, notify, notifier, logger } = setup(() => gate.promise);
		open(table, { message: "在路上" });
		await flush();
		table.resolve({ reporter: "src", code: "auth_lost" });

		notifier.dispose();
		gate.resolve(sent());
		await advance(60 * 60_000);

		expect(notify).toHaveBeenCalledTimes(1);
		expect(logger.warn).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
