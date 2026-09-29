/**
 * 读 JSON 请求体的共用口子:坏体回 `Failure`(标准码 + 中文话),好体原样交出去。
 */

import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { readJsonBody, readJsonObject } from "../request-body.js";

function appOf(reader: typeof readJsonBody | typeof readJsonObject): Hono {
	const app = new Hono();
	app.post("/", async (c) => c.json(await reader(c)));
	return app;
}

async function post(app: Hono, body: string): Promise<unknown> {
	const res = await app.request("/", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
	return res.json();
}

describe("readJsonBody", () => {
	it("合法的 JSON 原样交出去(数组、标量也算合法 JSON)", async () => {
		const app = appOf(readJsonBody);
		expect(await post(app, '{"a":1}')).toEqual({ ok: true, body: { a: 1 } });
		expect(await post(app, "[1,2]")).toEqual({ ok: true, body: [1, 2] });
	});

	it("不是合法的 JSON → invalid + 中文话", async () => {
		expect(await post(appOf(readJsonBody), "{oops")).toEqual({
			ok: false,
			code: "invalid",
			message: "请求体不是合法的 JSON",
		});
	});
});

describe("readJsonObject", () => {
	it("对象交出去", async () => {
		expect(await post(appOf(readJsonObject), '{"name":"x"}')).toEqual({
			ok: true,
			body: { name: "x" },
		});
	});

	it.each([
		["数组", "[1]"],
		["标量", "42"],
		["null", "null"],
	])("%s 不是对象 → invalid", async (_n, raw) => {
		expect(await post(appOf(readJsonObject), raw)).toEqual({
			ok: false,
			code: "invalid",
			message: "请求体要是一个 JSON 对象，不能是数组或单个值",
		});
	});

	it("不是合法的 JSON 时说的是 JSON 的事,不是对象的事", async () => {
		expect(await post(appOf(readJsonObject), "nope")).toMatchObject({
			code: "invalid",
			message: "请求体不是合法的 JSON",
		});
	});
});
