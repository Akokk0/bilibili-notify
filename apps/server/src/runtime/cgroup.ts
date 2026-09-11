import { readFileSync } from "node:fs";

/**
 * cgroup 读数 —— Docker 给这个容器的内存上限 / 已用 / CPU 配额。
 *
 * 面板在容器里要按**容器配额**算百分比:`os.totalmem()` 报的是整台宿主机,2G 配额的
 * 容器在 64G 机器上永远显示「用了 3%」,离 OOM-kill 只差一步也看不出来。
 *
 * 先试 cgroup v2(现代 Docker / systemd 宿主机),没有再退 v1;都没有(桌面版、裸跑、
 * macOS)三项全 null,采样器就按宿主机算。
 */
export interface CgroupSnapshot {
	memLimit: number | null;
	memUsed: number | null;
	/** CPU 配额折成核数(可以是小数);没限制 null。 */
	cpuQuota: number | null;
}

/**
 * v1 没限制时内核写出的是 PAGE_COUNTER_MAX × 页大小 —— 一个远超任何真机内存的数。
 * 超过这条线的一律当「没限制」,别让面板算出「已用 0.0000001%」。
 */
const UNLIMITED_FLOOR = 2 ** 62;

/** `memory.max` / `memory.current` / v1 `*_in_bytes`:数字就是字节数,`max` 或垃圾是没限制。 */
export function parseCgroupBytes(raw: string): number | null {
	const text = raw.trim();
	if (!/^\d+$/.test(text)) return null;
	const n = Number(text);
	if (!Number.isFinite(n) || n >= UNLIMITED_FLOOR) return null;
	return n;
}

/** v2 `cpu.max`:「配额 周期」(µs),配额 `max` 是没限制。 */
export function parseCpuMax(raw: string): number | null {
	const [quota, period] = raw.trim().split(/\s+/);
	if (quota === undefined || period === undefined) return null;
	return quotaToCores(quota, period);
}

/** v1 `cpu.cfs_quota_us` + `cpu.cfs_period_us`:配额 `-1` 是没限制。 */
export function parseCpuQuotaV1(quotaRaw: string, periodRaw: string): number | null {
	return quotaToCores(quotaRaw.trim(), periodRaw.trim());
}

function quotaToCores(quota: string, period: string): number | null {
	if (!/^\d+$/.test(quota) || !/^\d+$/.test(period)) return null;
	const q = Number(quota);
	const p = Number(period);
	if (q <= 0 || p <= 0) return null;
	return q / p;
}

const V2 = {
	memLimit: "/sys/fs/cgroup/memory.max",
	memUsed: "/sys/fs/cgroup/memory.current",
	cpuMax: "/sys/fs/cgroup/cpu.max",
} as const;

const V1 = {
	memLimit: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
	memUsed: "/sys/fs/cgroup/memory/memory.usage_in_bytes",
	cpuQuota: "/sys/fs/cgroup/cpu/cpu.cfs_quota_us",
	cpuPeriod: "/sys/fs/cgroup/cpu/cpu.cfs_period_us",
} as const;

export type ReadTextFile = (path: string) => string | null;

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export function readCgroup(readFile: ReadTextFile = readTextOrNull): CgroupSnapshot {
	const v2Limit = readFile(V2.memLimit);
	if (v2Limit !== null) {
		const cpuMax = readFile(V2.cpuMax);
		const used = readFile(V2.memUsed);
		return {
			memLimit: parseCgroupBytes(v2Limit),
			memUsed: used === null ? null : parseCgroupBytes(used),
			cpuQuota: cpuMax === null ? null : parseCpuMax(cpuMax),
		};
	}
	const v1Limit = readFile(V1.memLimit);
	if (v1Limit !== null) {
		const used = readFile(V1.memUsed);
		const quota = readFile(V1.cpuQuota);
		const period = readFile(V1.cpuPeriod);
		return {
			memLimit: parseCgroupBytes(v1Limit),
			memUsed: used === null ? null : parseCgroupBytes(used),
			cpuQuota: quota === null || period === null ? null : parseCpuQuotaV1(quota, period),
		};
	}
	return { memLimit: null, memUsed: null, cpuQuota: null };
}

/**
 * 只读**已用内存**那一格的窄口(`memory.current` / v1 的 `usage_in_bytes`)。
 *
 * 采样器 2 秒一 tick,而每 tick 真正要的只有这一个数;走 {@link readCgroup} 的话,每趟都
 * 要为「这台是 v2 还是 v1」把上限与 CPU 配额那两个文件一并探一遍。版本在**建这个读数口
 * 的时候**定一次:cgroup 版本不会在进程活着的时候变。
 *
 * 不在 cgroup 里(桌面版 / 裸跑 / macOS)回一个恒 null 的读数口。
 */
export function makeCgroupMemUsedReader(
	readFile: ReadTextFile = readTextOrNull,
): () => number | null {
	const path =
		readFile(V2.memLimit) !== null
			? V2.memUsed
			: readFile(V1.memLimit) !== null
				? V1.memUsed
				: null;
	if (path === null) return () => null;
	return () => {
		const raw = readFile(path);
		return raw === null ? null : parseCgroupBytes(raw);
	};
}
