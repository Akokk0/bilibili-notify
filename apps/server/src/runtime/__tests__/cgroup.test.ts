import { describe, expect, it } from "vite-plus/test";
import { parseCgroupBytes, parseCpuMax, parseCpuQuotaV1, readCgroup } from "../cgroup.js";

/**
 * cgroup 读数:Docker 给容器的内存上限 / 已用 / CPU 配额。
 *
 * 面板在容器里要按**容器配额**算百分比 —— `os.totalmem()` 报的是整台宿主机,
 * 2G 配额的容器在 64G 机器上永远显示「用了 3%」,离 OOM-kill 只差一步也看不出来。
 */

const GB = 1024 * 1024 * 1024;

describe("cgroup 文件解析", () => {
	it("memory.max:数字就是上限,max 是没限制", () => {
		expect(parseCgroupBytes("2147483648\n")).toBe(2 * GB);
		expect(parseCgroupBytes("max\n")).toBeNull();
	});

	it("v1 的 memory.limit_in_bytes 没限制时是一个天文数字,也当没限制", () => {
		// 内核把 PAGE_COUNTER_MAX × 页大小写出来,x86_64 上就是这个值。
		expect(parseCgroupBytes("9223372036854771712\n")).toBeNull();
	});

	it("看不懂的内容当没限制,不当 0", () => {
		expect(parseCgroupBytes("")).toBeNull();
		expect(parseCgroupBytes("garbage")).toBeNull();
	});

	it("cpu.max:「配额 周期」折成核数,max 是没限制", () => {
		expect(parseCpuMax("50000 100000\n")).toBe(0.5);
		expect(parseCpuMax("200000 100000\n")).toBe(2);
		expect(parseCpuMax("max 100000\n")).toBeNull();
	});

	it("v1 的 cfs_quota_us 为 -1 是没限制", () => {
		expect(parseCpuQuotaV1("-1\n", "100000\n")).toBeNull();
		expect(parseCpuQuotaV1("150000\n", "100000\n")).toBe(1.5);
	});
});

describe("readCgroup", () => {
	it("v2 三个文件齐全就用 v2", () => {
		const files: Record<string, string> = {
			"/sys/fs/cgroup/memory.max": "2147483648\n",
			"/sys/fs/cgroup/memory.current": "943718400\n",
			"/sys/fs/cgroup/cpu.max": "100000 100000\n",
		};
		expect(readCgroup((p) => files[p] ?? null)).toEqual({
			memLimit: 2 * GB,
			memUsed: 943718400,
			cpuQuota: 1,
		});
	});

	it("没有 v2 就退到 v1 的路径", () => {
		const files: Record<string, string> = {
			"/sys/fs/cgroup/memory/memory.limit_in_bytes": "1073741824\n",
			"/sys/fs/cgroup/memory/memory.usage_in_bytes": "536870912\n",
			"/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n",
			"/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
		};
		expect(readCgroup((p) => files[p] ?? null)).toEqual({
			memLimit: 1 * GB,
			memUsed: 536870912,
			cpuQuota: null,
		});
	});

	it("桌面版 / 裸跑没有 cgroup 文件:三项全 null", () => {
		expect(readCgroup(() => null)).toEqual({ memLimit: null, memUsed: null, cpuQuota: null });
	});
});
