/**
 * 回归守护 — P1:internal schema 层四条安全/数据完整性不变量。
 *
 * 1. 历史配图只收图库引用:`../` / 分隔符必须被 schema 拒(读口侧另有第二防线)
 * 2. routing 去重:同 feature 重复 UUID 解析后必须归一(否则重复推送+重复 delivery)
 * 3. blockRegex ReDoS/非法:保存期即拦(与 post-filter 同一权威闸门)
 * 4. TimeRange 全天:`{start:0,end:24}` 必须可表达(此前 end.max(23) 与文案自相矛盾)
 *
 * 复发点:任一约束被放宽 / transform 被改回普通数组,本套立刻挂。
 */

import { describe, expect, it } from "vite-plus/test";
import { ContentFiltersSchema, TimeRangeSchema } from "../common";
import { HistoryPayloadSchema } from "../history";
import { SubscriptionRoutingSchema } from "../subscriptions";

const baseFilters = {
	blockReposts: false,
	blockArticles: false,
	blockImages: false,
	blockVideos: false,
	blockKeywords: [],
	blockRegex: [] as string[],
	allowKeywords: [],
	allowRegex: [] as string[],
	minScPrice: 0,
	minGuardLevel: 3 as const,
};

const SHA = "a".repeat(64);

describe("HistoryPayload.image — 只收图库引用,路径穿越进不来 (P1)", () => {
	it("拒绝含 ../ 与分隔符、旧的 <行 id>-<序号>.<ext> 文件名、不认的扩展名", () => {
		for (const image of [
			"../../etc/passwd",
			"a/b.jpg",
			"..%2f..%2fx",
			"550e8400-e29b-41d4-a716-446655440000.jpg",
			`${SHA}.svg`,
			`${SHA}.jpeg`,
			`../${SHA}.png`,
			`${SHA.toUpperCase()}.png`,
		]) {
			expect(HistoryPayloadSchema.safeParse({ kind: "image", image }).success, image).toBe(false);
		}
	});

	it("接受图库引用(四种扩展名)/ 省略", () => {
		for (const ext of ["png", "jpg", "gif", "webp"]) {
			expect(
				HistoryPayloadSchema.safeParse({ kind: "image", image: `${SHA}.${ext}` }).success,
				ext,
			).toBe(true);
		}
		expect(HistoryPayloadSchema.safeParse({ kind: "text", text: "x" }).success).toBe(true);
	});
});

describe("SubscriptionRouting — 重复 UUID 去重 (P1)", () => {
	it("同 feature 重复 target 解析后归一(幂等,不 reject)", () => {
		const dup = "550e8400-e29b-41d4-a716-446655440000";
		const parsed = SubscriptionRoutingSchema.parse({
			post: [dup, dup, dup],
			liveStart: [dup],
			liveStreaming: [],
			liveEnd: [],
			membership: [],
			superchat: [],
			specialDanmaku: [],
			specialUserEnter: [],
		});
		expect(parsed.post).toEqual([dup]);
		expect(parsed.liveStart).toEqual([dup]);
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
