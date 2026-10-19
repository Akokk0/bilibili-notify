/**
 * 连接探测:节奏(每 60 秒一轮)、连续两次不通才算断、状态变了才写盘、
 * 各连接并行与单次限时、`rate_limited` 不算失败也不算通。
 *
 * 用假定时器、假派发器与假的 `recordProbeState`;假的写会同步改连接表里的 `probeState`,
 * 下一轮读到的就是盘上的现状。
 */

import {
	type Connection,
	type ConnectionCapabilities,
	type ConnectionProbeState,
	fail,
	ok,
	type ProbeResult,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ZodType, z } from "zod";
import { t } from "../../i18n/index.js";
import { createConnectionProbeEngine } from "../connection-probe-engine.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function connectionOf(id: string, extra: Partial<Connection> = {}): Connection {
	return {
		id,
		name: "bot",
		enabled: true,
		adapterKey: "onebot",
		platform: "onebot",
		settings: {},
		...extra,
	} as Connection;
}

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

function setup(
	connections: Connection[],
	probes: Record<string, (() => Promise<ProbeResult>) | undefined>,
	opts: {
		capabilities?: ConnectionCapabilities;
		probeCapabilities?: () => Promise<ConnectionCapabilities | undefined>;
		/** 主人私聊目标挂在哪条连接上。 */
		master?: string;
		/** 哪些适配器键在场;缺省都在场。 */
		present?: (adapterKey: string) => boolean;
		/** 适配器的设置规则;缺省什么都收。 */
		schema?: ZodType;
	} = {},
) {
	const report = vi.fn();
	const resolve = vi.fn();
	const probeConnection = vi.fn(async (id: string) => {
		const probe = probes[id];
		return probe ? probe() : ok({ latencyMs: 1 });
	});
	const written: Array<{ id: string; state: ConnectionProbeState }> = [];
	const recordProbeState = vi.fn(async (id: string, state: ConnectionProbeState) => {
		written.push({ id, state });
		const target = connections.find((c) => c.id === id);
		if (target) target.probeState = state;
	});
	const probeConnectionCapabilities = vi.fn(opts.probeCapabilities ?? (async () => undefined));
	const abort = new AbortController();
	const tracked: Promise<unknown>[] = [];
	const log = logger();
	const engine = createConnectionProbeEngine({
		getConnections: () => connections,
		dispatcher: {
			probeConnection,
			connectionCapabilities: () => opts.capabilities,
			probeConnectionCapabilities,
		},
		recordProbeState,
		problems: { report, resolve },
		masterConnectionId: () => opts.master,
		adapterOf: (key) =>
			(opts.present ?? (() => true))(key)
				? { settingsSchema: opts.schema ?? z.unknown() }
				: undefined,
		serviceCtx: { signal: abort.signal, track: (task) => void tracked.push(task) },
		logger: log,
	});
	return {
		report,
		resolve,
		engine,
		probeConnection,
		recordProbeState,
		written,
		abort,
		tracked,
		log,
		probeConnectionCapabilities,
	};
}

const MINUTE = 60_000;
/** 推进一整分钟(一轮),并让这一轮的异步收尾都落定。 */
const oneRound = () => vi.advanceTimersByTimeAsync(MINUTE);

