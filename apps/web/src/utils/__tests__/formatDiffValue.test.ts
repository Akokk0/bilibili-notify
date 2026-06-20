import { describe, expect, it } from "vite-plus/test";
import { formatDiffValue } from "../formatDiffValue";

describe("formatDiffValue", () => {
	it("undefined / null → (未设置)", () => {
		expect(formatDiffValue("blockKeywords", undefined)).toEqual({ display: "(未设置)" });
		expect(formatDiffValue("blockKeywords", null)).toEqual({ display: "(未设置)" });
	});

	it("boolean → 开启 / 关闭", () => {
		expect(formatDiffValue("hideDesc", true)).toEqual({ display: "开启" });
		expect(formatDiffValue("hideDesc", false)).toEqual({ display: "关闭" });
	});

	it("number → 字符串", () => {
		expect(formatDiffValue("minScPrice", 30)).toEqual({ display: "30" });
		expect(formatDiffValue("ai.temperature", 0.7)).toEqual({ display: "0.7" });
	});

	it("number NaN → NaN 文本", () => {
		expect(formatDiffValue("minScPrice", Number.NaN)).toEqual({ display: "NaN" });
	});

	it("string → 原文", () => {
		expect(formatDiffValue("ai.model", "gpt-4o")).toEqual({ display: "gpt-4o" });
	});

	it("空字符串 → 显示双引号(避免 UI 上看不到)", () => {
		expect(formatDiffValue("app.userAgent", "")).toEqual({ display: '""' });
	});

	it("color 字段 + 合法 hex → 带 swatch", () => {
		expect(formatDiffValue("cardColorStart", "#a29bfe")).toEqual({
			display: "#a29bfe",
			swatch: "#a29bfe",
		});
		expect(formatDiffValue("cardColorEnd", "#abc")).toEqual({
			display: "#abc",
			swatch: "#abc",
		});
	});

	it("color 字段 + 非 hex → 无 swatch", () => {
		expect(formatDiffValue("cardColorStart", "linear-gradient(...)")).toEqual({
			display: "linear-gradient(...)",
		});
	});

	it("非 color 字段 + hex 文本 → 无 swatch", () => {
		expect(formatDiffValue("ai.model", "#a29bfe")).toEqual({ display: "#a29bfe" });
	});

	it("secret 字段 → 全脱敏(••• 已改),不暴露原值", () => {
		expect(formatDiffValue("ai.apiKey", "sk-xxx-yyy")).toEqual({ display: "••• 已改" });
		expect(formatDiffValue("ai.apiKey", "")).toEqual({ display: "••• 已改" });
		expect(formatDiffValue("ai.apiKey", undefined)).toEqual({ display: "••• 已改" });
		expect(formatDiffValue("config.secret", "shared-secret-token")).toEqual({
			display: "••• 已改",
		});
		expect(formatDiffValue("config.accessToken", "tk")).toEqual({ display: "••• 已改" });
	});

	it("空数组 → []", () => {
		expect(formatDiffValue("blockKeywords", [])).toEqual({ display: "[]" });
	});

	it("非空数组 → 紧凑 JSON 全展开", () => {
		expect(formatDiffValue("blockKeywords", ["spam", "广告"])).toEqual({
			display: '["spam","广告"]',
		});
	});

	it("plain object → 紧凑 JSON", () => {
		expect(formatDiffValue("schedule.quietHours", { start: 0, end: 7 })).toEqual({
			display: '{"start":0,"end":7}',
		});
	});

	it("未知 code → 跟随类型规则(secret 不命中)", () => {
		expect(formatDiffValue("__unknown__", true)).toEqual({ display: "开启" });
		expect(formatDiffValue("__unknown__", "x")).toEqual({ display: "x" });
	});
});
