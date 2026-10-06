/**
 * 粉丝样本压缩(ADR-0027 决策 8、15):8 天内原样,更早的按 UTC 整点小时留最晚一条,
 * 相邻小时同值合成一段。纯函数,`now` 由参数传进来。
 */
import { describe, expect, it } from "vite-plus/test";
import { compressFollowersSamples } from "../compress.js";
import type { FollowersSample } from "../sample.js";

/** 切线 = 2026-03-01T12:34:56Z 往前 192 小时 = 02-21T12:34:56,向下取整到整点 = 02-21T12:00。 */
const NOW = new Date("2026-03-01T12:34:56.000Z");
const p = (sampledAt: string, followers: number): FollowersSample => ({ sampledAt, followers });
const seg = (sampledAt: string, followers: number, lastSampledAt: string): FollowersSample => ({
	sampledAt,
	followers,
	lastSampledAt,
});

describe("compressFollowersSamples:基本形状", () => {
	it("空输入得空", () => {
		expect(compressFollowersSamples([], NOW)).toEqual([]);
	});

	it("切线及之后的样本原样保留(含正好压在切线上的那条)", () => {
		const input = [
			p("2026-02-21T12:00:00.000Z", 5),
			p("2026-02-21T12:10:00.000Z", 5),
			p("2026-02-21T12:20:00.000Z", 6),
			p("2026-03-01T12:30:00.000Z", 6),
		];
		expect(compressFollowersSamples(input, NOW)).toEqual(input);
	});

	it("切线前一毫秒的样本算切线之前:自己成一个点,不和切线上的那条合并", () => {
		const input = [p("2026-02-21T11:59:59.999Z", 5), p("2026-02-21T12:00:00.000Z", 5)];
		expect(compressFollowersSamples(input, NOW)).toEqual(input);
	});

	it("切线前只有一条:成一个点,保留真实时刻、不取整", () => {
		expect(compressFollowersSamples([p("2026-02-10T05:10:33.000Z", 100)], NOW)).toEqual([
			p("2026-02-10T05:10:33.000Z", 100),
		]);
	});

	it("同一小时多条只留时刻最晚的那条", () => {
		const input = [
			p("2026-02-10T05:10:00.000Z", 100),
			p("2026-02-10T05:40:00.000Z", 103),
			p("2026-02-10T05:20:00.000Z", 101),
		];
		expect(compressFollowersSamples(input, NOW)).toEqual([p("2026-02-10T05:40:00.000Z", 103)]);
	});

	it("整点那一刻属于新的一小时,前一毫秒属于上一小时", () => {
		// 两个小时、不同值:各自成点
		const diff = [p("2026-02-10T04:59:59.999Z", 8), p("2026-02-10T05:00:00.000Z", 9)];
		expect(compressFollowersSamples(diff, NOW)).toEqual(diff);
		// 同值:相邻小时合成一段,两端取真实时刻
		expect(
			compressFollowersSamples(
				[p("2026-02-10T04:59:59.999Z", 8), p("2026-02-10T05:00:00.000Z", 8)],
				NOW,
			),
		).toEqual([seg("2026-02-10T04:59:59.999Z", 8, "2026-02-10T05:00:00.000Z")]);
	});

	it("相邻小时同值合成段;中间缺一小时的不合", () => {
		const input = [
			p("2026-02-10T05:10:00.000Z", 101),
			p("2026-02-10T05:40:00.000Z", 101),
			p("2026-02-10T06:20:00.000Z", 101),
			p("2026-02-10T07:50:00.000Z", 101),
			// 08 点整点小时没有样本
			p("2026-02-10T09:00:00.000Z", 101),
		];
		expect(compressFollowersSamples(input, NOW)).toEqual([
			seg("2026-02-10T05:40:00.000Z", 101, "2026-02-10T07:50:00.000Z"),
			p("2026-02-10T09:00:00.000Z", 101),
		]);
	});

	it("值变了又变回来:三个点,不跨过中间那个合并", () => {
		const input = [
			p("2026-02-10T01:30:00.000Z", 10),
			p("2026-02-10T02:30:00.000Z", 20),
			p("2026-02-10T03:30:00.000Z", 10),
		];
		expect(compressFollowersSamples(input, NOW)).toEqual(input);
	});

	it("两小时同值、再变值:段 + 点", () => {
		const input = [
			p("2026-02-10T01:30:00.000Z", 10),
			p("2026-02-10T02:30:00.000Z", 10),
			p("2026-02-10T03:30:00.000Z", 11),
		];
		expect(compressFollowersSamples(input, NOW)).toEqual([
			seg("2026-02-10T01:30:00.000Z", 10, "2026-02-10T02:30:00.000Z"),
			p("2026-02-10T03:30:00.000Z", 11),
		]);
	});

	it("切线前压成的行在前、切线后原样的行在后", () => {
		const input = [
			p("2026-02-10T01:10:00.000Z", 10),
			p("2026-02-10T01:50:00.000Z", 10),
			p("2026-02-25T00:00:00.000Z", 12),
		];
		expect(compressFollowersSamples(input, NOW)).toEqual([
			p("2026-02-10T01:50:00.000Z", 10),
			p("2026-02-25T00:00:00.000Z", 12),
		]);
	});
});

