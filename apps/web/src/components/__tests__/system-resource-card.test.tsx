// @vitest-environment jsdom
/**
 * 概览页「系统资源」卡 —— 实时看 CPU / 内存 / 本体 / 浏览器。
 *
 * 这卡最要紧的不是好看,是**不说假话**:量不到的显示「—」而不是 0,浏览器空闲关掉与
 * 压根没配是两句不同的话,堆逼近上限时那个环要真的变色。
 */

import type { ResourceSample, ResourceStatic } from "@bilibili-notify/contract";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { heapTone, SystemResourceCard } from "../system-resource-card";

const MB = 1024 * 1024;
const GB = 1024 * MB;

const STATIC: ResourceStatic = {
	cpuModel: "AMD EPYC 7K62 48-Core Processor",
	hostCores: 4,
	cpuBudget: 4,
	memTotal: 8 * GB,
	memSource: "host",
	heapLimit: 512 * MB,
};

function sample(over: Partial<ResourceSample> = {}): ResourceSample {
	return {
		ts: 1_700_000_000_000,
		hostCpu: 0.61,
		procCpu: 0.2,
		heapUsed: 210 * MB,
		rss: 340 * MB,
		memUsed: 3 * GB,
		browserRss: null,
		browserState: "none",
		...over,
	};
}

function renderCard(
	over: { statics?: ResourceStatic | null; history?: ResourceSample[]; reachable?: boolean } = {},
) {
	return render(
		<SystemResourceCard
			state={{
				static: over.statics === undefined ? STATIC : over.statics,
				history: over.history ?? [sample()],
			}}
			reachable={over.reachable ?? true}
		/>,
	);
}

/** 读出某个环画了几段、每段多长(占整圈的比例)。 */
function segmentsOf(title: string): number[] {
	return arcsOf(title).map((a) => a.len);
}

