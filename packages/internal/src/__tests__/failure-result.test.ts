/**
 * 失败规矩的零件(ADR-0026 决策 3、6):标准码表、`ok()` / `fail()`、zod 报错翻成 `Issue`。
 *
 * 码表的期望值照抄 docs/agents/conventions/failure-results.md 那张表,不从实现里推 ——
 * 表改了,这里和文档得一起改。
 */

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { FAILURE_CODES, type Failure, fail, issuesFromZod, ok, type Result } from "../constants";

describe("标准码表", () => {
	it("十个码、按文档的顺序,各带「自动重试」那一列", () => {
		expect(FAILURE_CODES).toStrictEqual({
			not_found: { retry: "no" },
			invalid: { retry: "no" },
			unauthorized: { retry: "no" },
			rate_limited: { retry: "later" },
			unavailable: { retry: "later" },
			timeout: { retry: "later" },
			unsupported: { retry: "no" },
			conflict: { retry: "depends" },
			indeterminate: { retry: "never" },
			unknown: { retry: "no" },
		});
		expect(Object.keys(FAILURE_CODES)).toEqual([
			"not_found",
			"invalid",
			"unauthorized",
			"rate_limited",
			"unavailable",
			"timeout",
			"unsupported",
			"conflict",
			"indeterminate",
			"unknown",
		]);
	});
});

describe("ok()", () => {
	it("不带内容就是 { ok: true }", () => {
		expect(ok()).toStrictEqual({ ok: true });
	});

	it("带内容时铺平在 ok 旁边,不改动传进来的对象", () => {
		const profile = { name: "某人" };
		const payload = { profile };
		const result = ok(payload);
		expect(result).toStrictEqual({ ok: true, profile: { name: "某人" } });
		expect(payload).toStrictEqual({ profile });
	});

	it("内容里不许自带 ok 这一格", () => {
		// @ts-expect-error —— 内容的 ok 会把判别键盖掉
		ok({ ok: false });
	});
});

describe("fail()", () => {
	it("只给码和原话:恰好三格,不留值为 undefined 的键", () => {
		expect(fail("not_found", "查无此人")).toStrictEqual({
			ok: false,
			code: "not_found",
			message: "查无此人",
		});
	});

	it("上游平台的码只进 upstreamCode,逐条原因进 issues", () => {
		expect(
			fail("rate_limited", "被风控了", {
				upstreamCode: -352,
				issues: [{ path: ["q"], message: "太频繁" }],
			}),
		).toStrictEqual({
			ok: false,
			code: "rate_limited",
			message: "被风控了",
			upstreamCode: -352,
			issues: [{ path: ["q"], message: "太频繁" }],
		});
	});

	it("码只收标准码表里的:fail() 的参数与 Failure 类型本身都不收表外的", () => {
		// @ts-expect-error —— 表外的码
		fail("nope", "不在表里");
		// @ts-expect-error —— 类型本身也得拦:别处按 Failure 标注的值同样不许装表外的码
		const typed: Failure = { ok: false, code: "nope", message: "不在表里" };
		expect(typed.ok).toBe(false);
	});
});

describe("Result", () => {
	it("按 ok 收窄:成功那支有内容,失败那支有码和原话", () => {
		const read = (hit: boolean): Result<{ profile: string }> =>
			hit ? ok({ profile: "某人" }) : fail("not_found", "查无此人");
		const hitResult = read(true);
		const missResult = read(false);
		expect(hitResult.ok && hitResult.profile).toBe("某人");
		expect(!missResult.ok && missResult.code).toBe("not_found");
	});
});

describe("issuesFromZod()", () => {
	it("每条报错翻成 { path, message },路径里的数字下标照留", () => {
		const parsed = z
			.object({ links: z.array(z.object({ name: z.string() })) })
			.safeParse({ links: [{ name: 1 }] });
		expect(parsed.success).toBe(false);
		if (parsed.success) return;
		const issues = issuesFromZod(parsed.error);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.path).toEqual(["links", 0, "name"]);
		expect(typeof issues[0]?.message).toBe("string");
		expect(Object.keys(issues[0] ?? {}).sort()).toEqual(["message", "path"]);
	});

	it("落在根上的报错没有 path 这一格", () => {
		const parsed = z.string().safeParse(1);
		if (parsed.success) throw new Error("应当校验不过");
		const [issue] = issuesFromZod(parsed.error);
		expect(issue).toBeDefined();
		expect(issue && "path" in issue).toBe(false);
	});
});
