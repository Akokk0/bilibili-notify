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
		cgroupMemUsed: () => null,
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
			cgroupMemUsed: () => current,
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

	/**
	 * 🔴 **每 tick 只读「已用」那一格。**
	 *
	 * `cgroup()` 为了判 v2 还是 v1,一趟要连着读三个 sysfs 文件;而 tick 要的只有
	 * `memory.current` 一个数。上限与 CPU 配额都是静态量,开机问一次就够 —— 把整趟
	 * 塞进 2 秒一次的 tick 里,是白烧的三份文件 I/O。
	 */
	it("tick 只问窄口 cgroupMemUsed,整趟 cgroup() 只在开机问一次", () => {
		const { ctx, fire } = makeCtx();
		let current = 900 * MB;
		const cgroup = vi.fn(() => ({ memLimit: 2 * GB, memUsed: 111 * MB, cpuQuota: 0.5 }));
		const cgroupMemUsed = vi.fn(() => current);
		const { readers } = makeReaders({ cgroup, cgroupMemUsed });
		const monitor = startResourceMonitor({ serviceCtx: ctx, readers });
		const seen = vi.fn();
		monitor.subscribe(seen);

		expect(cgroup).toHaveBeenCalledTimes(1); // 开机那一次(上限 + CPU 配额)
		fire(2000);
		current = 1200 * MB;
		fire(2000);
		fire(2000);

		expect(cgroup).toHaveBeenCalledTimes(1); // 三个 tick 之后还是那一次
		expect(cgroupMemUsed).toHaveBeenCalledTimes(3);
		// 报出去的确实是窄口现读的那个数,不是开机那趟里的 memUsed。
		expect(seen.mock.calls[0]?.[0]).toMatchObject({ memUsed: 900 * MB });
		expect(seen.mock.calls[2]?.[0]).toMatchObject({ memUsed: 1200 * MB });
	});

	/**
	 * 🔴 **两个口径不许混着报。**
	 *
	 * cgroup 读得到、但**没设内存上限**(`memory.max` 是 `max`,`docker run` 不加 `-m` 就是
	 * 这样,而那是绝大多数自建实例)时:总量退回宿主机的 8G,已用却还照着容器的
	 * `memory.current` 报 900M —— 分子是这个容器、分母是整台机器,面板上那个百分比什么
	 * 都不是。要么两边都按宿主机,要么两边都按容器;没有上限就只能是前者。
	 */
	it("cgroup 里但没设内存上限:总量与已用都按宿主机算,不许一半容器一半宿主机", () => {
		const { ctx, fire } = makeCtx();
		const { readers } = makeReaders({
			// 有 memory.current,没有 memory.max —— 那一格解出来就是 null。
			cgroup: () => ({ memLimit: null, memUsed: 900 * MB, cpuQuota: null }),
			cgroupMemUsed: () => 900 * MB,
		});
		const monitor = startResourceMonitor({ serviceCtx: ctx, readers });
		const seen = vi.fn();
		monitor.subscribe(seen);

		expect(monitor.hydrate().static).toMatchObject({ memTotal: 8 * GB, memSource: "host" });
		fire(2000);
		// 宿主机口径 = total - free = 8G - 3G。
		expect(seen.mock.calls[0]?.[0]).toMatchObject({ memUsed: 5 * GB });
	});

	/**
	 * 🔴 `os.cpus()` 回空数组是真事(容器里挂了 /proc、某些 ARM 内核、Node 的已知返回)。
	 * 那时 `cpuBudget` 是 0,本体 CPU 就成了 `除以 0` —— 面板收到 `Infinity`,JSON 里是
	 * `null`,而堆 / 内存那些正常数字跟着这一帧一起变得不可信。
	 */
	it("宿主机报不出核数:本体 CPU 不许算成 Infinity", () => {
		const { ctx, fire } = makeCtx();
		const { readers, advance } = makeReaders({ hostCores: () => 0 });
		const monitor = startResourceMonitor({ serviceCtx: ctx, readers });
		const seen = vi.fn();
		monitor.subscribe(seen);

		// 至少得有一个核的分母,否则算出来的东西没有意义。
		expect(monitor.hydrate().static.cpuBudget).toBeGreaterThan(0);

		fire(2000);
		advance(2000, { cpuMicros: 1_600_000, hostIdle: 1400, hostTotal: 3000 });
		fire(2000);
		const procCpu = seen.mock.calls[1]?.[0]?.procCpu;
		expect(Number.isFinite(procCpu)).toBe(true);
	});
});

