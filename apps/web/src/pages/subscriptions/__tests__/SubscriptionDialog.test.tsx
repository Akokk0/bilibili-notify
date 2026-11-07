import { describe, expect, it } from "vite-plus/test";
import { FEATURE_KEYS, makeEmptySubscription } from "../../../types/domain";
import { detachTargetFromDraft } from "../SubscriptionDialog";

describe("detachTargetFromDraft", () => {
	it("removes detached target from routing and per-target extraTargets overrides", () => {
		const targetId = "target-a";
		const keptTargetId = "target-b";
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		for (const k of FEATURE_KEYS) sub.routing[k] = [targetId, keptTargetId];
		sub.extraTargets.atAllPost[targetId] = true;
		sub.extraTargets.atAllPost[keptTargetId] = false;
		sub.extraTargets.atAllLiveStart[targetId] = false;
		sub.extraTargets.atAllLiveStart[keptTargetId] = true;

		const next = detachTargetFromDraft(sub, targetId);

		for (const k of FEATURE_KEYS) {
			expect(next.routing[k]).not.toContain(targetId);
			expect(next.routing[k]).toContain(keptTargetId);
		}
		expect(next.extraTargets.atAllPost).toEqual({ [keptTargetId]: false });
		expect(next.extraTargets.atAllLiveStart).toEqual({ [keptTargetId]: true });
	});
});
