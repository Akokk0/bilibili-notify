import { cpus, freemem, totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import type {
	BrowserProcessState,
	ResourceSample,
	ResourceStatic,
	ResourcesHydrate,
} from "@bilibili-notify/contract";
import type { Disposable, ServiceContext } from "@bilibili-notify/internal";
import { readCgroup } from "./cgroup.js";

/**
 * 常驻资源采样器 —— 概览页「系统资源」卡的数据源。
 *
 * 每 {@link SAMPLE_INTERVAL_MS} 一 tick 读一次进程与宿主机的数字,推给订阅者,同时留
 * 近 5 分钟的环形缓冲(订阅那一刻整段交出去,sparkline 不用从零长)。读数全部走
 * {@link ResourceReaders} 注入,生产用默认的 node:os / process 实现。
 */

/** 采样节奏:2 秒。面板推帧、环形缓冲、都是这一个 tick。 */
export const SAMPLE_INTERVAL_MS = 2_000;

/** 环形缓冲长度:5 分钟 ÷ 2 秒。再多 sparkline 也画不出更多信息,只是白占内存。 */
export const HISTORY_POINTS = 150;

/** 读数口。全部同步、微秒级 —— 起子进程那种(浏览器子树)不在这里。 */
export interface ResourceReaders {
	now(): number;
	/** `process.cpuUsage()`:进程累计 CPU 时间(µs)。 */
	cpuUsage(): { user: number; system: number };
	/** 宿主机所有核累计 tick:`idle` 与 `total`(idle + user + nice + sys + irq)。 */
	hostCpuTimes(): { idle: number; total: number };
	memoryUsage(): { rss: number; heapUsed: number; heapTotal: number; external: number };
	hostMem(): { total: number; free: number };
	cpuModel(): string;
	hostCores(): number;
	heapLimit(): number;
	/** cgroup 读数;不在 cgroup 里(桌面版 / 裸跑)三项全 null。 */
	cgroup(): { memLimit: number | null; memUsed: number | null; cpuQuota: number | null };
}

function sumHostCpuTimes(): { idle: number; total: number } {
	let idle = 0;
	let total = 0;
	for (const c of cpus()) {
		idle += c.times.idle;
		total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
	}
	return { idle, total };
}

export const defaultResourceReaders: ResourceReaders = {
	now: () => Date.now(),
	cpuUsage: () => process.cpuUsage(),
	hostCpuTimes: sumHostCpuTimes,
	memoryUsage: () => process.memoryUsage(),
	hostMem: () => ({ total: totalmem(), free: freemem() }),
	cpuModel: () => cpus()[0]?.model ?? "",
	hostCores: () => cpus().length,
	heapLimit: () => getHeapStatistics().heap_size_limit,
	cgroup: () => readCgroup(),
};

export interface ResourceMonitorDeps {
	serviceCtx: ServiceContext;
	readers?: Partial<ResourceReaders>;
}

export interface ResourceMonitor {
	hydrate(): ResourcesHydrate;
	subscribe(listener: (sample: ResourceSample) => void): Disposable;
}

export function startResourceMonitor(deps: ResourceMonitorDeps): ResourceMonitor {
	const r: ResourceReaders = { ...defaultResourceReaders, ...deps.readers };
	const listeners = new Set<(sample: ResourceSample) => void>();
	const history: ResourceSample[] = [];

	const hostCores = r.hostCores();
	const cg = r.cgroup();
	const hostTotal = r.hostMem().total;
	const memTotal = cg.memLimit === null ? hostTotal : Math.min(cg.memLimit, hostTotal);
	const staticInfo: ResourceStatic = {
		cpuModel: r.cpuModel(),
		hostCores,
		cpuBudget: cg.cpuQuota ?? hostCores,
		memTotal,
		memSource: cg.memLimit === null ? "host" : "cgroup",
		heapLimit: r.heapLimit(),
	};

	let last: {
		at: number;
		cpu: { user: number; system: number };
		host: { idle: number; total: number };
	} | null = null;
	const browserState: BrowserProcessState = "none";

	function tick(): void {
		const at = r.now();
		const cpu = r.cpuUsage();
		const host = r.hostCpuTimes();
		let procCpu: number | null = null;
		let hostCpu: number | null = null;
		if (last) {
			const wallMicros = (at - last.at) * 1000;
			const usedMicros = cpu.user + cpu.system - (last.cpu.user + last.cpu.system);
			procCpu = wallMicros > 0 ? usedMicros / wallMicros / staticInfo.cpuBudget : null;
			const totalDelta = host.total - last.host.total;
			const idleDelta = host.idle - last.host.idle;
			hostCpu = totalDelta > 0 ? 1 - idleDelta / totalDelta : null;
		}
		last = { at, cpu, host };

		const mem = r.memoryUsage();
		const hm = r.hostMem();
		// 容器里已用量看 cgroup 的 memory.current(宿主机的 free 是整台机器的,不是这个容器的)。
		const memUsed = r.cgroup().memUsed ?? hm.total - hm.free;
		const sample: ResourceSample = {
			ts: at,
			hostCpu,
			procCpu,
			heapUsed: mem.heapUsed,
			rss: mem.rss,
			memUsed,
			browserRss: null,
			browserState,
		};
		history.push(sample);
		if (history.length > HISTORY_POINTS) history.shift();
		for (const l of listeners) l(sample);
	}

	deps.serviceCtx.setInterval(tick, SAMPLE_INTERVAL_MS);

	return {
		hydrate: () => ({ static: staticInfo, history: [...history] }),
		subscribe(listener) {
			listeners.add(listener);
			return { dispose: () => listeners.delete(listener) };
		},
	};
}
