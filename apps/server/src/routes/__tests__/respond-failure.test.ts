import { FAILURE_CODES, type Failure, type FailureCode, fail } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vite-plus/test";
import { failureOfHttpException, respondFailure, statusOf } from "../respond-failure.js";

describe("statusOf:失败码 → HTTP 状态码", () => {
	it.each([
		["not_found", 404],
		["invalid", 400],
		["unauthorized", 403],
		["rate_limited", 429],
		["unavailable", 503],
		["timeout", 504],
		["unsupported", 400],
		["conflict", 409],
		["indeterminate", 502],
		["unknown", 500],
	] as const)("%s → %i", (code, status) => {
		expect(statusOf(code)).toBe(status);
	});

	it("码表里的每个码都有状态码", () => {
		for (const code of Object.keys(FAILURE_CODES) as FailureCode[]) {
			expect(statusOf(code), code).toBeGreaterThanOrEqual(400);
		}
	});
});

describe("respondFailure:错误体平铺 { code, message }", () => {
	async function call(failure: Failure, status?: Parameters<typeof respondFailure>[2]) {
		const app = new Hono().get("/", (c) => respondFailure(c, failure, status));
		const res = await app.request("/");
		return { res, body: (await res.json()) as Record<string, unknown> };
	}

	it("状态码从 code 推,体是去掉 ok 的 { code, message }", async () => {
		const { res, body } = await call(fail("not_found", "查无此人"));
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(body).toEqual({ code: "not_found", message: "查无此人" });
	});

	it("没给的附加格不出现:键里没有 ok,也没有值为 undefined 的键", async () => {
		const failure = { ...fail("invalid", "不对"), issues: undefined, upstreamCode: undefined };
		const { body } = await call(failure);
		expect(Object.keys(body).sort()).toEqual(["code", "message"]);
	});

	it("issues 与 upstreamCode 原样带上", async () => {
		const issues = [{ path: ["a", 0, "b"], message: "太长" }, { message: "整体不对" }];
		const { res, body } = await call(
			fail("rate_limited", "被风控了", { upstreamCode: -352, issues }),
		);
		expect(res.status).toBe(429);
		expect(body).toEqual({ code: "rate_limited", message: "被风控了", upstreamCode: -352, issues });
	});

	it("调用方可以指定状态码(如 413),code 不变", async () => {
		const { res, body } = await call(fail("invalid", "文件太大"), 413);
		expect(res.status).toBe(413);
		expect(body.code).toBe("invalid");
	});

	it("清单封闭:failure 上混进来的别的字段不往外甩", async () => {
		const sloppy = { ...fail("conflict", "版本对不上"), revision: "r2", usedBy: ["x"] } as Failure;
		const { body } = await call(sloppy);
		expect(Object.keys(body).sort()).toEqual(["code", "message"]);
	});
});

describe("failureOfHttpException:Hono 抛出的 HTTPException 按状态码挑码", () => {
	it.each([
		[400, "invalid"],
		[401, "unauthorized"],
		[404, "not_found"],
		[409, "conflict"],
		[413, "invalid"],
		[418, "invalid"],
		[429, "rate_limited"],
		[500, "unavailable"],
		[502, "unavailable"],
		[503, "unavailable"],
	] as const)("%i → %s,状态码照原样", (status, code) => {
		const out = failureOfHttpException(new HTTPException(status, { message: "它自己的话" }));
		expect(out.status).toBe(status);
		expect(out.failure).toEqual(fail(code, "它自己的话"));
	});

	it("没有 message 时给一句中文", () => {
		for (const status of [400, 401, 404, 409, 413, 429, 500] as const) {
			const { failure } = failureOfHttpException(new HTTPException(status));
			expect(failure.message, String(status)).toMatch(/\S/);
			expect(failure.message, String(status)).toMatch(/[一-鿿]/);
		}
	});
});
