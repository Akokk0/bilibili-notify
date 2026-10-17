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
	} = {},
) {
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
		serviceCtx: { signal: abort.signal, track: (task) => void tracked.push(task) },
		logger: log,
	});
	return {
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
					miniAppCard: { state: "unknown" },
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
});
