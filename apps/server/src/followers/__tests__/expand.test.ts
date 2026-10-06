/**
 * 段展开:每个小时一个点;窗口裁剪;以及「压缩前后逐小时末值不变」的性质。
 * 中间小时的点时刻 = 那个小时的最后一毫秒(`hh:59:59.999`)。
 */
import { describe, expect, it } from "vite-plus/test";
import { compressFollowersSamples } from "../compress.js";
import { expandFollowersSamples } from "../expand.js";
import type { FollowersSample } from "../sample.js";

const p = (sampledAt: string, followers: number): FollowersSample => ({ sampledAt, followers });
const seg = (sampledAt: string, followers: number, lastSampledAt: string): FollowersSample => ({
	sampledAt,
	followers,
	lastSampledAt,
});
const times = (rows: readonly FollowersSample[]) => rows.map((s) => s.sampledAt);

describe("expandFollowersSamples", () => {
	it("空输入得空", () => {
		expect(expandFollowersSamples([])).toEqual([]);
	});

	it("点原样通过", () => {
		const input = [p("2026-02-10T05:40:00.000Z", 1), p("2026-02-10T06:10:00.000Z", 2)];
		expect(expandFollowersSamples(input)).toEqual(input);
	});

	it("段展开:首点用 sampledAt、末点用 lastSampledAt、中间每小时一个点", () => {
		expect(
			expandFollowersSamples([seg("2026-02-10T05:40:00.000Z", 101, "2026-02-10T08:20:00.000Z")]),
		).toEqual([
			p("2026-02-10T05:40:00.000Z", 101),
			p("2026-02-10T06:59:59.999Z", 101),
			p("2026-02-10T07:59:59.999Z", 101),
			p("2026-02-10T08:20:00.000Z", 101),
		]);
	});

	it("只跨两个相邻小时的段:两个点,没有中间点", () => {
		expect(
			expandFollowersSamples([seg("2026-02-10T05:40:00.000Z", 3, "2026-02-10T06:10:00.000Z")]),
		).toEqual([p("2026-02-10T05:40:00.000Z", 3), p("2026-02-10T06:10:00.000Z", 3)]);
	});

	it("跨午夜的段:小时序号连续", () => {
		expect(
			expandFollowersSamples([seg("2026-02-10T22:30:00.000Z", 4, "2026-02-11T01:05:00.000Z")]),
		).toEqual([
			p("2026-02-10T22:30:00.000Z", 4),
			p("2026-02-10T23:59:59.999Z", 4),
			p("2026-02-11T00:59:59.999Z", 4),
			p("2026-02-11T01:05:00.000Z", 4),
		]);
	});

	it("展开的结果按时刻升序(点与段混排)", () => {
		const out = expandFollowersSamples([
			p("2026-02-10T01:00:00.000Z", 1),
			seg("2026-02-10T02:40:00.000Z", 2, "2026-02-10T05:10:00.000Z"),
			p("2026-02-10T05:50:00.000Z", 3),
		]);
		expect(out).toHaveLength(6);
		expect(times(out)).toEqual([...times(out)].sort());
	});

	describe("窗口 { sinceIso }", () => {
		const input = [seg("2026-02-10T05:40:00.000Z", 101, "2026-02-10T08:20:00.000Z")];

		it("窗口早于全部:全回", () => {
			expect(expandFollowersSamples(input, { sinceIso: "2026-02-01T00:00:00.000Z" })).toHaveLength(
				4,
			);
		});

		it("窗口起点正好是段起点:含它(≥)", () => {
			expect(
				times(expandFollowersSamples(input, { sinceIso: "2026-02-10T05:40:00.000Z" })),
			).toEqual([
				"2026-02-10T05:40:00.000Z",
				"2026-02-10T06:59:59.999Z",
				"2026-02-10T07:59:59.999Z",
				"2026-02-10T08:20:00.000Z",
			]);
		});

		it("窗口起点落在段中间:裁掉之前的部分,窗口内的小时一个不丢,段起点那个点不漏进来", () => {
			expect(
				times(expandFollowersSamples(input, { sinceIso: "2026-02-10T07:00:00.000Z" })),
			).toEqual(["2026-02-10T07:59:59.999Z", "2026-02-10T08:20:00.000Z"]);
		});

		it("窗口起点正好是某个小时点的时刻:含它", () => {
			expect(
				times(expandFollowersSamples(input, { sinceIso: "2026-02-10T06:59:59.999Z" })),
			).toEqual([
				"2026-02-10T06:59:59.999Z",
				"2026-02-10T07:59:59.999Z",
				"2026-02-10T08:20:00.000Z",
			]);
		});

		it("窗口起点晚于段末点:空", () => {
			expect(expandFollowersSamples(input, { sinceIso: "2026-02-10T08:20:00.001Z" })).toEqual([]);
		});

		it("点按窗口筛;窗口前的点被丢", () => {
			const pts = [p("2026-02-10T01:00:00.000Z", 1), p("2026-02-10T02:00:00.000Z", 2)];
			expect(expandFollowersSamples(pts, { sinceIso: "2026-02-10T01:00:00.001Z" })).toEqual([
				pts[1],
			]);
		});
	});
});

