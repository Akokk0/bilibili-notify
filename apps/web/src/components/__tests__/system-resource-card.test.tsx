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

afterEach(cleanup);

describe("SystemResourceCard", () => {
	it("报出 CPU 型号与核数,以及宿主机与本体两档使用率", () => {
		renderCard();
		expect(screen.getByText(/AMD EPYC 7K62/)).toBeTruthy();
		expect(screen.getByText("4")).toBeTruthy();
		// 61% 是宿主机、20% 是本体 —— 只报一个的话看不出「机器忙」和「我们忙」的区别。
		expect(screen.getByText("61%")).toBeTruthy();
		expect(screen.getAllByText("20%").length).toBeGreaterThan(0);
	});

	it("两个环各自念自己的名字,读屏器分得清", () => {
		renderCard();
		expect(screen.getByTitle("CPU 占用")).toBeTruthy();
		expect(screen.getByTitle("堆占用")).toBeTruthy();
	});

	it("还没收到第一帧:画读取中,不画一堆 0", () => {
		renderCard({ statics: null, history: [] });
		expect(screen.queryByTitle("堆占用")).toBeNull();
		expect(screen.getByRole("status")).toBeTruthy();
	});

	it("首帧没有 CPU 比例(没有上一次可比)时显示「—」,不显示 0%", () => {
		renderCard({ history: [sample({ hostCpu: null, procCpu: null })] });
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
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
		expect(screen.queryByTitle("堆占用")).toBeNull();
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