describe("compressFollowersSamples:认得段", () => {
	it("输入里的段能和后面相邻同值的小时接上", () => {
		const input = [
			seg("2026-02-10T05:40:00.000Z", 101, "2026-02-10T07:50:00.000Z"),
			p("2026-02-10T08:20:00.000Z", 101),
			p("2026-02-10T09:20:00.000Z", 102),
		];
		expect(compressFollowersSamples(input, NOW)).toEqual([
			seg("2026-02-10T05:40:00.000Z", 101, "2026-02-10T08:20:00.000Z"),
			p("2026-02-10T09:20:00.000Z", 102),
		]);
	});

	it("两段首尾相邻同值:合成一段", () => {
		const input = [
			seg("2026-02-10T01:10:00.000Z", 7, "2026-02-10T03:10:00.000Z"),
			seg("2026-02-10T04:10:00.000Z", 7, "2026-02-10T06:10:00.000Z"),
		];
		expect(compressFollowersSamples(input, NOW)).toEqual([
			seg("2026-02-10T01:10:00.000Z", 7, "2026-02-10T06:10:00.000Z"),
		]);
	});

	it("两段之间缺一小时:不合、各自原样", () => {
		const input = [
			seg("2026-02-10T01:10:00.000Z", 7, "2026-02-10T03:10:00.000Z"),
			seg("2026-02-10T05:10:00.000Z", 7, "2026-02-10T06:10:00.000Z"),
		];
		expect(compressFollowersSamples(input, NOW)).toEqual(input);
	});

	it("相邻但值不同的两段不合", () => {
		const input = [
			seg("2026-02-10T01:10:00.000Z", 7, "2026-02-10T03:10:00.000Z"),
			seg("2026-02-10T04:10:00.000Z", 8, "2026-02-10T06:10:00.000Z"),
		];
		expect(compressFollowersSamples(input, NOW)).toEqual(input);
	});

	it("跨线的段(结束在切线或之后)原样留着,不被拆也不被合", () => {
		const straddler = seg("2026-02-21T10:10:00.000Z", 7, "2026-02-21T14:10:00.000Z");
		const input = [p("2026-02-21T08:10:00.000Z", 7), straddler];
		expect(compressFollowersSamples(input, NOW)).toEqual([
			p("2026-02-21T08:10:00.000Z", 7),
			straddler,
		]);
	});
});

describe("compressFollowersSamples:乱序与重复", () => {
	it("乱序输入与升序输入结果相同", () => {
		const asc = [
			p("2026-02-10T01:30:00.000Z", 10),
			p("2026-02-10T02:30:00.000Z", 10),
			p("2026-02-10T03:30:00.000Z", 11),
			p("2026-02-25T00:00:00.000Z", 12),
		];
		const shuffled = [3, 1, 0, 2].map((i) => asc[i] as FollowersSample);
		expect(compressFollowersSamples(shuffled, NOW)).toEqual(compressFollowersSamples(asc, NOW));
	});

	it("相同时刻有多条:取后出现的(切线前后都一样)", () => {
		const input = [p("2026-02-10T01:30:00.000Z", 10), p("2026-02-10T01:30:00.000Z", 99)];
		expect(compressFollowersSamples(input, NOW)).toEqual([p("2026-02-10T01:30:00.000Z", 99)]);
		const kept = [p("2026-02-28T01:30:00.000Z", 1), p("2026-02-28T01:30:00.000Z", 2)];
		expect(compressFollowersSamples(kept, NOW)).toEqual([p("2026-02-28T01:30:00.000Z", 2)]);
	});

	it("不改动传进来的数组", () => {
		const input = [p("2026-02-10T02:30:00.000Z", 10), p("2026-02-10T01:30:00.000Z", 10)];
		const copy = structuredClone(input);
		compressFollowersSamples(input, NOW);
		expect(input).toEqual(copy);
	});
});