describe("ResourceMonitor 内存自检日志", () => {
	function heap(mb: number) {
		return () => ({
			rss: 340 * MB,
			heapUsed: mb * MB,
			heapTotal: (mb + 40) * MB,
			external: 12 * MB,
		});
	}

	it("开关开着:10 分钟一行 info,带堆用量 / 上限 / 占比 / 已提交与业务规模采样点", () => {
		const { ctx, fire, logger } = makeCtx();
		const { readers, advance } = makeReaders({ memoryUsage: heap(210) });
		startResourceMonitor({
			serviceCtx: ctx,
			readers,
			memoryLogEnabled: () => true,
			probes: [() => "弹幕 3 房/12000 词/8000 人"],
		});

		fire(2000);
		// 第一个 tick 就落一行 —— 启动后的第一份曲线点不该等 10 分钟。
		expect(logger.info).toHaveBeenCalledTimes(1);
		const line = String(logger.info.mock.calls[0]?.[0] ?? "");
		expect(line).toContain("210");
		expect(line).toContain("512");
		expect(line).toContain("41%");
		expect(line).toMatch(/250\s*MB/);
		expect(line).toContain("弹幕 3 房/12000 词/8000 人");

		// 之后 2 秒一 tick 不能 2 秒一行 —— 一天 43200 行会把按天分卷的归档刷爆。
		for (let i = 0; i < 299; i++) {
			advance(2000, {});
			fire(2000);
		}
		expect(logger.info).toHaveBeenCalledTimes(1);
		advance(2000, {});
		fire(2000);
		expect(logger.info).toHaveBeenCalledTimes(2);
	});

	it("开关关着(默认):一行 info 都不写;中途打开立刻生效", () => {
		const { ctx, fire, logger } = makeCtx();
		const { readers, advance } = makeReaders({ memoryUsage: heap(210) });
		let enabled = false;
		startResourceMonitor({ serviceCtx: ctx, readers, memoryLogEnabled: () => enabled });

		for (let i = 0; i < 400; i++) {
			advance(2000, {});
			fire(2000);
		}
		expect(logger.info).not.toHaveBeenCalled();

		// 系统页拨开开关,不重启就该开始记。
		enabled = true;
		advance(2000, {});
		fire(2000);
		expect(logger.info).toHaveBeenCalledTimes(1);
	});

	it("某个采样点抛了,进程级那行照样落地", () => {
		const { ctx, fire, logger } = makeCtx();
		const { readers } = makeReaders({ memoryUsage: heap(210) });
		startResourceMonitor({
			serviceCtx: ctx,
			readers,
			memoryLogEnabled: () => true,
			probes: [
				() => {
					throw new Error("引擎还没起来");
				},
				() => "弹幕 3 房/12000 词/8000 人",
			],
		});
		fire(2000);
		const line = String(logger.info.mock.calls[0]?.[0] ?? "");
		expect(line).toContain("210");
		expect(line).toContain("弹幕 3 房/12000 词/8000 人");
	});

	it("85% warn 是独立安全网:开关关着也响,越线一次只响一次,回落到 80% 以下才重新武装", () => {
		const { ctx, fire, logger } = makeCtx();
		let mb = 210;
		const { readers, advance } = makeReaders({ memoryUsage: () => heap(mb)() });
		startResourceMonitor({ serviceCtx: ctx, readers, memoryLogEnabled: () => false });

		fire(2000);
		expect(logger.warn).not.toHaveBeenCalled();

		// 450/512 = 88%:响一次,说清撞上去的后果与怎么撑住。
		mb = 450;
		advance(2000, {});
		fire(2000);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		const line = String(logger.warn.mock.calls[0]?.[0] ?? "");
		expect(line).toContain("88%");
		expect(line).toMatch(/上限|FATAL|退出/);
		expect(line).toContain("max-old-space-size");

		// 一直在 85% 以上晃:2 秒一 tick 不能 2 秒一条 warn。
		for (let i = 0; i < 30; i++) {
			mb = i % 2 === 0 ? 440 : 460;
			advance(2000, {});
			fire(2000);
		}
		expect(logger.warn).toHaveBeenCalledTimes(1);

		// 掉到 82%(还没回 80% 以下)再冲上去也不算新一轮 —— 卡在阈值附近抖动不该刷屏。
		mb = 420;
		advance(2000, {});
		fire(2000);
		mb = 450;
		advance(2000, {});
		fire(2000);
		expect(logger.warn).toHaveBeenCalledTimes(1);

		// 回到 400/512 = 78% 才重新武装,再越线就是新一轮。
		mb = 400;
		advance(2000, {});
		fire(2000);
		mb = 450;
		advance(2000, {});
		fire(2000);
		expect(logger.warn).toHaveBeenCalledTimes(2);
	});
});

