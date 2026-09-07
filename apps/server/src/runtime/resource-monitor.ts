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

/**
 * 内存自检那行 info 的节奏:10 分钟。一天 144 行在按天分卷的 jsonl 归档里什么都不是;
 * 跟着 2 秒的采样 tick 走就是一天 43200 行,谁也不想要那个。
 */
export const MEMORY_LOG_INTERVAL_MS = 600_000;

/** 堆占上限超过这个比例就 warn —— 留给用户反应的余地,而不是等 FATAL。 */
export const HEAP_WARN_RATIO = 0.85;

/**
 * warn 响过一次后,要回落到这条线以下才重新武装。没有这段回滞的话,卡在 85% 附近
 * 抖动的堆会 2 秒一条 warn 刷屏。
 */
export const HEAP_REARM_RATIO = 0.8;

const BYTES_PER_MB = 1024 * 1024;

function mb(bytes: number): number {
	return Math.round(bytes / BYTES_PER_MB);
}

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
	/**
	 * 「内存自检打印」开关(`globals.app.memoryLog`),每个 tick 现问 —— 系统页一拨就生效,
	 * 不用重启也不用另接 config-changed。缺省关。
	 */
	memoryLogEnabled?: () => boolean;
	/**
	 * 业务规模采样点,每个返回一小段人话拼进内存自检那一行。
	 *
	 * 「堆涨了」本身不指向任何人;要定位得知道**同一时刻哪个结构在涨**。所以这些计数
	 * 必须和进程级数字同行输出,分开写就得靠时间戳配对,读日志的人不会干。
	 */
	probes?: ReadonlyArray<() => string>;
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

		watchHeap(at, mem);
	}

	// ---- 内存自检:10 分钟一行 info(受开关)+ 85% warn(始终在,越线触发)----
	let lastLogAt: number | null = null;
	let warnArmed = true;

	function memoryLine(mem: ReturnType<ResourceReaders["memoryUsage"]>): string {
		const limit = staticInfo.heapLimit;
		const ratio = mem.heapUsed / limit;
		// heapUsed 只说「现在装了多少」。跟已提交量(heapTotal)一起看,才知道 V8 为此
		// 实际占了多少、又有多少是回收不掉的碎片 —— used 平、committed 一路涨,
		// 就是碎片化而不是业务在存东西。
		return (
			`[mem] heap ${mb(mem.heapUsed)}/${mb(limit)}MB (${Math.round(ratio * 100)}%, 已提交 ${mb(mem.heapTotal)}MB) ` +
			`rss ${mb(mem.rss)}MB external ${mb(mem.external)}MB${probeTail()}`
		);
	}

	function probeTail(): string {
		// 采样点是「顺便问一句」,不是主线 —— 谁抛了就跳过谁,绝不能让一个业务计数把
		// 整条内存曲线带断。
		const extra: string[] = [];
		for (const probe of deps.probes ?? []) {
			try {
				const s = probe();
				if (s) extra.push(s);
			} catch {
				// 引擎可能还没起来 / 已经拆了,不是内存自检该管的事。
			}
		}
		return extra.length > 0 ? ` | ${extra.join(" | ")}` : "";
	}

	function watchHeap(at: number, mem: ReturnType<ResourceReaders["memoryUsage"]>): void {
		const ratio = mem.heapUsed / staticInfo.heapLimit;
		if (ratio >= HEAP_WARN_RATIO) {
			if (warnArmed) {
				warnArmed = false;
				// 后果必须写出来。只报一个百分比,读日志的人不知道该不该管它。
				deps.serviceCtx.logger.warn(
					`${memoryLine(mem)} —— 已逼近堆上限,再涨会 FATAL(Reached heap limit)整个进程退出。` +
						`可在 compose 的 environment 里设 NODE_OPTIONS=--max-old-space-size=<更大的值> 先撑住。`,
				);
			}
		} else if (ratio < HEAP_REARM_RATIO) {
			warnArmed = true;
		}

		if (!deps.memoryLogEnabled?.()) return;
		if (lastLogAt !== null && at - lastLogAt < MEMORY_LOG_INTERVAL_MS) return;
		lastLogAt = at;
		deps.serviceCtx.logger.info(memoryLine(mem));
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
