/**
 * 集成段逐格解析:一格坏了只那一格退默认,别的格照盘上的值。
 * 只经 `parseIntegrationCells` / `withRawSettings` 的入参与返回值断言,不 mock schema。
 */

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { withRawSettings } from "../core-settings.js";
import { parseIntegrationCells } from "../integration-settings.js";

const Schema = z.object({
	dynamicCron: z.string().default("*/10 * * * *"),
	healthCheckMinutes: z.number().int().min(5).max(180).default(30),
	nickname: z.string().optional(),
});

describe("parseIntegrationCells", () => {
	it("全好的一份:没有坏格,settings 等于它过 schema 的结果", () => {
		const raw = { dynamicCron: "*/5 * * * *", healthCheckMinutes: 45, nickname: "小助手" };
		const { settings, invalid } = parseIntegrationCells(Schema, raw);
		expect(invalid).toEqual([]);
		expect(settings).toEqual(Schema.parse(raw));
	});

	it("一格类型错:那一格取默认,别的格是入参里的值,记一条带原文", () => {
		const raw = { dynamicCron: 5, healthCheckMinutes: 45 };
		const { settings, invalid } = parseIntegrationCells(Schema, raw);
		expect(settings).toEqual({ dynamicCron: "*/10 * * * *", healthCheckMinutes: 45 });
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["dynamicCron"]);
		expect(invalid[0]?.raw).toBe(5);
		expect(invalid[0]?.missing).toBe(false);
		expect(invalid[0]?.issues.length).toBeGreaterThan(0);
	});

	it("一格越界:那一格取默认,别的格不动", () => {
		const raw = { dynamicCron: "*/5 * * * *", healthCheckMinutes: 1 };
		const { settings, invalid } = parseIntegrationCells(Schema, raw);
		expect(settings).toEqual({ dynamicCron: "*/5 * * * *", healthCheckMinutes: 30 });
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["healthCheckMinutes"]);
		expect(invalid[0]?.raw).toBe(1);
	});

	it("两格都坏:两条,各取各的默认", () => {
		const { settings, invalid } = parseIntegrationCells(Schema, {
			dynamicCron: false,
			healthCheckMinutes: "半小时",
		});
		expect(settings).toEqual({ dynamicCron: "*/10 * * * *", healthCheckMinutes: 30 });
		expect(invalid.map((e) => e.path)).toEqual([["dynamicCron"], ["healthCheckMinutes"]]);
	});

	it("可选格坏了:没有默认值,那一格在结果里不带键", () => {
		const { settings, invalid } = parseIntegrationCells(Schema, { nickname: 7 });
		expect(settings).toEqual({ dynamicCron: "*/10 * * * *", healthCheckMinutes: 30 });
		expect(Object.hasOwn(settings as object, "nickname")).toBe(false);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.path).toEqual(["nickname"]);
		expect(invalid[0]?.raw).toBe(7);
	});

	it("格缺了(带默认的):不算坏、按 schema 默认补", () => {
		const { settings, invalid } = parseIntegrationCells(Schema, { healthCheckMinutes: 45 });
		expect(invalid).toEqual([]);
		expect(settings).toEqual({ dynamicCron: "*/10 * * * *", healthCheckMinutes: 45 });
	});

	it("多了不认识的键:被剥掉,不算坏", () => {
		const { settings, invalid } = parseIntegrationCells(Schema, {
			dynamicCron: "*/5 * * * *",
			userAgent: "旧版留下的",
		});
		expect(invalid).toEqual([]);
		expect(settings).toEqual({ dynamicCron: "*/5 * * * *", healthCheckMinutes: 30 });
	});

	it("空对象:全是默认,没有坏格", () => {
		const { settings, invalid } = parseIntegrationCells(Schema, {});
		expect(invalid).toEqual([]);
		expect(settings).toEqual(Schema.parse({}));
	});

	it("入参不被改写,返回值也不与入参共享引用", () => {
		const Nested = z.object({ tags: z.array(z.string()).default([]), n: z.number().default(1) });
		const raw = { tags: ["a", "b"], n: "坏" };
		const frozen = structuredClone(raw);
		const { settings, invalid } = parseIntegrationCells(Nested, raw);
		expect(raw).toEqual(frozen);
		(settings as { tags: string[] }).tags.push("c");
		expect(raw.tags).toEqual(["a", "b"]);
		expect(invalid[0]?.raw).toBe("坏");
	});

	it("坏格的原文是副本:改它不影响入参里的对象", () => {
		const Obj = z.object({ box: z.object({ a: z.number() }).default({ a: 1 }) });
		const raw = { box: { a: "坏" } };
		const { invalid } = parseIntegrationCells(Obj, raw);
		(invalid[0]?.raw as { a: unknown }).a = "改了";
		expect(raw.box.a).toBe("坏");
	});

	it("来回稳定:坏格原文放回去之后再解析,结果与条目都一样", () => {
		const raw = { dynamicCron: 5, healthCheckMinutes: 45, nickname: "小助手" };
		const first = parseIntegrationCells(Schema, raw);
		const onDisk = withRawSettings(first.settings, first.invalid);
		expect(onDisk).toEqual(raw);
		const second = parseIntegrationCells(Schema, onDisk as Record<string, unknown>);
		expect(second).toEqual(first);
	});
});