describe("ResourceMonitor 浏览器进程", () => {
	/** 把量那一步的 promise 链跑完 —— 真机上它是毫秒级的,测试里得显式让出。 */
	const flush = () => new Promise((r) => setTimeout(r, 0));

	function browserDeps() {
		const measure = vi.fn(async () => 620 * MB);
		return {
			measure,
			source: {
				info: () => ({ state: "running" as const, pid: 4242 }),
				subtreeRss: measure,
			},
		};
	}

	it("有人订着才量,而且 10 秒一次不是 2 秒一次 —— 那一步要起子进程", async () => {
		const { ctx, fire } = makeCtx();
		const { readers, advance } = makeReaders();
		const { measure, source } = browserDeps();
		const monitor = startResourceMonitor({ serviceCtx: ctx, readers, browser: source });

		// 没人看的时候一次都不量。
		for (let i = 0; i < 20; i++) {
			advance(2000, {});
			fire(2000);
		}
		expect(measure).not.toHaveBeenCalled();

		const seen = vi.fn();
		const handle = monitor.subscribe(seen);
		advance(2000, {});
		fire(2000);
		await flush();
		expect(measure).toHaveBeenCalledTimes(1);

		// 之后四个 tick(2/4/6/8 秒)都不该再量。
		for (let i = 0; i < 4; i++) {
			advance(2000, {});
			fire(2000);
		}
		expect(measure).toHaveBeenCalledTimes(1);
		advance(2000, {});
		fire(2000);
		expect(measure).toHaveBeenCalledTimes(2);

		handle.dispose();
		for (let i = 0; i < 10; i++) {
			advance(2000, {});
			fire(2000);
		}
		expect(measure).toHaveBeenCalledTimes(2);
	});

	it("量到的字节数跟着后面每一帧走,不是只在量到的那一帧才有", async () => {
		const { ctx, fire } = makeCtx();
		const { readers, advance } = makeReaders();
		const { source } = browserDeps();
		const monitor = startResourceMonitor({ serviceCtx: ctx, readers, browser: source });
		const seen = vi.fn();
		monitor.subscribe(seen);

		fire(2000);
		// 第一帧还没量到(量是异步的),先报 null 而不是编一个数。
		expect(seen.mock.calls[0]?.[0]).toMatchObject({ browserRss: null, browserState: "running" });

		await flush();
		advance(2000, {});
		fire(2000);
		expect(seen.mock.calls[1]?.[0]).toMatchObject({
			browserRss: 620 * MB,
			browserState: "running",
		});

		// 中间那几帧照样带着上一次量到的值 —— 每两秒闪一下 null 比不报还糟。
		advance(2000, {});
		fire(2000);
		expect(seen.mock.calls[2]?.[0]).toMatchObject({ browserRss: 620 * MB });
	});

	it("浏览器关掉 / 远程 → 状态照实报,字节数回 null 不留着上一次的残值", async () => {
		const { ctx, fire } = makeCtx();
		const { readers, advance } = makeReaders();
		let state: "running" | "closed" = "running";
		const monitor = startResourceMonitor({
			serviceCtx: ctx,
			readers,
			browser: {
				info: () => ({ state, pid: state === "running" ? 4242 : null }),
				subtreeRss: async () => 620 * MB,
			},
		});
		const seen = vi.fn();
		monitor.subscribe(seen);

		fire(2000);
		await flush();
		advance(2000, {});
		fire(2000);
		expect(seen.mock.calls[1]?.[0]).toMatchObject({ browserRss: 620 * MB });

		// 空闲关掉之后还挂着 620MB,面板就会说一个已经不存在的进程占着内存。
		state = "closed";
		advance(2000, {});
		fire(2000);
		expect(seen.mock.calls[2]?.[0]).toMatchObject({ browserRss: null, browserState: "closed" });
	});

	it("量的那一步抛了,整条采样不受影响", async () => {
		const { ctx, fire, logger } = makeCtx();
		const { readers, advance } = makeReaders();
		const monitor = startResourceMonitor({
			serviceCtx: ctx,
			readers,
			browser: {
				info: () => ({ state: "running" as const, pid: 4242 }),
				subtreeRss: async () => {
					throw new Error("ps 不在 PATH 上");
				},
			},
		});
		const seen = vi.fn();
		monitor.subscribe(seen);

		fire(2000);
		await flush();
		advance(2000, {});
		fire(2000);

		// 一个量不到的可选数字不该把 CPU / 堆那些主线数字一起带走,也不该刷 error 日志。
		expect(seen.mock.calls[1]?.[0]).toMatchObject({ browserRss: null, heapUsed: 210 * MB });
		expect(logger.error).not.toHaveBeenCalled();
	});
});