describe("compressFollowersSamples:幂等与随 now 前移", () => {
	const START = Date.parse("2026-02-01T00:00:00.000Z");
	const raw = (): FollowersSample[] => {
		const out: FollowersSample[] = [];
		// 02-01 到 02-27,每 20 分钟一条,值按「每 5 小时涨 1」走,挖掉 02-12 一整天。
		for (let t = START; t < Date.parse("2026-02-27T00:00:00.000Z"); t += 20 * 60_000) {
			if (new Date(t).toISOString().slice(8, 10) === "12") continue;
			out.push(p(new Date(t).toISOString(), Math.floor((t - START) / (5 * 3_600_000))));
		}
		return out;
	};

	it("对输出再压一次,同一个 now 结果逐项相同", () => {
		const once = compressFollowersSamples(raw(), NOW);
		expect(compressFollowersSamples(once, NOW)).toEqual(once);
	});

	it("now 往后挪时,先压再压等于一次压到后一个 now", () => {
		const later = new Date("2026-03-04T03:00:00.000Z");
		const step = compressFollowersSamples(compressFollowersSamples(raw(), NOW), later);
		expect(step).toEqual(compressFollowersSamples(raw(), later));
	});

	it("now 往后挪时,压好的段不被拆散,只会接上新的", () => {
		const input = [
			p("2026-02-10T01:10:00.000Z", 5),
			p("2026-02-10T02:10:00.000Z", 5),
			p("2026-02-10T03:10:00.000Z", 5),
			p("2026-02-22T00:00:00.000Z", 5),
			p("2026-02-22T01:00:00.000Z", 5),
		];
		const first = compressFollowersSamples(input, NOW);
		expect(first[0]).toEqual(seg("2026-02-10T01:10:00.000Z", 5, "2026-02-10T03:10:00.000Z"));
		const later = compressFollowersSamples(first, new Date("2026-03-20T00:00:00.000Z"));
		expect(later).toEqual([
			seg("2026-02-10T01:10:00.000Z", 5, "2026-02-10T03:10:00.000Z"),
			seg("2026-02-22T00:00:00.000Z", 5, "2026-02-22T01:00:00.000Z"),
		]);
	});
});

describe("compressFollowersSamples:量级", () => {
	const NOW_BIG = new Date("2026-03-01T12:30:00.000Z");
	const YEAR_START = NOW_BIG.getTime() - (52_560 - 1) * 600_000;
	const cutoffIso = "2026-02-21T12:00:00.000Z";
	const make = (followersAt: (i: number) => number): FollowersSample[] => {
		const out: FollowersSample[] = [];
		for (let i = 0; i < 52_560; i++) {
			out.push(p(new Date(YEAR_START + i * 600_000).toISOString(), followersAt(i)));
		}
		return out;
	};

	it("一年每 10 分钟一条、值几乎每次都变:输出 ≤ 8 天原样的行数 + 约 357×24", () => {
		const input = make((i) => i);
		expect(input).toHaveLength(52_560);
		const keptCount = input.filter((s) => s.sampledAt >= cutoffIso).length;
		const out = compressFollowersSamples(input, NOW_BIG);
		expect(out.length).toBeLessThanOrEqual(keptCount + 357 * 24 + 24);
		expect(out.length).toBeGreaterThan(keptCount);
		// 切线之后的原样
		expect(out.filter((s) => s.sampledAt >= cutoffIso)).toEqual(
			input.filter((s) => s.sampledAt >= cutoffIso),
		);
	});

	it("同样时长但值一直不变:切线前只剩 1 条段", () => {
		const out = compressFollowersSamples(
			make(() => 42),
			NOW_BIG,
		);
		const before = out.filter((s) => s.sampledAt < cutoffIso);
		expect(before).toHaveLength(1);
		expect(before[0]?.lastSampledAt).toBeDefined();
		expect(before[0]?.followers).toBe(42);
	});
});
