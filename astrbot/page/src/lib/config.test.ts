import { describe, expect, it } from "vite-plus/test";
import type { GlobalConfig, SubscriptionOverrides, SubscriptionRouting } from "../api/types";
import {
	buildGlobalsPatch,
	cleanOverrides,
	emptyRouting,
	linesToList,
	parseNumberInput,
	subscriptionMetaPatch,
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

describe("buildGlobalsPatch", () => {
	// 配置 PATCH 是 JSON Merge Patch:键不出现 = 「不改」,只有显式 null 才是删除。
	// 从前这里把草稿整份回传,被清空的可选字段在草稿里是 undefined,JSON.stringify
	// 连键一起丢掉 —— 于是「清空」等于什么都没说,旧值刷新回来还在。
	const globals = (over: Record<string, unknown> = {}): GlobalConfig =>
		({
			app: { dynamicCron: "*/2 * * * *", userAgent: "old-ua" },
			master: { targetId: "t-1" },
			defaults: {},
			...over,
		}) as unknown as GlobalConfig;

	it("清空 userAgent → 显式 null", () => {
		const draft = globals({ app: { dynamicCron: "*/2 * * * *", userAgent: undefined } });
		const patch = buildGlobalsPatch(draft, globals());
		expect(patch.app).toHaveProperty("userAgent");
		expect(patch.app?.userAgent).toBeNull();
	});

	it("清空 master.targetId → 显式 null", () => {
		const draft = globals({ master: { targetId: undefined } });
		const patch = buildGlobalsPatch(draft, globals());
		expect(patch.master).toHaveProperty("targetId");
		expect(patch.master?.targetId).toBeNull();
	});

	it("没动过的字段原样下发,不会误发 null", () => {
		const patch = buildGlobalsPatch(globals(), globals());
		expect(patch.app?.userAgent).toBe("old-ua");
		expect(patch.master?.targetId).toBe("t-1");
	});
});

describe("subscriptionMetaPatch", () => {
	it("清空名称 / 备注 → 显式 null,不是 undefined", () => {
		const patch = subscriptionMetaPatch("  ", "a, b", "");
		expect(patch.name).toBeNull();
		expect(patch.notes).toBeNull();
		expect(patch.groups).toEqual(["a", "b"]);
	});

	it("有内容时原样下发(去空白)", () => {
		expect(subscriptionMetaPatch("  老番茄 ", "", " 备注 ")).toEqual({
			name: "老番茄",
			groups: [],
			notes: "备注",
		});
	});
});
