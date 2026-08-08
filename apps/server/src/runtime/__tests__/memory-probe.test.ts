import type { ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vitest";
import { resolveProbeInterval, startMemoryProbe } from "../memory-probe.js";

/**
 * 内存自检日志。
 *
 * 存在的理由不是「看着好玩」,而是**报障时曲线已经在归档里**。
 * 一次 `Reached heap limit` 自杀在日志里只留一段 V8 的尾巴,回答不了唯一要紧的
 * 问题:它是一上来就吃这么多,还是十个小时慢慢涨上去的。等用户报障了再叫他开
 * 采样,就得再等一次崩溃 —— 而这类崩溃间隔以小时计。所以它默认开着、写 info。
 */

const MB = 1024 * 1024;

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** 捕获注册进去的 tick,让测试自己决定「到点」的时机。 */
function makeCtx(logger: ReturnType<typeof makeLogger>) {
	let tick: (() => void) | undefined;
	const ctx = {
		logger,
		setInterval: vi.fn((fn: () => void) => {
			tick = fn;
			return { dispose: vi.fn() };
		}),
		setTimeout: vi.fn(() => ({ dispose: vi.fn() })),
		onDispose: vi.fn(),
	};
	return { ctx: ctx as unknown as ServiceContext, raw: ctx, fire: () => tick?.() };
}

function usage(heapUsedMB: number, rssMB = 340) {
	return {
		rss: rssMB * MB,
		heapUsed: heapUsedMB * MB,
		heapTotal: (heapUsedMB + 40) * MB,
		external: 12 * MB,
	};
}

describe("memory-probe", () => {
	it("到点把 heapUsed、堆上限与占比打进一行日志", () => {
		const logger = makeLogger();
		const { ctx, fire } = makeCtx(logger);

		startMemoryProbe({
			serviceCtx: ctx,
			intervalSeconds: 600,
			heapLimitBytes: 512 * MB,
			readUsage: () => usage(210),
		});
		fire();

		expect(logger.info).toHaveBeenCalledTimes(1);
		const line = String(logger.info.mock.calls[0]?.[0] ?? "");
		// 三个数缺一不可:光有用量不知道离天花板多远,光有比例看不出绝对规模。
		expect(line).toContain("210");
		expect(line).toContain("512");
		expect(line).toContain("41%");
	});

	it("连 V8 已提交的堆一起报,好看出预留与碎片", () => {
		const logger = makeLogger();
		const { ctx, fire } = makeCtx(logger);

		startMemoryProbe({
			serviceCtx: ctx,
			intervalSeconds: 600,
			heapLimitBytes: 512 * MB,
			readUsage: () => usage(210), // heapTotal = 250
		});
		fire();

		// heapUsed 只说「现在装了多少」;跟已提交量一起看才知道 V8 为此占了多少、
		// 又有多少是回收不掉的碎片。
		expect(String(logger.info.mock.calls[0]?.[0] ?? "")).toMatch(/250\s*MB/);
	});

	it("逼近堆上限时升成 warn,并说清撞上去的后果", () => {
		const logger = makeLogger();
		const { ctx, fire } = makeCtx(logger);

		startMemoryProbe({
			serviceCtx: ctx,
			intervalSeconds: 600,
			heapLimitBytes: 512 * MB,
			readUsage: () => usage(450), // 88% —— 已经进危险区
		});
		fire();

		// 混在一天 144 条 info 里的话,没人看得出哪一条是「快死了」。
		expect(logger.info).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledTimes(1);
		const line = String(logger.warn.mock.calls[0]?.[0] ?? "");
		expect(line).toContain("88%");
		// 只报数字等于没报:得让人知道再涨会发生什么。
		expect(line).toMatch(/上限|FATAL|退出/);
	});

	it("业务规模采样点拼进同一行,不另起一条", () => {
		const logger = makeLogger();
		const { ctx, fire } = makeCtx(logger);

		startMemoryProbe({
			serviceCtx: ctx,
			intervalSeconds: 600,
			heapLimitBytes: 512 * MB,
			readUsage: () => usage(210),
			probes: [() => "弹幕 3 房/12000 词/8000 人"],
		});
		fire();

		// 分成两条日志的话,读的人得自己按时间戳配对 —— 而排查泄漏要看的
		// 恰恰是「堆涨的同时哪个结构在涨」,拆开就废了。
		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(String(logger.info.mock.calls[0]?.[0] ?? "")).toContain("弹幕 3 房/12000 词/8000 人");
	});

	it("某个采样点抛了,进程级数据照样落地", () => {
		const logger = makeLogger();
		const { ctx, fire } = makeCtx(logger);

		startMemoryProbe({
			serviceCtx: ctx,
			intervalSeconds: 600,
			heapLimitBytes: 512 * MB,
			readUsage: () => usage(210),
			probes: [
				() => {
					throw new Error("引擎还没起来");
				},
				() => "弹幕 3 房/12000 词/8000 人",
			],
		});
		fire();

		// 采样点是「顺便问一句」,不是主线。一个业务计数出错就让整条内存曲线
		// 断掉,等于把这个功能最要紧的用途赔进去了。
		const line = String(logger.info.mock.calls[0]?.[0] ?? "");
		expect(line).toContain("210");
		expect(line).toContain("弹幕 3 房/12000 词/8000 人");
	});

	it("间隔设成 0 就完全不采样", () => {
		const logger = makeLogger();
		const { ctx, raw } = makeCtx(logger);

		startMemoryProbe({
			serviceCtx: ctx,
			intervalSeconds: 0,
			heapLimitBytes: 512 * MB,
			readUsage: () => usage(210),
		});

		// 留一个真的关得掉的开关 —— 否则嫌吵的人只能去改 log level,
		// 那会把别的日志一起关掉。
		expect(raw.setInterval).not.toHaveBeenCalled();
	});
});

describe("resolveProbeInterval", () => {
	it("没设就用默认间隔", () => {
		expect(resolveProbeInterval(undefined)).toBe(600);
		expect(resolveProbeInterval("")).toBe(600);
	});

	it("0 是明确的关闭意图,照办", () => {
		expect(resolveProbeInterval("0")).toBe(0);
	});

	it("看不懂的值退回默认,而不是静默关掉采样", () => {
		// 打错一个字就把唯一的内存曲线关掉,而且不报错 —— 那是最坏的失败方式:
		// 等到需要这份数据时才发现它一直没在记。
		expect(resolveProbeInterval("abc")).toBe(600);
		expect(resolveProbeInterval("-5")).toBe(600);
	});

	it("给间隔夹一个下限,免得把日志归档刷爆", () => {
		expect(resolveProbeInterval("1")).toBe(30);
		expect(resolveProbeInterval("45")).toBe(45);
	});
});
