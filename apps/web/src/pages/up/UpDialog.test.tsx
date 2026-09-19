import { describe, expect, it } from "vite-plus/test";
import { FEATURE_KEYS, makeEmptySubscription } from "../../types/domain";
import { detachTargetFromDraft } from "./UpDialog";

describe("detachTargetFromDraft", () => {
	it("removes detached target from routing and per-target extras overrides", () => {
		const targetId = "target-a";
		const keptTargetId = "target-b";
		const sub = makeEmptySubscription("100");
		for (const k of FEATURE_KEYS) sub.routing[k] = [targetId, keptTargetId];
		sub.extras.atAllDynamic[targetId] = true;
		sub.extras.atAllDynamic[keptTargetId] = false;
		sub.extras.atAllLive[targetId] = false;
		sub.extras.atAllLive[keptTargetId] = true;

		const next = detachTargetFromDraft(sub, targetId);

		for (const k of FEATURE_KEYS) {
			expect(next.routing[k]).not.toContain(targetId);
			expect(next.routing[k]).toContain(keptTargetId);
		}
		expect(next.extras.atAllDynamic).toEqual({ [keptTargetId]: false });
		expect(next.extras.atAllLive).toEqual({ [keptTargetId]: true });
	});
});
