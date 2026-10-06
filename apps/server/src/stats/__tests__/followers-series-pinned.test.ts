/**
 * `dailyFansSeries` 本身的现状钉子(㉘a)—— 与 `__tests__/followers-display-pinned.test.ts`(走路由)配对:
 * 这里直接把**全部**样本(包括窗口之前的)喂给聚合函数,所以「窗口第一天前面有没有样本」两种情况都看得到。
 *
 * ㉘c 之后只许改 {@link sampleRow}(输入夹具的形状),期望一个都不许动。三个时区各验同一份数据:
 * tz=0、tz=-480(UTC+8)、tz=300(UTC-5)。夹具跨 30 天,含长平段、缺口、一天一两条、压在日界与整点上的样本。
 */

import { describe, expect, it } from "vite-plus/test";
import { dailyFansSeries } from "../aggregate.js";

const NOW = new Date("2026-06-30T12:00:00.000Z");
const at = (iso: string) => Date.parse(iso);

/** ㉘c 只改这一个帮手:喂给聚合函数的一条粉丝样本。 */
function sampleRow(atMs: number, value: number): { ts: string; value: number } {
	return { ts: new Date(atMs).toISOString(), value };
}
const rows = (list: Array<[string, number]>) => list.map(([iso, v]) => sampleRow(at(iso), v));

/** 06-01 .. 06-30 的日标(三个时区下这 30 天的本地日号恰好一样)。 */
const DAYS = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);

/** 30 个 null,把「日号 − 1」处换成给定的值。 */
function days30(cells: Record<number, number | undefined>, length = 30): Array<number | null> {
	return Array.from({ length }, (_, i) => cells[i] ?? null);
}

const TZS = [0, -480, 300] as const;

