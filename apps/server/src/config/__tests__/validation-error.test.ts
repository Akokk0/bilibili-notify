/**
 * ConfigValidationError:配置写入被拒的原因自带标准码与中文话(ADR-0026),路由按码回、不嗅文案。
 */

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ConfigValidationError } from "../validation-error.js";

const Schema = z.object({
	name: z.string({ error: "名字要是字符串" }),
	fans: z.number({ error: "粉丝数要是数字" }),
	nested: z.object({ tags: z.array(z.string()) }, { error: "嵌套要是对象" }),
});

function zodErrorOf(value: unknown): z.ZodError {
	const r = Schema.safeParse(value);
	if (r.success) throw new Error("夹具应当过不了校验");
	return r.error;
}

describe("ConfigValidationError.fromZod", () => {
	it("是 invalid;逐格原因进 issues(路径 + 原话),zod 自己的字段不外泄", () => {
		const err = ConfigValidationError.fromZod("subscriptions", zodErrorOf({ name: 1, fans: "x" }));
		expect(err.code).toBe("invalid");
		expect(err.scope).toBe("subscriptions");
		expect(err.issues.map((i) => i.path)).toEqual([["name"], ["fans"], ["nested"]]);
		expect(err.issues[0]).toEqual({ path: ["name"], message: "名字要是字符串" });
		for (const issue of err.issues) expect(Object.keys(issue).sort()).toEqual(["message", "path"]);
	});

	it("顶上那句是中文,点出这一块配置和格数,摊开前几条", () => {
		const err = ConfigValidationError.fromZod("targets", zodErrorOf({ name: 1, fans: "x" }));
		expect(err.message).toBe(
			"推送目标有 3 格不合法：name：名字要是字符串；fans：粉丝数要是数字；nested：嵌套要是对象",
		);
	});

	it("原因多于三条时只摊三条,并说明总数", () => {
		const many = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string() });
		const r = many.safeParse({});
		if (r.success) throw new Error("夹具应当过不了校验");
		const err = ConfigValidationError.fromZod("globals", r.error);
		expect(err.issues).toHaveLength(4);
		expect(err.message).toMatch(/^全局设置有 4 格不合法：a：.+；b：.+；c：.+；……共 4 处$/);
	});

	it("prefix 接在每条路径前(盘上数组第几行),subject 换掉开头的名字", () => {
		const err = ConfigValidationError.fromZod("connections", zodErrorOf({ name: "x", fans: 1 }), {
			subject: "connections.json 第 3 行",
			prefix: [2],
		});
		expect(err.issues).toEqual([{ path: [2, "nested"], message: "嵌套要是对象" }]);
		expect(err.message).toMatch(/^connections\.json 第 3 行有 1 格不合法：2\.nested：/);
	});

	it("落在根上的原因没有 path,摊开时只留话", () => {
		const err = ConfigValidationError.fromZod("globals", zodErrorOf("not an object"));
		expect(err.issues[0]).not.toHaveProperty("path");
		expect(err.message).not.toContain("：：");
	});
});

describe("ConfigValidationError 手抛的三种", () => {
	it("invalid / not_found / conflict 各带自己的码,scope 留作数据", () => {
		expect(ConfigValidationError.invalid("connections", "不合规")).toMatchObject({
			code: "invalid",
			scope: "connections",
			message: "不合规",
			issues: [],
		});
		expect(ConfigValidationError.notFound("targets", "没有这个")).toMatchObject({
			code: "not_found",
			scope: "targets",
		});
		expect(ConfigValidationError.conflict("connections", "还被用着")).toMatchObject({
			code: "conflict",
		});
	});

	it("是 Error(栈、instanceof 照旧),name 认得出来", () => {
		const err = ConfigValidationError.notFound("targets", "没有这个");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(ConfigValidationError);
		expect(err.name).toBe("ConfigValidationError");
	});
});

describe("toFailure", () => {
	it("回给面板的是标准失败:码、话、逐格原因;scope 不上线", () => {
		const failure = ConfigValidationError.fromZod(
			"subscriptions",
			zodErrorOf({ name: 1, fans: 1, nested: { tags: [] } }),
		).toFailure();
		expect(failure).toEqual({
			ok: false,
			code: "invalid",
			message: "订阅有 1 格不合法：name：名字要是字符串",
			issues: [{ path: ["name"], message: "名字要是字符串" }],
		});
		expect(failure).not.toHaveProperty("scope");
	});

	it("没有逐格原因就不带 issues 这一格", () => {
		const failure = ConfigValidationError.conflict("targets", "托管的不能直接改").toFailure();
		expect(failure).toEqual({ ok: false, code: "conflict", message: "托管的不能直接改" });
		expect(failure).not.toHaveProperty("issues");
	});
});