/** 同上,但连每段涂的什么色一起读 —— 「这一段说的是谁」全在颜色上。 */
function arcsOf(title: string): Array<{ len: number; color: string }> {
	const svg = screen.getByTitle(title).closest("svg");
	if (!svg) throw new Error(`没找到 ${title} 那个环`);
	// 第一个 circle 是灰轨道。
	return [...svg.querySelectorAll("circle")].slice(1).map((el) => {
		const [drawn, whole] = (el.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
		if (!whole) throw new Error("没有整周长");
		return { len: (drawn ?? 0) / whole, color: el.getAttribute("stroke") ?? "" };
	});
}

/** 「其他」那一档的灰 —— 它是一句断言(「这些不是我们占的」),不是随手挑的颜色。 */
const REST_TONE = "var(--color-bn-inactive)";

afterEach(cleanup);

describe("SystemResourceCard", () => {
	it("环心报的是**总**占用,底下把本体那份单列出来", () => {
		renderCard();
		// 61% 是这台机器一共用掉的,20% 是我们用掉的 —— 环心只报一个数时必须是总数,
		// 否则「机器很忙」这件事在卡上根本看不见。
		expect(screen.getByText("61%")).toBeTruthy();
		expect(screen.getByText(/本体 20%/)).toBeTruthy();
		// 内存:3G / 8G = 38% 总占用,本体常驻 340MB。
		expect(screen.getByText("38%")).toBeTruthy();
		expect(screen.getByText(/本体 340 MB/)).toBeTruthy();
	});

	it("CPU 环画成「本体 + 其他 = 总占用」两段", () => {
		renderCard();
		const segs = segmentsOf("CPU 占用");
		expect(segs).toHaveLength(2);
		expect(segs[0]).toBeCloseTo(0.2, 4);
		// 其他 = 总 61% − 本体 20%;两段加起来必须正好是总占用。
		expect(segs[1]).toBeCloseTo(0.41, 4);
	});

	it("内存环里本体那段含浏览器 —— chromium 是我们起的,算我们头上", () => {
		renderCard({
			history: [sample({ browserState: "running", browserRss: 1 * GB, memUsed: 3 * GB })],
		});
		const segs = segmentsOf("内存占用");
		// 本体 340MB + 浏览器 1G,分母 8G。
		expect(segs[0]).toBeCloseTo((340 * MB + GB) / (8 * GB), 4);
		// 两段之和 = 总占用 3G/8G,一个字节都不该多也不该少。
		expect((segs[0] ?? 0) + (segs[1] ?? 0)).toBeCloseTo(3 / 8, 4);
	});

	it("容器里本体那段换算到整机分母 —— 两个比例的分母不一样,直接减会画出假的「其他」", () => {
		// 4 核机器给了半核配额:procCpu 0.8 是「用掉了配额的 80%」= 0.4 核 = 整机的 10%。
		// 不换算就会把 80% 画进环里,而总占用才 61%,「其他」立刻被夹成 0。
		renderCard({
			statics: { ...STATIC, cpuBudget: 0.5, memSource: "cgroup", memTotal: 2 * GB },
			history: [sample({ hostCpu: 0.61, procCpu: 0.8 })],
		});
		const segs = segmentsOf("CPU 占用");
		expect(segs[0]).toBeCloseTo(0.1, 4);
		expect(segs[1]).toBeCloseTo(0.51, 4);
		expect(screen.getByText(/本体 10%/)).toBeTruthy();
	});

	it("本体量出来比总量还大(读数不同步)时,「其他」那段夹到 0 不倒着画", () => {
		renderCard({ history: [sample({ hostCpu: 0.1, procCpu: 0.2 })] });
		const segs = segmentsOf("CPU 占用");
		expect(segs).toHaveLength(1);
		expect(segs[0]).toBeCloseTo(0.2, 4);
	});

	it("两个环各自念自己的名字,读屏器分得清", () => {
		renderCard();
		expect(screen.getByTitle("CPU 占用")).toBeTruthy();
		expect(screen.getByTitle("内存占用")).toBeTruthy();
	});

	it("CPU 型号与核数退成辅助小字,仍然在卡上", () => {
		renderCard();
		expect(screen.getByText(/AMD EPYC 7K62/)).toBeTruthy();
		expect(screen.getByText(/4 核/)).toBeTruthy();
	});

	it("堆占比从环上退下来,但徽章与那行字还在 —— 它才是离 FATAL 多远", () => {
		renderCard({ history: [sample({ heapUsed: 460 * MB })] });
		// 460/512 = 90%
		expect(screen.getByText("堆 90%")).toBeTruthy();
		expect(screen.getByText(/460 MB \/ 512 MB/)).toBeTruthy();
	});

	it("还没收到第一帧:画读取中,不画一堆 0", () => {
		renderCard({ statics: null, history: [] });
		expect(screen.queryByTitle("内存占用")).toBeNull();
		expect(screen.getByRole("status")).toBeTruthy();
	});

	it("首帧没有 CPU 比例(没有上一次可比)时显示「—」,不显示 0%", () => {
		renderCard({ history: [sample({ hostCpu: null, procCpu: null })] });
		// 环心与底下那句都要说「没量到」;显示 0% 会被读成「一点都没用」。
		expect(screen.getByText("—")).toBeTruthy();
		expect(screen.getByText(/本体 —/)).toBeTruthy();
		// 而且一段弧都不画 —— 画一整圈灰的等于说「全被别人占了」。
		expect(segmentsOf("CPU 占用")).toHaveLength(0);
	});

	/**
	 * 🔴 **量不到不是 0。** `procCpu` 读不出来(首帧、或 cgroup 里拿不到核数)时,本体那段
	 * 被当成 0 画,整圈于是涂成「其他」—— 屏幕上白纸黑字写着「这台机器忙成这样,一点都
	 * 不是我们」。那正是排查时最会把人带偏的一句话,而文件头第一条要求就是「量不到就说
	 * 量不到」。
	 */
	it("总量有、本体量不到:整圈不许涂成「其他」,那是一句假话", () => {
		renderCard({ history: [sample({ hostCpu: 0.61, procCpu: null })] });
		// 底下那句照旧说「—」
		expect(screen.getByText(/本体 —/)).toBeTruthy();
		// 环心还是总占用 —— 这一格是量到了的
		expect(screen.getByText("61%")).toBeTruthy();
		const arcs = arcsOf("CPU 占用");
		expect(arcs.every((a) => a.color !== REST_TONE)).toBe(true);
	});

	it("浏览器那一行:四种状态四句话,不是「有 / 没有」", () => {
		const cases: Array<[ResourceSample["browserState"], RegExp]> = [
			["none", /未接入/],
			["closed", /空闲已关/],
			["remote", /远程/],
		];
		for (const [state, text] of cases) {
			renderCard({ history: [sample({ browserState: state })] });
			expect(screen.getByText(text), `${state} 那一行`).toBeTruthy();
			cleanup();
		}
		renderCard({ history: [sample({ browserState: "running", browserRss: 620 * MB })] });
		expect(screen.getByText("620 MB")).toBeTruthy();
	});

	it("后端失联:不拿最后一次的快照继续画,整卡说「失联」", () => {
		renderCard({ reachable: false });
		// 徽章一句、正文一句 —— 徽章让人一眼看见,正文说清「为什么这里空了」。
		expect(screen.getAllByText(/失联/).length).toBe(2);
		expect(screen.getByRole("alert")).toBeTruthy();
		expect(screen.queryByTitle("内存占用")).toBeNull();
	});
});

describe("heapTone", () => {
	it("平时是粉的", () => {
		expect(heapTone(0.41)).toBe("var(--color-bn-pink)");
	});

	it("到 85% 转警示色 —— 与服务端那条 warn 用同一个阈值", () => {
		// 环变色和日志出 warn 必须同时发生;两边各拍一个数就会出现「日志喊了环还是粉的」。
		expect(heapTone(0.84)).toBe("var(--color-bn-pink)");
		expect(heapTone(0.85)).toBe("var(--color-bn-warning)");
	});

	it("到 95% 转红", () => {
		expect(heapTone(0.94)).toBe("var(--color-bn-warning)");
		expect(heapTone(0.95)).toBe("var(--color-bn-danger)");
	});
});
