import { FAILURE_CODES, type Failure, type FailureCode, fail } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	errorBodyOf,
	failureOfHttpException,
	requestErrorHandler,
	respondFailure,
	statusOf,
	unhandledErrorMessage,
} from "../respond-failure.js";

describe("statusOf:失败码 → HTTP 状态码", () => {
	it.each([
		["not_found", 404],
		["invalid", 400],
		["unauthorized", 403],
		["rate_limited", 429],
		["unavailable", 503],
		["not_configured", 409],
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

describe("errorBodyOf:不经 HTTP 状态码、把失败塞进别的通道时用的错误体(如 SSE 的 error 帧)", () => {
	it("去掉 ok,只留 { code, message },没给的附加格不出现", () => {
		const body = errorBodyOf(fail("unavailable", "女仆那边没写成"));
		expect(body).toEqual({ code: "unavailable", message: "女仆那边没写成" });
		expect(Object.keys(body).sort()).toEqual(["code", "message"]);
	});

	it("issues 与 upstreamCode 原样带上;混进来的别的字段不往外甩(清单封闭)", () => {
		const sloppy = {
			...fail("invalid", "没通过检查（共 1 条）", {
				issues: [{ message: "太长" }],
				upstreamCode: 7,
			}),
			usedBy: ["x"],
		} as Failure;
		expect(errorBodyOf(sloppy)).toEqual({
			code: "invalid",
			message: "没通过检查（共 1 条）",
			issues: [{ message: "太长" }],
			upstreamCode: 7,
		});
	});

	it("respondFailure 回的体就是它 —— 两个出口不会各长各的", async () => {
		const failure = fail("conflict", "撞名了", { issues: [{ message: "甲" }] });
		const app = new Hono().get("/", (c) => respondFailure(c, failure));
		const res = await app.request("/");
		expect(await res.json()).toEqual(errorBodyOf(failure));
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

describe("requestErrorHandler:全局出错处理(app.ts 与被进程内直接 request 的子实例共用这一份)", () => {
	function appThatThrows(err: Error) {
		const logger = { error: vi.fn() };
		const app = new Hono().onError(requestErrorHandler(logger)).get("/", () => {
			throw err;
		});
		return { app, logger };
	}

	it("普通抛错是 bug:503 unavailable + 固定一句话,原始错误进错误日志、不回给客户端", async () => {
		const boom = new Error("ENOENT: no such file or directory, open 'state/x.json'");
		const { app, logger } = appThatThrows(boom);

		const res = await app.request("/");

		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ code: "unavailable", message: unhandledErrorMessage() });
		expect(logger.error).toHaveBeenCalledWith("unhandled request error", boom);
	});

	it("HTTPException 按它的状态码挑码,状态码与 message 照原样;4xx 不记错误日志", async () => {
		const { app, logger } = appThatThrows(new HTTPException(409, { message: "撞名了" }));

		const res = await app.request("/");

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ code: "conflict", message: "撞名了" });
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("5xx 的 HTTPException 记错误日志", async () => {
		const { app, logger } = appThatThrows(new HTTPException(502, { message: "上游挂了" }));

		const res = await app.request("/");

		expect(res.status).toBe(502);
		expect(((await res.json()) as { code: string }).code).toBe("unavailable");
		expect(logger.error).toHaveBeenCalledTimes(1);
	});

	it("子实例挂了它以后,直接 request 抛的错也是失败的形状(不是 Hono 默认的纯文本 500)", async () => {
		const bare = new Hono().get("/", () => {
			throw new Error("盘挂了");
		});
		const bareRes = await bare.request("/");
		expect(bareRes.headers.get("content-type")).not.toContain("application/json");

		const { app } = appThatThrows(new Error("盘挂了"));
		const res = await app.request("/");
		expect(res.headers.get("content-type")).toContain("application/json");
	});
});
