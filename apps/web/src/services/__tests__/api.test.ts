import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../api";

/**
 * SY1 的线格式收口。`JSON.stringify` 会把值为 `undefined` 的键整个丢掉,于是
 * 「把一个可选字段清空」在 PATCH body 里根本表达不出来 —— 键消失了,服务端
 * deepMerge 读作「本字段不改」,旧值原样留下(玻璃片透明度关掉后存不掉、日志
 * 覆盖清不干净都是这一个根因)。服务端约定显式 `null` = 清除,所以 PATCH 出口
 * 统一把 `undefined` 改写成 `null`。POST 不做这件事:那是创建语义,`undefined`
 * 表示「没有这个字段」,擅自转成 null 会被后端 schema 拒掉。
 */
function jsonResponse(): Response {
	return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}

function sentBody(): unknown {
	const call = vi.mocked(globalThis.fetch).mock.calls.at(-1);
	const init = call?.[1] as RequestInit;
	return JSON.parse(String(init.body));
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => jsonResponse()),
	);
});
afterEach(() => vi.unstubAllGlobals());

describe("api.patch wire format", () => {
	it("rewrites a cleared optional field to the null clear-sentinel", async () => {
		await api.patch("/api/globals", { app: { userAgent: undefined } });

		expect(sentBody()).toEqual({ app: { userAgent: null } });
	});

	it("reaches arbitrarily deep — a cleared glassOpacity survives as null", async () => {
		await api.patch("/api/globals", {
			defaults: { cardStyle: { font: "sans", glassOpacity: undefined } },
		});

		expect(sentBody()).toEqual({
			defaults: { cardStyle: { font: "sans", glassOpacity: null } },
		});
	});

	it("leaves an explicit null, real values, and arrays alone", async () => {
		await api.patch("/api/subs/1", {
			overrides: { cardStyle: null },
			groups: ["重点"],
			enabled: false,
		});

		expect(sentBody()).toEqual({
			overrides: { cardStyle: null },
			groups: ["重点"],
			enabled: false,
		});
	});

	it("does not rewrite POST bodies — there `undefined` means 'no such field'", async () => {
		await api.post("/api/cards/preview", { kind: "dynamic", layout: undefined });

		expect(sentBody()).toEqual({ kind: "dynamic" });
	});
});
