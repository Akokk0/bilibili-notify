/**
 * 读 JSON 请求体的共用口子:坏体回 `Failure`(标准码 + 中文话),好体原样交出去。
 */

import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { readJsonBody, readJsonObject } from "../request-body.js";

afterEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

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

it.each([
	[
		"en",
		"The request body is not valid JSON.",
		"The request body must be a JSON object, not an array or a scalar value.",
	],
	[
		"ja",
		"リクエスト本文は有効なJSONではありません。",
		"リクエスト本文にはJSONオブジェクトを指定してください。配列や単一の値は指定できません。",
	],
	["zh-TW", "請求本文不是有效的 JSON。", "請求本文必須是 JSON 物件，不能是陣列或單一值。"],
] as const)("%s:格式原因区分JSON语法与对象形状,合法内容保持原样", async (locale, json, object) => {
	i18n.set({ locale, voice: "plain" });
	for (const reader of [readJsonBody, readJsonObject])
		expect(await post(appOf(reader), "{ Original invalid")).toEqual({
			ok: false,
			code: "invalid",
			message: json,
		});
	for (const body of ["[]", "42", "null"])
		expect(await post(appOf(readJsonObject), body)).toEqual({
			ok: false,
			code: "invalid",
			message: object,
		});
	expect(await post(appOf(readJsonObject), '{"name":"Original 原文","nested":[1,null]}')).toEqual({
		ok: true,
		body: { name: "Original 原文", nested: [1, null] },
	});
	expect(await post(appOf(readJsonBody), '["Original 原文",42]')).toEqual({
		ok: true,
		body: ["Original 原文", 42],
	});
});

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
