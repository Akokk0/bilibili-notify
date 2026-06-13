import { describe, expect, it } from "vitest";
import type { SubscriptionOverrides, SubscriptionRouting } from "../api/types";
import {
	cleanOverrides,
	emptyRouting,
	linesToList,
	parseNumberInput,
	withRouteTarget,
} from "./config";

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
	it("drops an inherit-only AI section symmetrically with other empty sections", () => {
		const overrides: SubscriptionOverrides = {
			features: {},
			ai: { preset: "inherit" },
		};

		expect(cleanOverrides(overrides)).toEqual({});
	});

	it("drops the AI section when only empty substantive fields accompany inherit", () => {
		// removeEmpty strips the empty persona object / undefined prompt, leaving only preset:"inherit".
		const overrides = {
			ai: {
				preset: "inherit",
				persona: {},
				dynamicPrompt: undefined,
			},
		} as unknown as SubscriptionOverrides;

		expect(cleanOverrides(overrides)).toEqual({});
	});

	it("keeps an AI section with a substantive override value under inherit", () => {
		const overrides: SubscriptionOverrides = {
			ai: { preset: "inherit", temperature: 0.7 },
		};

		expect(cleanOverrides(overrides)).toEqual({
			ai: { preset: "inherit", temperature: 0.7 },
		});
	});

	it("keeps an AI section whose preset is custom even with no other fields", () => {
		const overrides: SubscriptionOverrides = {
			ai: { preset: "custom" },
		};

		expect(cleanOverrides(overrides)).toEqual({
			ai: { preset: "custom" },
		});
	});

	it("keeps an AI section pointing at a preset id even with no other fields", () => {
		const overrides: SubscriptionOverrides = {
			ai: { preset: "tsundere" },
		};

		expect(cleanOverrides(overrides)).toEqual({
			ai: { preset: "tsundere" },
		});
	});

	it("keeps an AI section with persona override fields", () => {
		const persona = {
			name: "小红",
			addressUser: "你",
			addressSelf: "我",
			traits: "活泼",
			catchphrase: "嗨",
			baseRole: "助手",
			extraSystemPrompt: "",
		};
		const overrides: SubscriptionOverrides = {
			ai: { preset: "inherit", persona },
		};

		expect(cleanOverrides(overrides)).toEqual({
			ai: { preset: "inherit", persona },
		});
	});

	it("does not regress non-AI sections (empty dropped, populated kept)", () => {
		const overrides: SubscriptionOverrides = {
			features: {},
			filters: { blockKeywords: ["spam"] },
			schedule: {},
			templates: { dynamic: "hi" },
		};

		expect(cleanOverrides(overrides)).toEqual({
			filters: { blockKeywords: ["spam"] },
			templates: { dynamic: "hi" },
		});
	});
});

describe("parseNumberInput", () => {
	it("returns the fallback for an empty string instead of 0", () => {
		expect(parseNumberInput("", 5)).toBe(5);
	});

	it("returns the fallback for whitespace-only input", () => {
		expect(parseNumberInput("   ", 12)).toBe(12);
	});

	it("returns the parsed value for a valid number", () => {
		expect(parseNumberInput("42", 5)).toBe(42);
	});

	it("parses decimals (e.g. temperature)", () => {
		expect(parseNumberInput("0.7", 1)).toBe(0.7);
	});

	it("returns the fallback for non-numeric input", () => {
		expect(parseNumberInput("abc", 3)).toBe(3);
	});

	it("preserves a valid zero", () => {
		expect(parseNumberInput("0", 5)).toBe(0);
	});
});

describe("linesToList", () => {
	it("accepts comma and newline separated input", () => {
		expect(linesToList("foo, bar\nbaz\n")).toEqual(["foo", "bar", "baz"]);
	});
});
