import type { ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { type ResourceReaders, startResourceMonitor } from "../resource-monitor.js";

/**
 * 常驻资源采样器 —— 概览页「系统资源」卡的数据源,也是内存自检日志的新家。
 *
 * 只从公共口看:`hydrate()`(订阅那一刻的静态量 + 近 5 分钟样本)、`subscribe()`
 * (之后每个 tick 一份样本)、以及它往 logger 写的东西。读数全部注入,时钟由测试拨。
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** 按间隔毫秒记下注册进来的 tick,让测试自己决定「到点」。 */
function makeCtx(logger = makeLogger()) {
	const ticks = new Map<number, () => void>();
	const ctx = {
		logger,
		setInterval: vi.fn((fn: () => void, ms: number) => {
			ticks.set(ms, fn);
			return { dispose: vi.fn() };
		}),
		setTimeout: vi.fn(() => ({ dispose: vi.fn() })),
		onDispose: vi.fn(),
	};
	return {
		ctx: ctx as unknown as ServiceContext,
		logger,
		raw: ctx,
		fire: (ms: number) => {
			const fn = ticks.get(ms);
			if (!fn) throw new Error(`没有 ${ms}ms 的定时器,注册了:${[...ticks.keys()].join(",")}`);
			fn();
		},
	};
}

/**
 * 一台假机器:4 核、8G、堆上限 512M、不在 cgroup 里。CPU 两个读数用「下一次返回什么」
 * 的方式喂,好按 tick 摆出差值。
 */
function makeReaders(overrides: Partial<ResourceReaders> = {}) {
	let now = 0;
	let cpu = { user: 0, system: 0 };
	let host = { idle: 1000, total: 2000 };
	const readers: ResourceReaders = {
		now: () => now,
		cpuUsage: () => cpu,
		hostCpuTimes: () => host,
		memoryUsage: () => ({
			rss: 340 * MB,
			heapUsed: 210 * MB,
			heapTotal: 250 * MB,
			external: 12 * MB,
		}),
		hostMem: () => ({ total: 8 * GB, free: 3 * GB }),
		cpuModel: () => "AMD EPYC 7K62 48-Core Processor",
		hostCores: () => 4,
		heapLimit: () => 512 * MB,
		cgroup: () => ({ memLimit: null, memUsed: null, cpuQuota: null }),
		...overrides,
	};
	return {
		readers,
		advance(ms: number, next: { cpuMicros?: number; hostIdle?: number; hostTotal?: number }) {
			now += ms;
			if (next.cpuMicros !== undefined) cpu = { user: next.cpuMicros, system: 0 };
			if (next.hostIdle !== undefined && next.hostTotal !== undefined)
				host = { idle: next.hostIdle, total: next.hostTotal };
		},
	};
}

describe("ResourceMonitor 采样", () => {
	it("每 2 秒一 tick:本体 CPU 按可用核数折算、宿主机 CPU 按 tick 差值算,其余原样", () => {
		const { ctx, fire } = makeCtx();
		const { readers, advance } = makeReaders();
		const monitor = startResourceMonitor({ serviceCtx: ctx, readers });
		const seen = vi.fn();
		monitor.subscribe(seen);

		// 第一个 tick 没有上一次可比,两个 CPU 比例都还给不出。
		fire(2000);
		expect(seen).toHaveBeenCalledTimes(1);
		expect(seen.mock.calls[0]?.[0]).toMatchObject({ ts: 0, hostCpu: null, procCpu: null });

		// 2 秒墙钟里本体用了 1.6 秒 CPU = 0.8 个核,4 核机器上就是 20%;
		// 宿主机这 2 秒 idle 走了 400、总 tick 走了 1000 → 忙 60%。
		advance(2000, { cpuMicros: 1_600_000, hostIdle: 1400, hostTotal: 3000 });
		fire(2000);

		expect(seen).toHaveBeenCalledTimes(2);
		expect(seen.mock.calls[1]?.[0]).toEqual({
			ts: 2000,
			hostCpu: 0.6,
			procCpu: 0.2,
			heapUsed: 210 * MB,
			rss: 340 * MB,
			memUsed: 5 * GB,
			browserRss: null,
			browserState: "none",
		});
	});

	it("hydrate 带静态量:型号、核数、可用核数、内存总量与来路、堆上限", () => {
		const { ctx } = makeCtx();
		const { readers } = makeReaders();
		const monitor = startResourceMonitor({ serviceCtx: ctx, readers });

		expect(monitor.hydrate().static).toEqual({
			cpuModel: "AMD EPYC 7K62 48-Core Processor",
			hostCores: 4,
			cpuBudget: 4,
			memTotal: 8 * GB,
			memSource: "host",
			heapLimit: 512 * MB,
		});
	});

	it("hydrate 交出近 5 分钟的样本:旧在前新在后,满 150 点后丢最旧", () => {
		const { ctx, fire } = makeCtx();
		const { readers, advance } = makeReaders();
		const monitor = startResourceMonitor({ serviceCtx: ctx, readers });

		fire(2000);
		advance(2000, {});
		fire(2000);
		advance(2000, {});
		fire(2000);
		expect(monitor.hydrate().history.map((s) => s.ts)).toEqual([0, 2000, 4000]);

		// 5 分钟 ÷ 2 秒 = 150 点;再多 sparkline 也画不出更多信息,只是白占内存。
		for (let i = 3; i < 160; i++) {
			advance(2000, {});
			fire(2000);
		}
		const history = monitor.hydrate().history;
		expect(history).toHaveLength(150);
		expect(history[0]?.ts).toBe(10 * 2000);
		expect(history.at(-1)?.ts).toBe(159 * 2000);
	});

	it("容器里:内存总量取 cgroup 上限、已用每 tick 现读 memory.current,本体 CPU 按配额折算", () => {
		const { ctx, fire } = makeCtx();
		let current = 900 * MB;
		const { readers, advance } = makeReaders({
			cgroup: () => ({ memLimit: 2 * GB, memUsed: current, cpuQuota: 0.5 }),
		});
		const monitor = startResourceMonitor({ serviceCtx: ctx, readers });
		const seen = vi.fn();
		monitor.subscribe(seen);

		// 8G 的宿主机上 compose 给了 2G 配额 —— 面板要按 2G 算百分比,否则永远看着很空。
		expect(monitor.hydrate().static).toMatchObject({
			memTotal: 2 * GB,
			memSource: "cgroup",
			cpuBudget: 0.5,
		});

		fire(2000);
		current = 1200 * MB;
		// 半个核的配额里用了 0.4 个核 = 80%。
		advance(2000, { cpuMicros: 800_000 });
		fire(2000);
		expect(seen.mock.calls[1]?.[0]).toMatchObject({ memUsed: 1200 * MB, procCpu: 0.8 });
	});
});
