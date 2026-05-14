import { PushTargetSchema } from "@bilibili-notify/internal";
import { describe, expect, it } from "vitest";
import { type AdvancedSubRawConfigShape, buildAdvancedSubAndTargets } from "../convert";

function makeRaw(
	uid: string,
	channelId: string,
	platform = "onebot",
	opts: {
		/** UP 级 @全体 默认。undefined → 走 koishi schema default(dynamic:false, live:true)。 */
		upDynamicAtAll?: boolean;
		upLiveAtAll?: boolean;
		/** per-channel @全体 显式覆写。undefined → inherit。 */
		chDynamicAtAll?: boolean;
		chLiveAtAll?: boolean;
	} = {},
) {
	return {
		uid,
		roomId: "",
		dynamic: true,
		// koishi schema 给的 default(模拟 schema parse 后的 raw config)。
		dynamicAtAll: opts.upDynamicAtAll ?? false,
		live: true,
		liveAtAll: opts.upLiveAtAll ?? true,
		liveEnd: false,
		liveGuardBuy: false,
		superchat: false,
		wordcloud: true,
		liveSummary: true,
		target: [
			{
				platform,
				channelArr: [
					{
						channelId,
						dynamic: true,
						live: true,
						liveEnd: false,
						liveGuardBuy: false,
						superchat: false,
						wordcloud: true,
						liveSummary: true,
						specialDanmaku: false,
						specialUserEnter: false,
						// optional — undefined 表示 inherit
						...(opts.chDynamicAtAll !== undefined ? { dynamicAtAll: opts.chDynamicAtAll } : {}),
						...(opts.chLiveAtAll !== undefined ? { liveAtAll: opts.chLiveAtAll } : {}),
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

	it("maps UP-level dynamicAtAll/liveAtAll to Subscription.atAllDefaults", () => {
		const cfg: AdvancedSubRawShim = {
			subs: {
				"UP-1": makeRaw("11", "111", "onebot", { upDynamicAtAll: true, upLiveAtAll: false }),
				"UP-2": makeRaw("22", "222", "onebot"), // 用 schema 默认 false / true
			},
		};
		const { subs } = buildAdvancedSubAndTargets(cfg as unknown as AdvancedSubRawConfigShape);
		expect(subs[0].atAllDefaults).toEqual({ dynamic: true, live: false });
		expect(subs[1].atAllDefaults).toEqual({ dynamic: false, live: true });
	});

	it("maps per-channel @全体 toggles to Subscription.atAll Map (optional → inherit)", () => {
		const cfg: AdvancedSubRawShim = {
			subs: {
				// UP-1:per-channel 显式 ON + OFF
				"UP-1": makeRaw("11", "111", "onebot", { chDynamicAtAll: true, chLiveAtAll: false }),
				// UP-2:per-channel 完全没填 → Map 空,走 atAllDefaults
				"UP-2": makeRaw("22", "222"),
			},
		};
		const { subs } = buildAdvancedSubAndTargets(cfg as unknown as AdvancedSubRawConfigShape);
		// UP-1:Map 有 entry,显式覆写
		const up1TargetId = subs[0].routing.dynamic[0];
		expect(subs[0].atAll.dynamic[up1TargetId]).toBe(true);
		expect(subs[0].atAll.live[up1TargetId]).toBe(false);
		// UP-2:Map 空,inherit
		expect(subs[1].atAll.dynamic).toEqual({});
		expect(subs[1].atAll.live).toEqual({});
		// Map keys 都是 routing 子集
		for (const key of Object.keys(subs[0].atAll.dynamic)) {
			expect(subs[0].routing.dynamic).toContain(key);
		}
		for (const key of Object.keys(subs[0].atAll.live)) {
			expect(subs[0].routing.live).toContain(key);
		}
	});
});

// shim to keep the test typing-light without importing the schemastery type
type AdvancedSubRawShim = {
	subs: Record<string, ReturnType<typeof makeRaw>>;
};
