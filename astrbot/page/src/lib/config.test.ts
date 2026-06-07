import { describe, expect, it } from "vitest";
import type { SubscriptionOverrides, SubscriptionRouting } from "../api/types";
import { emptyRouting, cleanOverrides, linesToList, withRouteTarget } from "./config";

describe("routing helpers", () => {
	it("adds and removes a target id without mutating the original routing", () => {
		const routing: SubscriptionRouting = emptyRouting();
		const enabled = withRouteTarget(routing, "dynamic", "target-1", true);
		const disabled = withRouteTarget(enabled, "dynamic", "target-1", false);

		expect(routing.dynamic).toEqual([]);
		expect(enabled.dynamic).toEqual(["target-1"]);
		expect(disabled.dynamic).toEqual([]);
	});
});

describe("cleanOverrides", () => {
	it("removes empty override sections but keeps explicit inherited AI preset", () => {
		const overrides: SubscriptionOverrides = {
			features: {},
			filters: { blockKeywords: [] },
			ai: { preset: "inherit" },
		};

		expect(cleanOverrides(overrides)).toEqual({
			filters: { blockKeywords: [] },
			ai: { preset: "inherit" },
		});
	});
});

describe("linesToList", () => {
	it("accepts comma and newline separated input", () => {
		expect(linesToList("foo, bar\nbaz\n")).toEqual(["foo", "bar", "baz"]);
	});
});
