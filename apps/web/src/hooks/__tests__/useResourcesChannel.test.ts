import type { ResourceSample, ResourcesHydrate } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { HISTORY_KEEP, type ResourcesState, reduceResources } from "../useResourcesChannel";

/**
 * `resources` 频道的落地规则 —— 概览页资源卡看到的那份状态。
 *
 * 服务端每 2 秒推一帧,断线重连会重新 hydrate。规则就三条:hydrate 整份换掉、sample 追加、
 * 缓冲不许无限长(这一页可以开着一整天)。
 */

const MB = 1024 * 1024;

function sample(ts: number, heapUsed = 210 * MB): ResourceSample {
	return {
		ts,
		hostCpu: 0.6,
		procCpu: 0.2,
		heapUsed,
		rss: 340 * MB,
		memUsed: 5 * 1024 * MB,
		browserRss: null,
		browserState: "none",
	};
}

function hydrate(history: ResourceSample[]): ResourcesHydrate {
	return {
		static: {
			cpuModel: "AMD EPYC 7K62 48-Core Processor",
			hostCores: 4,
			cpuBudget: 4,
			memTotal: 8 * 1024 * MB,
			memSource: "host",
			heapLimit: 512 * MB,
		},
		history,
	};
}

const EMPTY: ResourcesState = { static: null, history: [] };

describe("reduceResources", () => {
	it("hydrate 落地静态量与那段历史", () => {
		const next = reduceResources(EMPTY, {
			event: "hydrate",
			data: hydrate([sample(1), sample(2)]),
		});
		expect(next.static?.hostCores).toBe(4);
		expect(next.history.map((s) => s.ts)).toEqual([1, 2]);
	});

	it("sample 追加在末尾", () => {
		const base = reduceResources(EMPTY, { event: "hydrate", data: hydrate([sample(1)]) });
		const next = reduceResources(base, { event: "sample", data: sample(2) });
		expect(next.history.map((s) => s.ts)).toEqual([1, 2]);
		// 静态量不会被样本帧冲掉。
		expect(next.static?.heapLimit).toBe(512 * MB);
	});

	it("缓冲有上限:这一页可以开着一整天,不封顶就是一路涨的数组", () => {
		let state = reduceResources(EMPTY, { event: "hydrate", data: hydrate([]) });
		for (let i = 0; i < HISTORY_KEEP + 50; i++) {
			state = reduceResources(state, { event: "sample", data: sample(i) });
		}
		expect(state.history).toHaveLength(HISTORY_KEEP);
		expect(state.history[0]?.ts).toBe(50);
	});

	it("重连后的 hydrate 整份换掉,不跟断线前的接在一起", () => {
		const base = reduceResources(EMPTY, {
			event: "hydrate",
			data: hydrate([sample(1), sample(2)]),
		});
		const after = reduceResources(base, { event: "hydrate", data: hydrate([sample(90)]) });
		// 断线那几分钟是空的,拼起来的曲线会把一段不存在的平直读成「稳定」。
		expect(after.history.map((s) => s.ts)).toEqual([90]);
	});

	it("还没 hydrate 就先来了 sample:丢掉,不拿没有静态量的样本画图", () => {
		// 没有堆上限就算不出占比,画出来的环是假的。
		const next = reduceResources(EMPTY, { event: "sample", data: sample(1) });
		expect(next).toBe(EMPTY);
	});

	it("不认识的 event 原样返回同一个对象 —— 不触发无谓重渲染", () => {
		const base = reduceResources(EMPTY, { event: "hydrate", data: hydrate([sample(1)]) });
		expect(reduceResources(base, { event: "whatever", data: null })).toBe(base);
	});
});