describe("ConnectionProbeEngine", () => {
	let engine: { dispose(): void } | undefined;
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		engine?.dispose();
		engine = undefined;
		vi.useRealTimers();
	});

	it("开机探一轮,此后每 60 秒一轮", async () => {
		const c = setup([connectionOf(A)], {});
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(0);
		expect(c.probeConnection).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(MINUTE - 1);
		expect(c.probeConnection).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(c.probeConnection).toHaveBeenCalledTimes(2);
	});

	it("一次不通:不写盘", async () => {
		const c = setup([connectionOf(A)], { [A]: async () => fail("unavailable", "连不上") });
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(0);
		expect(c.probeConnection).toHaveBeenCalledTimes(1);
		expect(c.recordProbeState).not.toHaveBeenCalled();
	});

	it("连续两次不通:写一次 unreachable,原话进 message", async () => {
		const c = setup([connectionOf(A)], { [A]: async () => fail("unavailable", "连不上") });
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(0);
		await oneRound();
		expect(c.written).toEqual([
			{
				id: A,
				state: { status: "unreachable", lastCheckedAt: expect.any(String), message: "连不上" },
			},
		]);
		await oneRound();
		await oneRound();
		expect(c.recordProbeState).toHaveBeenCalledTimes(1);
	});

	it("中间通过一次,失败的计数清零:不通、通、不通不算断", async () => {
		const results = [
			fail("unavailable", "x"),
			ok({ latencyMs: 2 }),
			fail("unavailable", "x"),
		] as ProbeResult[];
		const c = setup([connectionOf(A)], {
			[A]: async () => results.shift() ?? ok({ latencyMs: 2 }),
		});
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(0);
		await oneRound();
		await oneRound();
		expect(c.written.map((w) => w.state.status)).toEqual(["reachable"]);
	});

	it("已经是 reachable 的连接,偶发一次不通再通:一笔都不写", async () => {
		const results = [fail("unavailable", "x"), ok({ latencyMs: 2 })] as ProbeResult[];
		const known = connectionOf(A, {
			probeState: { status: "reachable", lastCheckedAt: "2026-06-06T00:00:00.000Z" },
		});
		const c = setup([known], { [A]: async () => results.shift() ?? ok({ latencyMs: 2 }) });
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(0);
		await oneRound();
		await oneRound();
		expect(c.recordProbeState).not.toHaveBeenCalled();
	});

	it("断着探通了:写一次 reachable 带耗时", async () => {
		const results = [
			fail("unavailable", "x"),
			fail("unavailable", "x"),
			ok({ latencyMs: 9 }),
		] as ProbeResult[];
		const c = setup([connectionOf(A)], {
			[A]: async () => results.shift() ?? ok({ latencyMs: 9 }),
		});
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(0);
		await oneRound();
		await oneRound();
		expect(c.written.map((w) => w.state)).toEqual([
			{ status: "unreachable", lastCheckedAt: expect.any(String), message: "x" },
			{ status: "reachable", lastCheckedAt: expect.any(String), latencyMs: 9 },
		]);
	});

	it("一直通:多轮只写第一笔", async () => {
		const c = setup([connectionOf(A)], {});
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(0);
		await oneRound();
		await oneRound();
		await oneRound();
		expect(c.probeConnection).toHaveBeenCalledTimes(4);
		expect(c.recordProbeState).toHaveBeenCalledTimes(1);
		expect(c.written[0]?.state.status).toBe("reachable");
	});

	it("探不了的连接(unsupported):变成它时写一次,之后不再写", async () => {
		const c = setup([connectionOf(A)], { [A]: async () => fail("unsupported", "no probe") });
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(0);
		await oneRound();
		await oneRound();
		expect(c.written).toEqual([
			{ id: A, state: { status: "unsupported", lastCheckedAt: expect.any(String) } },
		]);
	});

	it("各连接并行探:一条卡住,别的连接照样在这一轮探到", async () => {
		const c = setup([connectionOf(A), connectionOf(B)], {
			[A]: () => new Promise<ProbeResult>(() => {}),
		});
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(0);
		expect(c.probeConnection).toHaveBeenCalledWith(B);
		expect(c.written.map((w) => w.id)).toEqual([B]);
	});

	it("单次探测超过 30 秒算一次失败(超时),连续两次就断", async () => {
		const c = setup([connectionOf(A)], { [A]: () => new Promise<ProbeResult>(() => {}) });
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(29_999);
		expect(c.recordProbeState).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(31_000 + MINUTE);
		expect(c.written.map((w) => w.state.status)).toEqual(["unreachable"]);
		// 超时那条失败的原话来自字典,不是写死在代码里。
		expect(c.written[0]?.state.message).toBe(t("connection.probe.timeout"));
		expect(c.written[0]?.state.message).toBe("探测超时");
	});

	it("限时只罩连通探测:通了之后补探能力慢过 30 秒,不算超时", async () => {
		const c = setup(
			[connectionOf(A)],
			{},
			{
				capabilities: {
					atAll: { state: "unknown" },
					inbound: { state: "unknown" },
					nativeShare: { state: "unknown" },
				},
				probeCapabilities: () =>
					new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 40_000)),
			},
		);
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(41_000);
		expect(c.probeConnectionCapabilities).toHaveBeenCalledTimes(1);
		expect(c.written.map((w) => w.state.status)).toEqual(["reachable"]);
	});

	it("rate_limited 不算失败也不算通:计数不动、不写盘,记一行 warn", async () => {
		const results = [
			fail("unavailable", "x"),
			fail("rate_limited", "限流"),
			fail("rate_limited", "限流"),
			fail("unavailable", "x"),
		] as ProbeResult[];
		const c = setup([connectionOf(A)], {
			[A]: async () => results.shift() ?? ok({ latencyMs: 1 }),
		});
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(0);
		await oneRound();
		await oneRound();
		expect(c.recordProbeState).not.toHaveBeenCalled();
		expect(c.log.warn).toHaveBeenCalledTimes(2);
		// 限流前的那一次不通还算数:再来一次不通就是连续两次。
		await oneRound();
		expect(c.written.map((w) => w.state.status)).toEqual(["unreachable"]);
	});

	it("停用的连接不探,停用期间失败的计数清零", async () => {
		const connection = connectionOf(A);
		const c = setup([connection], { [A]: async () => fail("unavailable", "x") });
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(0);
		connection.enabled = false;
		await oneRound();
		expect(c.probeConnection).toHaveBeenCalledTimes(1);
		connection.enabled = true;
		await oneRound();
		expect(c.recordProbeState).not.toHaveBeenCalled();
	});

	it("关停之后不再起新一轮", async () => {
		const c = setup([connectionOf(A)], {});
		engine = c.engine;
		await vi.advanceTimersByTimeAsync(0);
		c.abort.abort();
		await oneRound();
		expect(c.probeConnection).toHaveBeenCalledTimes(1);
	});

	it("dispose 停掉定时器", async () => {
		const c = setup([connectionOf(A)], {});
		await vi.advanceTimersByTimeAsync(0);
		c.engine.dispose();
		await oneRound();
		expect(c.probeConnection).toHaveBeenCalledTimes(1);
	});

	describe("报「连接连不上」", () => {
		const DOWN = fail("unavailable", "拒绝连接");
		const UP = ok({ latencyMs: 3 });
		/** 探测结果由测试随时换。 */
		function scripted(initial: ProbeResult) {
			const state = { current: initial };
			return { state, probes: { [A]: async () => state.current } };
		}
		const reportKey = {
			reporter: "onebot",
			about: { connectionId: A },
			code: "connection_unreachable",
		};
		const unreachableText = t("problem.connection.unreachable", {
			name: "bot",
			reason: "拒绝连接",
		});

		it("开机后从没通过,连续两次不通:报一条,只进表不私聊", async () => {
			const { probes } = scripted(DOWN);
			const c = setup([connectionOf(A)], probes);
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			expect(c.report).not.toHaveBeenCalled();
			await oneRound();
			expect(c.report).toHaveBeenCalledTimes(1);
			expect(c.report).toHaveBeenCalledWith({
				...reportKey,
				message: unreachableText,
				notify: false,
				recoveryMessage: t("problem.connection.recovered", { name: "bot" }),
			});
		});

		it("通过之后连续两次不通:报一条并私聊", async () => {
			const { state, probes } = scripted(UP);
			const c = setup([connectionOf(A)], probes);
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			state.current = DOWN;
			await oneRound();
			await oneRound();
			expect(c.report).toHaveBeenCalledTimes(1);
			expect(c.report).toHaveBeenCalledWith(expect.objectContaining({ notify: true }));
		});

		it("断着不重复报:一直断多轮只报第一次;原因变了才再报,私聊与否冻在这次中断开始时", async () => {
			const { state, probes } = scripted(UP);
			const c = setup([connectionOf(A)], probes);
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			state.current = DOWN;
			await oneRound();
			await oneRound();
			await oneRound();
			await oneRound();
			expect(c.report).toHaveBeenCalledTimes(1);
			state.current = fail("unauthorized", "token 不对");
			await oneRound();
			expect(c.report).toHaveBeenCalledTimes(2);
			expect(c.report).toHaveBeenLastCalledWith(
				expect.objectContaining({
					notify: true,
					message: t("problem.connection.unreachable", { name: "bot", reason: "token 不对" }),
				}),
			);
		});

		it("主人的私聊目标走的就是这条连接:不私聊;中断中途主人换了目标也不翻", async () => {
			const { state, probes } = scripted(UP);
			const opts = { master: A as string | undefined };
			const c = setup([connectionOf(A)], probes, opts);
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			state.current = DOWN;
			await oneRound();
			await oneRound();
			expect(c.report).toHaveBeenCalledWith(expect.objectContaining({ notify: false }));
			opts.master = undefined;
			state.current = fail("unauthorized", "token 不对");
			await oneRound();
			expect(c.report).toHaveBeenLastCalledWith(expect.objectContaining({ notify: false }));
		});

		it("探不通的码是 not_configured / not_found(要主人去动手才会好):通过之后也不私聊", async () => {
			for (const code of ["not_configured", "not_found"] as const) {
				const { state, probes } = scripted(UP);
				const c = setup([connectionOf(A)], probes);
				await vi.advanceTimersByTimeAsync(0);
				state.current = fail(code, "接入没了");
				await oneRound();
				await oneRound();
				expect(c.report).toHaveBeenCalledTimes(1);
				expect(c.report).toHaveBeenCalledWith(expect.objectContaining({ notify: false }));
				c.engine.dispose();
			}
		});

		it("主人改了设置之后再断:不私聊", async () => {
			const connection = connectionOf(A);
			const { state, probes } = scripted(UP);
			const c = setup([connection], probes);
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			connection.settings = { token: "new" };
			state.current = DOWN;
			await oneRound();
			await oneRound();
			expect(c.report).toHaveBeenCalledTimes(1);
			expect(c.report).toHaveBeenCalledWith(expect.objectContaining({ notify: false }));
		});

		it("断着探通了:清掉这一条(缺省通知,通知器只对真私聊过的补「已恢复」)", async () => {
			const { state, probes } = scripted(UP);
			const c = setup([connectionOf(A)], probes);
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			state.current = DOWN;
			await oneRound();
			await oneRound();
			state.current = UP;
			await oneRound();
			expect(c.resolve).toHaveBeenCalledTimes(1);
			expect(c.resolve).toHaveBeenCalledWith(reportKey);
			await oneRound();
			expect(c.resolve).toHaveBeenCalledTimes(1);
		});

		it("停用了:清掉这一条且不补「已恢复」,此后不再探", async () => {
			const connection = connectionOf(A);
			const { probes } = scripted(DOWN);
			const c = setup([connection], probes);
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			await oneRound();
			expect(c.report).toHaveBeenCalledTimes(1);
			connection.enabled = false;
			await oneRound();
			expect(c.resolve).toHaveBeenCalledWith(reportKey, { notify: false });
			expect(c.probeConnection).toHaveBeenCalledTimes(2);
		});

		it("适配器不在场:不探、不报,失败的计数清零", async () => {
			const { probes } = scripted(DOWN);
			const gate = { present: false };
			const c = setup([connectionOf(A)], probes, { present: () => gate.present });
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			await oneRound();
			expect(c.probeConnection).not.toHaveBeenCalled();
			gate.present = true;
			await oneRound();
			expect(c.probeConnection).toHaveBeenCalledTimes(1);
			expect(c.report).not.toHaveBeenCalled();
		});
	});

	describe("报「连接设置不合法」", () => {
		const schema = z.object({ token: z.string().min(1) });
		const settingsKey = {
			reporter: "onebot",
			about: { connectionId: A },
			code: "connection_settings_invalid",
		};
		const BAD = {};
		const GOOD = { token: "t" };

		it("设置过不了适配器的规则:报一条只进表的,原因带哪一格", async () => {
			const c = setup([connectionOf(A, { settings: BAD })], {}, { schema });
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			expect(c.report).toHaveBeenCalledTimes(1);
			expect(c.report).toHaveBeenCalledWith({
				...settingsKey,
				message: expect.stringContaining("设置不合法：token"),
				notify: false,
			});
			// 整句读下来不重复:原因本身就以「设置不合法」开头。
			expect(c.report.mock.calls[0]?.[0].message).toMatch(/^连接「bot」设置不合法：token：/);
		});

		it("不再另报「连不上」:探测回 not_configured 连续两次,只写 unreachable 带原因,不开第二条", async () => {
			const c = setup(
				[connectionOf(A, { settings: BAD })],
				{ [A]: async () => fail("not_configured", "连接设置不合法：token") },
				{ schema },
			);
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			await oneRound();
			await oneRound();
			expect(c.report).toHaveBeenCalledTimes(1);
			expect(c.report.mock.calls[0]?.[0].code).toBe("connection_settings_invalid");
			expect(c.written.map((w) => w.state.status)).toEqual(["unreachable"]);
		});

		it("好了:清掉这一条且不补「已恢复」;每分钟一轮里不重复报", async () => {
			const connection = connectionOf(A, { settings: BAD });
			const c = setup([connection], {}, { schema });
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			await oneRound();
			expect(c.report).toHaveBeenCalledTimes(1);
			connection.settings = GOOD;
			await oneRound();
			expect(c.resolve).toHaveBeenCalledTimes(1);
			expect(c.resolve).toHaveBeenCalledWith(settingsKey, { notify: false });
		});

		it("checkSettings:不探测,新填的设置不用等一轮;重复调不重复报", async () => {
			const connections: Connection[] = [];
			const c = setup(connections, {}, { schema });
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			connections.push(connectionOf(A, { settings: BAD }));
			c.engine.checkSettings();
			c.engine.checkSettings();
			expect(c.report).toHaveBeenCalledTimes(1);
			expect(c.probeConnection).not.toHaveBeenCalled();
			const [added] = connections;
			if (added) added.settings = GOOD;
			c.engine.checkSettings();
			expect(c.resolve).toHaveBeenCalledWith(settingsKey, { notify: false });
		});

		it("停用了:清掉这一条;设置不合法时已开着的「连不上」一并清掉", async () => {
			const connection = connectionOf(A, { settings: GOOD });
			const state = { current: fail("unavailable", "拒绝连接") as ProbeResult };
			const c = setup([connection], { [A]: async () => state.current }, { schema });
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			await oneRound();
			expect(c.report.mock.calls.map((x) => x[0].code)).toEqual(["connection_unreachable"]);
			connection.settings = BAD;
			c.engine.checkSettings();
			expect(c.resolve).toHaveBeenCalledWith(
				{ reporter: "onebot", about: { connectionId: A }, code: "connection_unreachable" },
				{ notify: false },
			);
			expect(c.report.mock.calls.map((x) => x[0].code)).toEqual([
				"connection_unreachable",
				"connection_settings_invalid",
			]);
			connection.enabled = false;
			await oneRound();
			expect(c.resolve).toHaveBeenLastCalledWith(settingsKey, { notify: false });
		});
	});

	describe("手动「测试」:只算恢复,不算失败", () => {
		const DOWN = fail("unavailable", "拒绝连接");

		it("手动两次不通:不报,不加失败次数;每次都写盘(引导靠 lastCheckedAt 变)", async () => {
			const state = { current: ok({ latencyMs: 1 }) as ProbeResult };
			const c = setup([connectionOf(A)], { [A]: async () => state.current });
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			c.written.length = 0;
			state.current = DOWN;
			const first = await c.engine.probe(A, { manual: true });
			await c.engine.probe(A, { manual: true });
			expect(first).toEqual(DOWN);
			expect(c.report).not.toHaveBeenCalled();
			expect(c.written.map((w) => w.state.status)).toEqual(["unreachable", "unreachable"]);
			expect(c.written[0]?.state.message).toBe("拒绝连接");
			// 手动的两次不算数:后台再来一次不通也只是第 1 次。
			await oneRound();
			expect(c.report).not.toHaveBeenCalled();
		});

		it("手动探通了:当场清掉问题并写 reachable,哪怕下一轮还没到", async () => {
			const state = { current: DOWN as ProbeResult };
			const c = setup([connectionOf(A)], { [A]: async () => state.current });
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			await oneRound();
			expect(c.report).toHaveBeenCalledTimes(1);
			state.current = ok({ latencyMs: 4 });
			await c.engine.probe(A, { manual: true });
			expect(c.resolve).toHaveBeenCalledWith({
				reporter: "onebot",
				about: { connectionId: A },
				code: "connection_unreachable",
			});
			expect(c.written.at(-1)?.state).toEqual({
				status: "reachable",
				lastCheckedAt: expect.any(String),
				latencyMs: 4,
			});
		});

		it("手动探通过的算「连上过」:此后后台连续两次不通会私聊", async () => {
			const state = { current: DOWN as ProbeResult };
			const c = setup([connectionOf(A)], { [A]: async () => state.current });
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			state.current = ok({ latencyMs: 4 });
			await c.engine.probe(A, { manual: true });
			state.current = DOWN;
			await oneRound();
			await oneRound();
			expect(c.report).toHaveBeenCalledWith(expect.objectContaining({ notify: true }));
		});

		it("手动被限流(rate_limited):状态不动、不写盘、不清问题、不加失败次数,结果照回", async () => {
			const state = { current: DOWN as ProbeResult };
			const c = setup([connectionOf(A)], { [A]: async () => state.current });
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			await oneRound();
			expect(c.report).toHaveBeenCalledTimes(1);
			c.written.length = 0;
			const limited = fail("rate_limited", "限流");
			state.current = limited;
			const result = await c.engine.probe(A, { manual: true });
			expect(result).toEqual(limited);
			expect(c.written).toEqual([]);
			expect(c.resolve).not.toHaveBeenCalled();
			expect(c.log.warn).toHaveBeenCalledTimes(1);
		});

		it("没有探测协议(unsupported):写 unsupported", async () => {
			const c = setup([connectionOf(A)], { [A]: async () => fail("unsupported", "no probe") });
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			c.written.length = 0;
			await c.engine.probe(A, { manual: true });
			expect(c.written.map((w) => w.state.status)).toEqual(["unsupported"]);
		});

		it("写盘失败只记一行 warn,探测结果照回", async () => {
			const c = setup([connectionOf(A)], {});
			engine = c.engine;
			await vi.advanceTimersByTimeAsync(0);
			c.recordProbeState.mockRejectedValueOnce(new Error("disk"));
			const result = await c.engine.probe(A, { manual: true });
			expect(result.ok).toBe(true);
			expect(c.log.warn).toHaveBeenCalledTimes(1);
		});
	});
});
