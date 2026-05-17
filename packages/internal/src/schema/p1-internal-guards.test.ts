/**
 * 回归守护 — P1:internal schema 层四条安全/数据完整性不变量。
 *
 * 1. imageRef 路径穿越:`../` / 分隔符必须被 schema 拒(读路由侧另有第二防线)
 * 2. routing 去重:同 feature 重复 UUID 解析后必须归一(否则重复推送+重复 delivery)
 * 3. blockRegex ReDoS/非法:保存期即拦(与 dynamic-filter 同一权威闸门)
 * 4. TimeRange 全天:`{start:0,end:24}` 必须可表达(此前 end.max(23) 与文案自相矛盾)
 *
 * 复发点:任一约束被放宽 / transform 被改回普通数组,本套立刻挂。
 */

import { describe, expect, it } from "vitest";
import { ContentFiltersSchema, TimeRangeSchema } from "./common";
import { HistoryPayloadSchema } from "./history";
import { SubscriptionRoutingSchema } from "./subscriptions";

const baseFilters = {
	blockForward: false,
	blockArticle: false,
	blockKeywords: [],
	blockRegex: [] as string[],
	whitelistKeywords: [],
	whitelistRegex: [] as string[],
	minScPrice: 0,
	minGuardLevel: 3 as const,
};

describe("HistoryPayload.imageRef — 路径穿越约束 (P1)", () => {
	it("拒绝含 ../ 与分隔符", () => {
		expect(
			HistoryPayloadSchema.safeParse({ kind: "image", imageRef: "../../etc/passwd" }).success,
		).toBe(false);
		expect(HistoryPayloadSchema.safeParse({ kind: "image", imageRef: "a/b.jpg" }).success).toBe(
			false,
		);
		expect(HistoryPayloadSchema.safeParse({ kind: "image", imageRef: "..%2f..%2fx" }).success).toBe(
			false,
		);
	});

	it("接受正常 uuid 文件名 / 省略", () => {
		expect(
			HistoryPayloadSchema.safeParse({
				kind: "image",
				imageRef: "550e8400-e29b-41d4-a716-446655440000.jpg",
			}).success,
		).toBe(true);
		expect(HistoryPayloadSchema.safeParse({ kind: "text", text: "x" }).success).toBe(true);
	});
});

describe("SubscriptionRouting — 重复 UUID 去重 (P1)", () => {
	it("同 feature 重复 target 解析后归一(幂等,不 reject)", () => {
		const dup = "550e8400-e29b-41d4-a716-446655440000";
		const parsed = SubscriptionRoutingSchema.parse({
			dynamic: [dup, dup, dup],
			live: [dup],
			liveEnd: [],
			liveGuardBuy: [],
			superchat: [],
			wordcloud: [],
			liveSummary: [],
			specialDanmaku: [],
			specialUserEnter: [],
		});
		expect(parsed.dynamic).toEqual([dup]);
		expect(parsed.live).toEqual([dup]);
	});
});

describe("ContentFilters.blockRegex — ReDoS/非法拦截 (P1 / ②2 同源)", () => {
	it("拒绝交替重叠 ReDoS 正则", () => {
		expect(
			ContentFiltersSchema.safeParse({ ...baseFilters, blockRegex: ["(a|a)*c"] }).success,
		).toBe(false);
	});
	it("拒绝非法正则", () => {
		expect(ContentFiltersSchema.safeParse({ ...baseFilters, blockRegex: ["(abc"] }).success).toBe(
			false,
		);
	});
	it("接受合法安全正则", () => {
		expect(
			ContentFiltersSchema.safeParse({ ...baseFilters, blockRegex: ["^spam-\\d+$"] }).success,
		).toBe(true);
	});
});

describe("TimeRange — 全天语义可表达 (P1)", () => {
	it("{start:0,end:24} 通过", () => {
		expect(TimeRangeSchema.safeParse({ start: 0, end: 24 }).success).toBe(true);
	});
	it("start===end 仍拒(无意义零长度)", () => {
		expect(TimeRangeSchema.safeParse({ start: 5, end: 5 }).success).toBe(false);
	});
	it("end 仍封顶 24", () => {
		expect(TimeRangeSchema.safeParse({ start: 0, end: 25 }).success).toBe(false);
	});
});
