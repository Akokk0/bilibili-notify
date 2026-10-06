/** 段上的三个查找(输入已按 sampledAt 升序)。 */
import { describe, expect, it } from "vite-plus/test";
import { findEarliestFollowers, findFollowersAtOrBefore, findLatestFollowers } from "../lookup.js";
import type { FollowersSample } from "../sample.js";

const p = (sampledAt: string, followers: number): FollowersSample => ({ sampledAt, followers });
const seg = (sampledAt: string, followers: number, lastSampledAt: string): FollowersSample => ({
	sampledAt,
	followers,
	lastSampledAt,
});

const rows: FollowersSample[] = [
	p("2026-02-10T01:00:00.000Z", 10),
	seg("2026-02-10T05:40:00.000Z", 101, "2026-02-10T08:20:00.000Z"),
	p("2026-02-10T10:00:00.000Z", 120),
];

describe("findEarliestFollowers", () => {
	it("空 → undefined", () => {
		expect(findEarliestFollowers([])).toBeUndefined();
	});
	it("点:只回两格", () => {
		expect(findEarliestFollowers(rows)).toStrictEqual({
			sampledAt: "2026-02-10T01:00:00.000Z",
			followers: 10,
		});
	});
	it("最早是段:取 sampledAt 与值,不带 lastSampledAt", () => {
		expect(findEarliestFollowers([rows[1] as FollowersSample])).toStrictEqual({
			sampledAt: "2026-02-10T05:40:00.000Z",
			followers: 101,
		});
	});
});

describe("findLatestFollowers", () => {
	it("空 → undefined", () => {
		expect(findLatestFollowers([])).toBeUndefined();
	});
	it("最新是点", () => {
		expect(findLatestFollowers(rows)).toStrictEqual({
			sampledAt: "2026-02-10T10:00:00.000Z",
			followers: 120,
		});
	});
	it("最新是段:时刻取 lastSampledAt", () => {
		expect(findLatestFollowers(rows.slice(0, 2))).toStrictEqual({
			sampledAt: "2026-02-10T08:20:00.000Z",
			followers: 101,
		});
	});
});

describe("findFollowersAtOrBefore", () => {
	const at = (iso: string) => findFollowersAtOrBefore(rows, iso);

	it("空 → undefined;早于全部 → undefined", () => {
		expect(findFollowersAtOrBefore([], "2026-02-10T01:00:00.000Z")).toBeUndefined();
		expect(at("2026-02-10T00:59:59.999Z")).toBeUndefined();
	});
	it("正好等于某个点:含它", () => {
		expect(at("2026-02-10T01:00:00.000Z")).toStrictEqual(rows[0]);
	});
	it("落在点与段之间:回前面的点", () => {
		expect(at("2026-02-10T03:00:00.000Z")).toStrictEqual({
			sampledAt: "2026-02-10T01:00:00.000Z",
			followers: 10,
		});
	});
	it("落在段的第一个小时、起点之后(含正好在起点):回段起点", () => {
		expect(at("2026-02-10T05:50:00.000Z")).toStrictEqual({
			sampledAt: "2026-02-10T05:40:00.000Z",
			followers: 101,
		});
		expect(at("2026-02-10T05:40:00.000Z")).toStrictEqual({
			sampledAt: "2026-02-10T05:40:00.000Z",
			followers: 101,
		});
	});
	it("落在段中间的某小时里:回不晚于目标的那个小时点(与展开一致)", () => {
		expect(at("2026-02-10T07:30:00.000Z")).toStrictEqual({
			sampledAt: "2026-02-10T06:59:59.999Z",
			followers: 101,
		});
		expect(at("2026-02-10T07:59:59.999Z")).toStrictEqual({
			sampledAt: "2026-02-10T07:59:59.999Z",
			followers: 101,
		});
	});
	it("落在段的最后一小时、lastSampledAt 之前:回上一个小时点;之后:回 lastSampledAt", () => {
		expect(at("2026-02-10T08:10:00.000Z")).toStrictEqual({
			sampledAt: "2026-02-10T07:59:59.999Z",
			followers: 101,
		});
		expect(at("2026-02-10T08:20:00.000Z")).toStrictEqual({
			sampledAt: "2026-02-10T08:20:00.000Z",
			followers: 101,
		});
		expect(at("2026-02-10T09:00:00.000Z")).toStrictEqual({
			sampledAt: "2026-02-10T08:20:00.000Z",
			followers: 101,
		});
	});
	it("晚于全部:回最后一行(点)", () => {
		expect(at("2027-01-01T00:00:00.000Z")).toStrictEqual({
			sampledAt: "2026-02-10T10:00:00.000Z",
			followers: 120,
		});
	});
	it("与展开逐点一致:对展开出的每个点时刻查得到它自己;对点前一毫秒查得到前一个点", () => {
		const pts = rows.flatMap((r) =>
			r.lastSampledAt === undefined
				? [r]
				: [
						p(r.sampledAt, r.followers),
						p("2026-02-10T06:59:59.999Z", r.followers),
						p("2026-02-10T07:59:59.999Z", r.followers),
						p(r.lastSampledAt, r.followers),
					],
		);
		pts.forEach((pt, i) => {
			expect(at(pt.sampledAt)?.sampledAt).toBe(pt.sampledAt);
			const prev = pts[i - 1];
			if (prev) {
				const before = new Date(Date.parse(pt.sampledAt) - 1).toISOString();
				expect(at(before)?.sampledAt).toBe(prev.sampledAt);
			}
		});
	});
});
