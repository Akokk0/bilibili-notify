import { PushTargetSchema } from "@bilibili-notify/internal";
import { describe, expect, it } from "vitest";
import { type AdvancedSubRawConfigShape, buildAdvancedSubAndTargets } from "../convert";

function makeRaw(uid: string, channelId: string, platform = "onebot") {
	return {
		uid,
		roomId: "",
		dynamic: true,
		live: true,
		liveAtAll: false,
		liveEnd: false,
		liveGuardBuy: false,
		superchat: false,
		wordcloud: true,
		liveSummary: true,
		dynamicAtAll: false,
		target: [
			{
				platform,
				channelArr: [
					{
						channelId,
						dynamic: true,
						live: true,
						liveAtAll: false,
						liveEnd: false,
						liveGuardBuy: false,
						superchat: false,
						wordcloud: true,
						liveSummary: true,
						dynamicAtAll: false,
						specialDanmaku: false,
						specialUserEnter: false,
					},
				],
			},
		],
		customLiveSummary: { enable: false },
		customLiveMsg: { enable: false },
		customCardStyle: { enable: false },
		customGuardBuy: { enable: false },
		customSpecialDanmakuUsers: { enable: false },
		customSpecialUsersEnterTheRoom: { enable: false },
	};
}

describe("buildAdvancedSubAndTargets()", () => {
	it("emits a target for every channel referenced by routing (Fix 6)", () => {
		const cfg: AdvancedSubRawShim = {
			subs: {
				"UP-1": makeRaw("11", "111111"),
				"UP-2": makeRaw("22", "222222"),
			},
		};
		const { subs, targets } = buildAdvancedSubAndTargets(
			cfg as unknown as AdvancedSubRawConfigShape,
		);
		expect(subs).toHaveLength(2);
		expect(targets).toHaveLength(2);

		// Every targetId mentioned in any sub.routing must exist in the targets list.
		const targetIdSet = new Set(targets.map((t) => t.id));
		for (const sub of subs) {
			for (const ids of Object.values(sub.routing)) {
				for (const id of ids) expect(targetIdSet.has(id)).toBe(true);
			}
		}

		// All synthesized targets must pass the canonical PushTargetSchema.
		for (const t of targets) {
			const r = PushTargetSchema.safeParse(t);
			expect(r.success).toBe(true);
		}
	});

	it("dedups targets when multiple subs share the same (platform, channelId)", () => {
		const cfg: AdvancedSubRawShim = {
			subs: {
				"UP-1": makeRaw("11", "shared"),
				"UP-2": makeRaw("22", "shared"),
			},
		};
		const { subs, targets } = buildAdvancedSubAndTargets(
			cfg as unknown as AdvancedSubRawConfigShape,
		);
		expect(subs).toHaveLength(2);
		expect(targets).toHaveLength(1);
		// Both subs must reference the deduped target id.
		expect(subs[0].routing.live?.[0]).toBe(targets[0].id);
		expect(subs[1].routing.live?.[0]).toBe(targets[0].id);
	});
});

// shim to keep the test typing-light without importing the schemastery type
type AdvancedSubRawShim = {
	subs: Record<string, ReturnType<typeof makeRaw>>;
};
