import {
	BILIBILI_GUARD_PROGRAM,
	type MembershipProgram,
	type MembershipTier,
	type Source,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { createMembershipTierReader } from "../membership-tiers.js";
import { createSourceRegistry, type SourceView } from "../registry.js";
import { makeIntegration, makeSource } from "./fixtures.js";

const tier = (key: string, rank: number): MembershipTier => ({ key, name: `档-${key}`, rank });

const viewOf = (...programs: MembershipProgram[]): SourceView => ({
	descriptor: { membershipPrograms: programs },
});

const readerOf = (...views: SourceView[]) => createMembershipTierReader({ list: () => views });

describe("createMembershipTierReader", () => {
	it("byKey:B 站大航海三档的 key 各找得到,认不出的回 undefined", () => {
		const reader = readerOf(viewOf(BILIBILI_GUARD_PROGRAM));
		for (const key of ["captain", "commander", "governor"]) {
			expect(reader.byKey(key)?.key).toBe(key);
		}
		expect(reader.byKey("nope")).toBeUndefined();
		expect(reader.byKey("")).toBeUndefined();
		expect(reader.byKey("constructor")).toBeUndefined();
	});

	it("lowest:第一套体系里 rank 最小的一档(B 站 = 舰长),与档在数组里的次序无关", () => {
		expect(readerOf(viewOf(BILIBILI_GUARD_PROGRAM)).lowest()?.key).toBe("captain");
		const shuffled: MembershipProgram = {
			id: "p",
			name: "p",
			tiers: [tier("hi", 3), tier("lo", 1), tier("mid", 2)],
		};
		expect(readerOf(viewOf(shuffled)).lowest()?.key).toBe("lo");
	});

	it("没有任何来源声明体系:byKey 与 lowest 都是 undefined", () => {
		const reader = readerOf({ descriptor: {} }, viewOf());
		expect(reader.byKey("captain")).toBeUndefined();
		expect(reader.lowest()).toBeUndefined();
		expect(readerOf().lowest()).toBeUndefined();
	});

	it('tiers 是 "custom" 的体系被跳过;空数组的体系也不算声明了档位', () => {
		const custom: MembershipProgram = { id: "c", name: "c", tiers: "custom" };
		const empty: MembershipProgram = { id: "e", name: "e", tiers: [] };
		const real: MembershipProgram = { id: "r", name: "r", tiers: [tier("only", 5)] };
		const reader = readerOf(viewOf(custom), viewOf(empty), viewOf(real));
		expect(reader.lowest()?.key).toBe("only");
		expect(reader.byKey("only")?.key).toBe("only");
		expect(readerOf(viewOf(custom), viewOf(empty)).lowest()).toBeUndefined();
	});

	it("跨来源 key 重名:按登记先后取第一个;lowest 只看第一套声明了档位的体系", () => {
		const first: MembershipProgram = { id: "a", name: "a", tiers: [tier("dup", 2), tier("x", 3)] };
		const second: MembershipProgram = { id: "b", name: "b", tiers: [tier("dup", 1)] };
		const reader = readerOf(viewOf(first), viewOf(second));
		expect(reader.byKey("dup")?.rank).toBe(2);
		expect(reader.lowest()?.rank).toBe(2);
	});

	it("每次现读登记表:来源后登记进来也读得到", async () => {
		const registry = createSourceRegistry();
		const reader = createMembershipTierReader(registry);
		expect(reader.lowest()).toBeUndefined();
		const source: Source = {
			...makeSource(),
			descriptor: { membershipPrograms: [BILIBILI_GUARD_PROGRAM] },
		};
		// biome-ignore lint/suspicious/noExplicitAny: 登记表测试只需要 logger
		await registry.register("any", source, makeIntegration() as any);
		expect(reader.lowest()?.key).toBe("captain");
	});
});
