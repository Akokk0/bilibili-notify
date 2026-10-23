import {
	BILIBILI_GUARD_PROGRAM,
	type MembershipProgram,
	type MembershipTier,
	type Source,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { noCandidates, noProfile } from "../../__tests__/support/no-candidates.js";
import { createMembershipTierReader } from "../membership-tiers.js";
import { createSourceRegistry, type SourceView } from "../registry.js";
import { makeIntegration, makeSource } from "./fixtures.js";

const tier = (key: string, rank: number): MembershipTier => ({ key, name: `档-${key}`, rank });

const viewOf = (...programs: MembershipProgram[]): SourceView => viewOfKey("test", ...programs);

const viewOfKey = (sourceKey: string, ...programs: MembershipProgram[]): SourceView => ({
	sourceKey,
	descriptor: { label: "测试", membershipPrograms: programs },
	searchCreators: noCandidates,
	fetchProfile: noProfile,
});

const readerOf = (...views: SourceView[]) => createMembershipTierReader({ list: () => views });

describe("createMembershipTierReader", () => {
	it("byKey:B 站大航海三档的 key 各找得到,认不出的回 undefined", () => {
		const reader = readerOf(viewOf(BILIBILI_GUARD_PROGRAM));
		for (const key of ["captain", "commander", "governor"]) {
			expect(reader.byKey("guard", key)?.key).toBe(key);
		}
		expect(reader.byKey("guard", "nope")).toBeUndefined();
		expect(reader.byKey("guard", "")).toBeUndefined();
		expect(reader.byKey("guard", "constructor")).toBeUndefined();
		expect(reader.byKey("nobody", "captain")).toBeUndefined();
	});

	it("lowest:带了体系 id 就看那一套里 rank 最小的一档(B 站 = 舰长),与档在数组里的次序无关", () => {
		expect(readerOf(viewOf(BILIBILI_GUARD_PROGRAM)).lowest()?.key).toBe("captain");
		expect(readerOf(viewOf(BILIBILI_GUARD_PROGRAM)).lowest("guard")?.key).toBe("captain");
		const shuffled: MembershipProgram = {
			id: "p",
			name: "p",
			tiers: [tier("hi", 3), tier("lo", 1), tier("mid", 2)],
		};
		expect(readerOf(viewOf(shuffled)).lowest()?.key).toBe("lo");
		expect(readerOf(viewOf(shuffled)).lowest("p")?.key).toBe("lo");
		expect(readerOf(viewOf(shuffled)).lowest("nobody")).toBeUndefined();
	});

	it("没有任何来源声明体系:byKey 与 lowest 都是 undefined", () => {
		const reader = readerOf(
			{
				sourceKey: "test.bare",
				descriptor: { label: "测试" },
				searchCreators: noCandidates,
				fetchProfile: noProfile,
			},
			viewOf(),
		);
		expect(reader.byKey("guard", "captain")).toBeUndefined();
		expect(reader.lowest()).toBeUndefined();
		expect(readerOf().lowest()).toBeUndefined();
	});

	it('tiers 是 "custom" 的体系被跳过;空数组的体系也不算声明了档位', () => {
		const custom: MembershipProgram = { id: "c", name: "c", tiers: "custom" };
		const empty: MembershipProgram = { id: "e", name: "e", tiers: [] };
		const real: MembershipProgram = { id: "r", name: "r", tiers: [tier("only", 5)] };
		const reader = readerOf(viewOf(custom), viewOf(empty), viewOf(real));
		expect(reader.lowest()?.key).toBe("only");
		expect(reader.byKey("r", "only")?.key).toBe("only");
		expect(reader.byKey("c", "anything")).toBeUndefined();
		expect(readerOf(viewOf(custom), viewOf(empty)).lowest()).toBeUndefined();
	});

	it("两个来源都声明了 gold:各认各的档,不按登记先后抢第一个", () => {
		const first: MembershipProgram = { id: "a", name: "a", tiers: [tier("dup", 2), tier("x", 3)] };
		const second: MembershipProgram = { id: "b", name: "b", tiers: [tier("dup", 1)] };
		const reader = readerOf(viewOfKey("one", first), viewOfKey("two", second));
		expect(reader.byKey("a", "dup")?.rank).toBe(2);
		expect(reader.byKey("b", "dup")?.rank).toBe(1);
		expect(reader.byKey(undefined, "dup")?.rank).toBe(2);
		expect(reader.lowest()?.rank).toBe(2);
		expect(reader.lowest("b")?.rank).toBe(1);
	});

	it("体系 id 跟已在册的撞了:第二个来源拒收,没 start、没留在登记表里", async () => {
		const registry = createSourceRegistry();
		const first: MembershipProgram = { id: "gold", name: "金", tiers: [tier("a", 1)] };
		const second: MembershipProgram = { id: "gold", name: "金", tiers: [tier("b", 2)] };
		await registry.register(
			"first",
			{
				...makeSource(),
				descriptor: { label: "第一个", membershipPrograms: [first] },
			},
			// biome-ignore lint/suspicious/noExplicitAny: 登记表测试只需要 logger
			makeIntegration() as any,
		);
		const rejected = {
			...makeSource(),
			descriptor: { label: "第二个", membershipPrograms: [second] },
		};
		await expect(
			registry.register(
				"second",
				rejected,
				// biome-ignore lint/suspicious/noExplicitAny: 登记表测试只需要 logger
				makeIntegration() as any,
			),
		).rejects.toThrow(/membership program/);
		expect(rejected.start).not.toHaveBeenCalled();
		expect(registry.get("second")).toBeUndefined();
		expect(createMembershipTierReader(registry).byKey("gold", "a")?.rank).toBe(1);
	});

	it("每次现读登记表:来源后登记进来也读得到", async () => {
		const registry = createSourceRegistry();
		const reader = createMembershipTierReader(registry);
		expect(reader.lowest()).toBeUndefined();
		const source: Source = {
			...makeSource(),
			descriptor: { label: "测试", membershipPrograms: [BILIBILI_GUARD_PROGRAM] },
		};
		// biome-ignore lint/suspicious/noExplicitAny: 登记表测试只需要 logger
		await registry.register("any", source, makeIntegration() as any);
		expect(reader.lowest()?.key).toBe("captain");
	});
});