/** 写死种子的小生成器(mulberry32),不用 Math.random。 */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const HOUR = 3_600_000;
const hourOf = (iso: string) => Math.floor(Date.parse(iso) / HOUR);

/** 逐小时取末值:按时刻稳定排序,后到的覆盖先到的(同时刻即后出现的)。只看 beforeHour 之前的小时。 */
function lastValueByHour(
	samples: readonly FollowersSample[],
	beforeHour: number,
): [number, number][] {
	const sorted = samples
		.map((s, i) => ({ s, i }))
		.sort((a, b) => Date.parse(a.s.sampledAt) - Date.parse(b.s.sampledAt) || a.i - b.i)
		.map((x) => x.s);
	const map = new Map<number, number>();
	for (const s of sorted) {
		const h = hourOf(s.sampledAt);
		if (h < beforeHour) map.set(h, s.followers);
	}
	return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

describe("性质:压缩再展开,切线之前逐小时的末值与原始样本相同", () => {
	const NOW = new Date("2026-03-01T12:34:56.000Z");
	const cutoffHour = Math.floor((NOW.getTime() - 192 * HOUR) / HOUR);

	const check = (raw: FollowersSample[]) => {
		const expanded = expandFollowersSamples(compressFollowersSamples(raw, NOW));
		expect(lastValueByHour(expanded, cutoffHour)).toEqual(lastValueByHour(raw, cutoffHour));
	};

	it("手写:连续同值 + 缺口 + 变值", () => {
		check([
			p("2026-02-10T05:10:00.000Z", 1),
			p("2026-02-10T05:50:00.000Z", 2),
			p("2026-02-10T06:10:00.000Z", 2),
			p("2026-02-10T07:10:00.000Z", 2),
			p("2026-02-10T10:10:00.000Z", 2),
			p("2026-02-10T11:10:00.000Z", 1),
			p("2026-02-10T12:10:00.000Z", 2),
		]);
	});

	it("手写:同一小时多条、整点边界、同时刻重复", () => {
		check([
			p("2026-02-10T04:59:59.999Z", 5),
			p("2026-02-10T05:00:00.000Z", 5),
			p("2026-02-10T05:00:00.000Z", 6),
			p("2026-02-10T05:59:59.999Z", 5),
			p("2026-02-10T06:00:00.000Z", 5),
		]);
	});

	it("手写:切线所在小时附近", () => {
		check([
			p("2026-02-21T10:00:00.000Z", 3),
			p("2026-02-21T11:59:59.999Z", 3),
			p("2026-02-21T12:00:00.000Z", 3),
			p("2026-02-21T13:00:00.000Z", 3),
		]);
	});

	it("手写:展开出来的小时与原始相同时,小时集合也相同(段内每个小时都有点)", () => {
		const raw = [
			p("2026-02-10T01:10:00.000Z", 9),
			p("2026-02-10T02:10:00.000Z", 9),
			p("2026-02-10T03:10:00.000Z", 9),
			p("2026-02-10T04:10:00.000Z", 9),
		];
		const expanded = expandFollowersSamples(compressFollowersSamples(raw, NOW));
		expect(expanded.map((s) => hourOf(s.sampledAt))).toEqual(raw.map((s) => hourOf(s.sampledAt)));
	});

	it("几百组种子写死的伪随机输入(含乱序、重复时刻、缺口、值少所以多合并)", () => {
		for (let seed = 1; seed <= 300; seed++) {
			const r = rng(seed);
			const n = 1 + Math.floor(r() * 120);
			const spanSlots = 24 * 14 * 6;
			const t0 = Date.parse("2026-02-08T00:00:00.000Z");
			const raw: FollowersSample[] = [];
			for (let i = 0; i < n; i++) {
				// 时间取 10 分钟的格点,容易撞出重复时刻;±1 毫秒容易踩整点边界。
				const slot = Math.floor(r() * spanSlots);
				const jitter = [0, 0, 0, -1, 1][Math.floor(r() * 5)] ?? 0;
				raw.push(p(new Date(t0 + slot * 600_000 + jitter).toISOString(), Math.floor(r() * 3)));
			}
			const once = compressFollowersSamples(raw, NOW);
			const expanded = expandFollowersSamples(once);
			expect(lastValueByHour(expanded, cutoffHour), `seed ${seed}`).toEqual(
				lastValueByHour(raw, cutoffHour),
			);
			expect(compressFollowersSamples(once, NOW), `seed ${seed} idempotent`).toEqual(once);
		}
	});
});
