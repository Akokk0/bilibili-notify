/** 「在记」账的区间合并(ADR-0027 决策 13、15):同一项首尾相接或重叠的区间接成一段。 */
import { describe, expect, it } from "vite-plus/test";
import { compressRecordingEntries } from "../recording-compress.js";
import type { RecordingEntry } from "../store.js";

/** 切线 = 2026-02-21T12:00:00.000Z(同粉丝样本的压缩)。 */
const NOW = new Date("2026-03-01T12:34:56.000Z");
const e = (kind: RecordingEntry["kind"], startedAt: string, endedAt: string): RecordingEntry => ({
	kind,
	startedAt,
	endedAt,
});

describe("compressRecordingEntries", () => {
	it("空输入得空", () => {
		expect(compressRecordingEntries([], NOW)).toEqual([]);
	});

	it("单条:原样", () => {
		const one = [e("posts", "2026-02-10T01:00:00.000Z", "2026-02-10T02:00:00.000Z")];
		expect(compressRecordingEntries(one, NOW)).toEqual(one);
	});

	it("首尾相接(a.endedAt === b.startedAt)的接成一段", () => {
		expect(
			compressRecordingEntries(
				[
					e("posts", "2026-02-10T01:00:00.000Z", "2026-02-10T02:00:00.000Z"),
					e("posts", "2026-02-10T02:00:00.000Z", "2026-02-10T03:00:00.000Z"),
					e("posts", "2026-02-10T03:00:00.000Z", "2026-02-10T04:00:00.000Z"),
				],
				NOW,
			),
		).toEqual([e("posts", "2026-02-10T01:00:00.000Z", "2026-02-10T04:00:00.000Z")]);
	});

	it("中间差一毫秒:不接", () => {
		const input = [
			e("posts", "2026-02-10T01:00:00.000Z", "2026-02-10T02:00:00.000Z"),
			e("posts", "2026-02-10T02:00:00.001Z", "2026-02-10T03:00:00.000Z"),
		];
		expect(compressRecordingEntries(input, NOW)).toEqual(input);
	});

	it("重叠的接成一段,结束取较晚的;被完全包住的并进去", () => {
		expect(
			compressRecordingEntries(
				[
					e("live", "2026-02-10T01:00:00.000Z", "2026-02-10T05:00:00.000Z"),
					e("live", "2026-02-10T02:00:00.000Z", "2026-02-10T03:00:00.000Z"),
					e("live", "2026-02-10T04:00:00.000Z", "2026-02-10T06:00:00.000Z"),
				],
				NOW,
			),
		).toEqual([e("live", "2026-02-10T01:00:00.000Z", "2026-02-10T06:00:00.000Z")]);
	});

	it("重复行并掉", () => {
		const row = e("followers", "2026-02-10T01:00:00.000Z", "2026-02-10T02:00:00.000Z");
		expect(compressRecordingEntries([row, { ...row }, { ...row }], NOW)).toEqual([row]);
	});

	it("不同 kind 互不影响", () => {
		const input = [
			e("posts", "2026-02-10T01:00:00.000Z", "2026-02-10T02:00:00.000Z"),
			e("live", "2026-02-10T02:00:00.000Z", "2026-02-10T03:00:00.000Z"),
			e("posts", "2026-02-10T02:00:00.000Z", "2026-02-10T03:00:00.000Z"),
		];
		expect(compressRecordingEntries(input, NOW)).toEqual([
			e("posts", "2026-02-10T01:00:00.000Z", "2026-02-10T03:00:00.000Z"),
			e("live", "2026-02-10T02:00:00.000Z", "2026-02-10T03:00:00.000Z"),
		]);
	});

	it("输出顺序:先按 startedAt、再按 kind(字典序)、再按 endedAt", () => {
		const out = compressRecordingEntries(
			[
				e("posts", "2026-02-10T05:00:00.000Z", "2026-02-10T06:00:00.000Z"),
				e("live", "2026-02-10T05:00:00.000Z", "2026-02-10T06:00:00.000Z"),
				e("followers", "2026-02-10T09:00:00.000Z", "2026-02-10T10:00:00.000Z"),
				e("followers", "2026-02-10T01:00:00.000Z", "2026-02-10T02:00:00.000Z"),
			],
			NOW,
		);
		expect(out.map((x) => `${x.startedAt}|${x.kind}`)).toEqual([
			"2026-02-10T01:00:00.000Z|followers",
			"2026-02-10T05:00:00.000Z|live",
			"2026-02-10T05:00:00.000Z|posts",
			"2026-02-10T09:00:00.000Z|followers",
		]);
	});

	it("乱序输入与升序输入结果相同", () => {
		const asc = [
			e("posts", "2026-02-10T01:00:00.000Z", "2026-02-10T02:00:00.000Z"),
			e("posts", "2026-02-10T02:00:00.000Z", "2026-02-10T03:00:00.000Z"),
			e("live", "2026-02-11T01:00:00.000Z", "2026-02-11T02:00:00.000Z"),
		];
		const shuffled = [2, 1, 0].map((i) => asc[i] as RecordingEntry);
		expect(compressRecordingEntries(shuffled, NOW)).toEqual(compressRecordingEntries(asc, NOW));
	});

	it("结束在切线或之后的行原样保留,不参与合并(含正好结束在切线上的)", () => {
		const input = [
			e("posts", "2026-02-21T11:00:00.000Z", "2026-02-21T12:00:00.000Z"),
			e("posts", "2026-02-21T12:00:00.000Z", "2026-02-21T13:00:00.000Z"),
			e("posts", "2026-02-25T00:00:00.000Z", "2026-02-25T01:00:00.000Z"),
			e("posts", "2026-02-25T01:00:00.000Z", "2026-02-25T02:00:00.000Z"),
		];
		expect(compressRecordingEntries(input, NOW)).toEqual(input);
	});

	it("跨线的行原样留着:不被拆开,前面整段在线前的照合", () => {
		const before = e("posts", "2026-02-21T08:00:00.000Z", "2026-02-21T09:00:00.000Z");
		const touching = e("posts", "2026-02-21T09:00:00.000Z", "2026-02-21T10:00:00.000Z");
		const straddler = e("posts", "2026-02-21T10:00:00.000Z", "2026-02-21T14:00:00.000Z");
		expect(compressRecordingEntries([before, touching, straddler], NOW)).toEqual([
			e("posts", "2026-02-21T08:00:00.000Z", "2026-02-21T10:00:00.000Z"),
			straddler,
		]);
	});

	it("幂等", () => {
		const input = [
			e("posts", "2026-02-10T01:00:00.000Z", "2026-02-10T02:00:00.000Z"),
			e("posts", "2026-02-10T01:30:00.000Z", "2026-02-10T03:00:00.000Z"),
			e("live", "2026-02-12T01:00:00.000Z", "2026-02-12T02:00:00.000Z"),
			e("posts", "2026-02-21T10:00:00.000Z", "2026-02-21T14:00:00.000Z"),
			e("posts", "2026-02-27T10:00:00.000Z", "2026-02-27T11:00:00.000Z"),
		];
		const once = compressRecordingEntries(input, NOW);
		expect(compressRecordingEntries(once, NOW)).toEqual(once);
	});

	it("now 往后挪:先压再压等于一次压到后一个 now;之前合好的不被拆", () => {
		const input = [
			e("posts", "2026-02-10T01:00:00.000Z", "2026-02-10T02:00:00.000Z"),
			e("posts", "2026-02-10T02:00:00.000Z", "2026-02-10T03:00:00.000Z"),
			e("posts", "2026-02-21T10:00:00.000Z", "2026-02-21T14:00:00.000Z"),
			e("posts", "2026-02-21T14:00:00.000Z", "2026-02-22T00:00:00.000Z"),
		];
		const later = new Date("2026-03-10T00:00:00.000Z");
		const stepwise = compressRecordingEntries(compressRecordingEntries(input, NOW), later);
		expect(stepwise).toEqual(compressRecordingEntries(input, later));
		expect(stepwise).toEqual([
			e("posts", "2026-02-10T01:00:00.000Z", "2026-02-10T03:00:00.000Z"),
			e("posts", "2026-02-21T10:00:00.000Z", "2026-02-22T00:00:00.000Z"),
		]);
	});

	it("一年里每小时一行、一直在记:切线前只剩 1 行", () => {
		const input: RecordingEntry[] = [];
		const start = Date.parse("2025-03-01T00:00:00.000Z");
		for (let i = 0; i < 8760; i++) {
			input.push(
				e(
					"followers",
					new Date(start + i * 3_600_000).toISOString(),
					new Date(start + (i + 1) * 3_600_000).toISOString(),
				),
			);
		}
		const out = compressRecordingEntries(input, NOW);
		expect(out.filter((x) => x.endedAt < "2026-02-21T12:00:00.000Z")).toHaveLength(1);
	});
});
