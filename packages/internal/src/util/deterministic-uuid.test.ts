/**
 * 回归守护 — P0-2 fix(koishi/targets): use deterministicUuid for synthesized adapter+target ids
 *
 * deterministicUuid 是 reload 跨次稳定 id 的种子函数。线上 koishi/core target-synthesis、
 * advanced-subscription/convert 都依赖它把 (platform, channelId, ...) 映射到稳定 UUID。
 * 任何人"优化"算法,所有已经持久化的 history 引用就静默漂移成孤儿。
 *
 * 本测试锁住:
 *   - 给定输入 → 给定输出(算法快照,一次性 hardcode 固化)
 *   - v4 形:第 3 段首字符为 "4",第 4 段首字符 ∈ {8,9,a,b}(RFC 4122 variant)
 */

import { describe, expect, it } from "vitest";
import { deterministicUuid } from "./deterministic-uuid";

describe("deterministicUuid — algorithm snapshot", () => {
	it("固定输入 → 固定输出(改算法必须改 expected,且需要数据迁移评估)", () => {
		// 这些 expected 值在 P0-2 落地那一刻一次性 capture,绝对不能"为了让测试过"
		// 而修改;只有在明确知道要做数据迁移时才允许调整。
		expect(deterministicUuid("foo")).toBe("0b8737a3-9081-4d0f-b809-94a5a7225069");
		expect(deterministicUuid("")).toBe("00001505-cde7-4bee-9caf-0000d8e27411");
		expect(deterministicUuid("adapter:koishi-bot:qq")).toBe("3e7bb479-da63-4ca8-a6aa-c9056e1aa02d");
	});

	it("输出形如 UUID v4(version + variant)", () => {
		for (const seed of ["x", "y", "long-seed-with-special:chars/and-numbers-42"]) {
			const out = deterministicUuid(seed);
			expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		}
	});

	it("相同种子两次调用稳定", () => {
		expect(deterministicUuid("seed-1")).toBe(deterministicUuid("seed-1"));
	});
});
