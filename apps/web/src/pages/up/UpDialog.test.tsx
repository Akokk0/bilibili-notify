import { describe, expect, it } from "vitest";
import { FEATURE_KEYS, makeEmptySubscription } from "../../types/domain";
import { detachTargetFromDraft } from "./UpDialog";

describe("detachTargetFromDraft", () => {
	it("removes detached target from routing and per-target atAll overrides", () => {
		const targetId = "target-a";
		const keptTargetId = "target-b";
		const sub = makeEmptySubscription("100");
		for (const k of FEATURE_KEYS) sub.routing[k] = [targetId, keptTargetId];
		sub.atAll.dynamic[targetId] = true;
		sub.atAll.dynamic[keptTargetId] = false;
		sub.atAll.live[targetId] = false;
		sub.atAll.live[keptTargetId] = true;

		const next = detachTargetFromDraft(sub, targetId);

		for (const k of FEATURE_KEYS) {
			expect(next.routing[k]).not.toContain(targetId);
			expect(next.routing[k]).toContain(keptTargetId);
		}
		expect(next.atAll.dynamic).toEqual({ [keptTargetId]: false });
		expect(next.atAll.live).toEqual({ [keptTargetId]: true });
	});
});