// flat:窗口之前(05-20)有一条 6990;06-03..06-12 平在 7000(一天两条);06-13 涨到 7010;06-14、06-15 缺;06-16 仍 7010;06-17 涨到 7025;06-30 才又有一条。
const FLAT = rows([
	["2026-05-20T10:00:00.000Z", 6990],
	["2026-06-03T10:00:00.000Z", 7000],
	...[4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((d): Array<[string, number]> => {
		const day = String(d).padStart(2, "0");
		return [
			[`2026-06-${day}T10:00:00.000Z`, 7000],
			[`2026-06-${day}T22:00:00.000Z`, 7000],
		];
	}),
	["2026-06-13T10:00:00.000Z", 7010],
	["2026-06-16T10:00:00.000Z", 7010],
	["2026-06-17T09:00:00.000Z", 7025],
	["2026-06-30T11:00:00.000Z", 7025],
]);

const EDGE = rows([
	["2026-06-10T00:00:00.000Z", 100],
	["2026-06-10T05:00:00.000Z", 105],
	["2026-06-10T15:59:59.999Z", 110],
	["2026-06-10T16:00:00.000Z", 120],
	["2026-06-10T23:59:59.999Z", 130],
	["2026-06-11T00:00:00.000Z", 140],
	["2026-06-11T04:59:59.999Z", 150],
	["2026-06-12T13:00:00.000Z", 160],
	["2026-06-12T13:59:59.999Z", 165],
	["2026-06-12T14:00:00.000Z", 170],
]);

const SPARSE = rows([
	["2026-06-20T08:00:00.000Z", 900],
	["2026-06-20T20:00:00.000Z", 905],
	["2026-06-21T09:30:00.000Z", 905],
	["2026-06-25T03:00:00.000Z", 880],
]);

describe("dailyFansSeries — 30 天窗口、三个时区各一遍", () => {
	// 验红:把 `priorValue` 里 `found = lastByDay.get(d)` 改成 `found = undefined`(不回溯基线),所有净增变 null,本组红。
	it.each(TZS)(
		"窗口首个有样本的日前面还有样本(窗口之外 05-20)→ 净增照算(+10);缺口之后链到缺口前的末值 [tz=%i]",
		(tz) => {
			const got = dailyFansSeries(FLAT, { days: 30, tzOffsetMin: tz, now: NOW });
			expect(got.map((p) => p.d)).toEqual(DAYS);
			expect(got.map((p) => p.net)).toEqual(
				days30({
					2: 10,
					3: 0,
					4: 0,
					5: 0,
					6: 0,
					7: 0,
					8: 0,
					9: 0,
					10: 0,
					11: 0,
					12: 10,
					15: 0,
					16: 15,
					29: 0,
				}),
			);
			expect(got.map((p) => p.value)).toEqual(
				days30({
					2: 7000,
					3: 7000,
					4: 7000,
					5: 7000,
					6: 7000,
					7: 7000,
					8: 7000,
					9: 7000,
					10: 7000,
					11: 7000,
					12: 7010,
					15: 7010,
					16: 7025,
					29: 7025,
				}),
			);
		},
	);

	// 验红:把 `net: base === undefined ? null : value - base` 改成 `value === base` 时也回 null,06-04..06-12 的 0 变 null,红;把「没样本回 null」改成回 0(`net: 0`)同样红。
	it("整天有样本但粉丝数没变 → 净增是 0,不是 null;整天没样本 → null,不是 0", () => {
		const got = dailyFansSeries(FLAT, { days: 30, tzOffsetMin: 0, now: NOW });
		// 06-05(下标 4)有样本无变化。
		expect(got[4]).toEqual({ d: "2026-06-05", net: 0, value: 7000 });
		// 06-14(下标 13)是缺口。
		expect(got[13]).toEqual({ d: "2026-06-14", net: null, value: null });
		// 06-30:缺了 12 天之后的第一条,与 06-17 的末值比 → 0(现状:吃下整段缺口)。
		expect(got[29]).toEqual({ d: "2026-06-30", net: 0, value: 7025 });
	});

	// 验红:把 dailyFansSeries 里 localKey 的符号写反(`utcMs + tz * 60_000`),tz=-480 与 tz=300 的日归属错位,红(tz=0 本来就没有符号之分)。
	it.each([
		{ tz: 0, net: { 10: 20, 11: 20 }, value: { 9: 130, 10: 150, 11: 170 } },
		{ tz: -480, net: { 10: 40, 11: 20 }, value: { 9: 110, 10: 150, 11: 170 } },
		{ tz: 300, net: { 9: 50, 11: 20 }, value: { 8: 100, 9: 150, 11: 170 } },
	])("压在本地日边界与整点上的样本:取该本地日的末值 [tz=$tz]", ({ tz, net, value }) => {
		const got = dailyFansSeries(EDGE, { days: 30, tzOffsetMin: tz, now: NOW });
		expect(got.map((p) => p.net)).toEqual(days30(net));
		expect(got.map((p) => p.value)).toEqual(days30(value));
	});

	// 验红:把日末值改成日首值(`if (!lastByDay.has(k)) lastByDay.set(...)`),tz=0 与 tz=300 的 06-20 末值 905 变成首值 900,红(tz=-480 下那天只有一条,不受影响)。
	it.each([
		{ tz: 0, net: { 20: 0, 24: -25 }, value: { 19: 905, 20: 905, 24: 880 } },
		{ tz: -480, net: { 20: 5, 24: -25 }, value: { 19: 900, 20: 905, 24: 880 } },
		{ tz: 300, net: { 20: 0, 23: -25 }, value: { 19: 905, 20: 905, 23: 880 } },
	])("一天一两条样本:取当日末值,掉粉是负数 [tz=$tz]", ({ tz, net, value }) => {
		const got = dailyFansSeries(SPARSE, { days: 30, tzOffsetMin: tz, now: NOW });
		expect(got.map((p) => p.net)).toEqual(days30(net));
		expect(got.map((p) => p.value)).toEqual(days30(value));
	});

	// 现状:窗口第一天的净增 = 它与「窗口之前最近一个有样本的日」的末值差;窗口之前没有任何样本时是 null。
	// sparse 在 7 天窗口(从 06-24 起)里,06-25(tz=300 是 06-24)的 880 与窗口外 06-21 的 905 比 → -25。
	it.each([
		{ tz: 0, net: { 1: -25 }, value: { 1: 880 } },
		{ tz: -480, net: { 1: -25 }, value: { 1: 880 } },
		{ tz: 300, net: { 0: -25 }, value: { 0: 880 } },
	])("7 天窗口的第一个有样本日,基线来自窗口之外的更早样本 [tz=$tz]", ({ tz, net, value }) => {
		const got = dailyFansSeries(SPARSE, { days: 7, tzOffsetMin: tz, now: NOW });
		expect(got.map((p) => p.d)).toEqual(DAYS.slice(23));
		expect(got.map((p) => p.net)).toEqual(days30(net, 7));
		expect(got.map((p) => p.value)).toEqual(days30(value, 7));
	});

	it("窗口之前没有任何样本 → 第一个有样本日的净增是 null(只有值)", () => {
		const got = dailyFansSeries(rows([["2026-06-29T12:00:00.000Z", 50]]), {
			days: 3,
			tzOffsetMin: 0,
			now: NOW,
		});
		expect(got).toEqual([
			{ d: "2026-06-28", net: null, value: null },
			{ d: "2026-06-29", net: null, value: 50 },
			{ d: "2026-06-30", net: null, value: null },
		]);
	});
});
