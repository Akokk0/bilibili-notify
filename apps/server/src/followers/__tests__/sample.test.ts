/** 粉丝样本的「解析一行」:新形状与 0.x 旧形状 `{ ts, value }` 都认,别的一概不认。 */
import { describe, expect, it } from "vite-plus/test";
import { parseFollowersSample } from "../sample.js";

describe("parseFollowersSample", () => {
	it("认新形状的点", () => {
		expect(parseFollowersSample({ sampledAt: "2026-02-10T05:40:00.000Z", followers: 101 })).toEqual(
			{
				sampledAt: "2026-02-10T05:40:00.000Z",
				followers: 101,
			},
		);
	});

	it("认新形状的段", () => {
		expect(
			parseFollowersSample({
				sampledAt: "2026-02-10T05:40:00.000Z",
				followers: 101,
				lastSampledAt: "2026-02-10T08:20:00.000Z",
			}),
		).toEqual({
			sampledAt: "2026-02-10T05:40:00.000Z",
			followers: 101,
			lastSampledAt: "2026-02-10T08:20:00.000Z",
		});
	});

	it("认旧形状 { ts, value }", () => {
		expect(parseFollowersSample({ ts: "2026-02-10T05:40:00.000Z", value: 7 })).toEqual({
			sampledAt: "2026-02-10T05:40:00.000Z",
			followers: 7,
		});
	});

	it("新旧字段同时在时以新形状为准,并且只吐认得的格(多带的键不漏出去)", () => {
		const out = parseFollowersSample({
			sampledAt: "2026-02-10T05:40:00.000Z",
			followers: 1,
			ts: "2020-01-01T00:00:00.000Z",
			value: 9,
			extra: true,
		});
		expect(out).toStrictEqual({ sampledAt: "2026-02-10T05:40:00.000Z", followers: 1 });
	});

	it("followers 为 0 是好值", () => {
		expect(parseFollowersSample({ sampledAt: "2026-02-10T05:40:00.000Z", followers: 0 })).toEqual({
			sampledAt: "2026-02-10T05:40:00.000Z",
			followers: 0,
		});
	});

	it.each([
		["null", null],
		["字符串", "x"],
		["空对象", {}],
		["时刻解析不了", { sampledAt: "not a date", followers: 1 }],
		["时刻不是字符串", { sampledAt: 123, followers: 1 }],
		["followers 不是数", { sampledAt: "2026-02-10T05:40:00.000Z", followers: "1" }],
		["followers 是 NaN", { sampledAt: "2026-02-10T05:40:00.000Z", followers: Number.NaN }],
		[
			"followers 是 Infinity",
			{ sampledAt: "2026-02-10T05:40:00.000Z", followers: Number.POSITIVE_INFINITY },
		],
		["旧形状 value 坏", { ts: "2026-02-10T05:40:00.000Z", value: "x" }],
		["旧形状 ts 坏", { ts: "zzz", value: 1 }],
		[
			"lastSampledAt 解析不了",
			{ sampledAt: "2026-02-10T05:40:00.000Z", followers: 1, lastSampledAt: "zzz" },
		],
		[
			"lastSampledAt 早于 sampledAt",
			{
				sampledAt: "2026-02-10T05:40:00.000Z",
				followers: 1,
				lastSampledAt: "2026-02-10T05:00:00.000Z",
			},
		],
	])("不认:%s", (_name, raw) => {
		expect(parseFollowersSample(raw)).toBeUndefined();
	});
});
