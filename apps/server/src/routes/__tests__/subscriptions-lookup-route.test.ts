/**
 * `/api/subscriptions/lookup` 与 `/api/subscriptions/search` —— 「添加 UP」弹窗查人的两个口子的失败形状(ADR-0026)。
 *
 * - B 站自己的数字码(`res.code`)只放 `upstreamCode`,永远不占 `code`;`code` 是标准码。
 * - 「现在的意思」照旧,分类不扩大:lookup 的 B 站非 0 一律当 `not_found`(风控 / 未登录也在里头,
 *   分类是第 3a 期 `searchCreators` 的事);search 的非 0 是 `unavailable`。
 * - 抛出来的是原始报错:原话只进日志,回给面板一句固定的中文。
 * - 面板不再按状态码换句子,直接显示 `message` —— 所以每种失败的 `message` 都要自己说得通。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { createSubscriptionsRoute } from "../subscriptions.js";
import type { RouteDeps } from "../types.js";

interface Api {
	getUserCardInfo?: (uid: string) => Promise<unknown>;
	searchByType?: (type: string, q: string, opts: unknown) => Promise<unknown>;
}

function makeApp(api: Api | null) {
	const warn = vi.fn();
	const app = createSubscriptionsRoute({
		store: { getSubscriptions: () => [] },
		runtime: {
			serviceCtx: { logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } },
			subRuntimeStore: { get: () => undefined },
			engines: api ? { api } : null,
		},
	} as unknown as RouteDeps);
	return { app, warn };
}

const CARD = {
	code: 0,
	data: { card: { mid: "12345", name: "测试UP", face: "https://x/a.png", sign: "签名", fans: 99 } },
};

describe("GET /api/subscriptions/lookup", () => {
	it("uid 不是纯数字 → 400 invalid", async () => {
		const { app } = makeApp({ getUserCardInfo: async () => CARD });
		const res = await app.request("/lookup?uid=abc");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "uid 必须是纯数字 UID" });
	});

	it("引擎还没起 → 503 unavailable,话里说清等什么", async () => {
		const { app } = makeApp(null);
		const res = await app.request("/lookup?uid=12345");
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			code: "unavailable",
			message: "B 站 API 尚未就绪，请等登录完成或稍后再试",
		});
	});

	it("B 站说查无此人 → 404 not_found;B 站的数字码在 upstreamCode,不占 code", async () => {
		const { app } = makeApp({ getUserCardInfo: async () => ({ code: -404, data: null }) });
		const res = await app.request("/lookup?uid=12345");
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body).toEqual({
			code: "not_found",
			message: "未找到该 UP 主，请检查 UID 是否正确",
			upstreamCode: -404,
		});
		expect(typeof (body as { code: unknown }).code).toBe("string");
	});

	it("风控 -352 现在的意思照旧(not_found),码同样只放 upstreamCode —— 分类是 3a 的事", async () => {
		const { app } = makeApp({ getUserCardInfo: async () => ({ code: -352, data: null }) });
		const res = await app.request("/lookup?uid=12345");
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: "not_found", upstreamCode: -352 });
	});

	it("调用抛错 → 503 unavailable,原话只进日志、不回给面板", async () => {
		const { app, warn } = makeApp({
			getUserCardInfo: async () => {
				throw new Error("getaddrinfo ENOTFOUND api.bilibili.com");
			},
		});
		const res = await app.request("/lookup?uid=12345");
		expect(res.status).toBe(503);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({
			code: "unavailable",
			message: "无法访问 B 站，详情在日志里",
		});
		expect(text).not.toContain("ENOTFOUND");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("ENOTFOUND"));
	});

	it("查到了 → 200 资料", async () => {
		const { app } = makeApp({ getUserCardInfo: async () => CARD });
		const res = await app.request("/lookup?uid=12345");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ uid: "12345", name: "测试UP" });
	});
});

describe("GET /api/subscriptions/search", () => {
	it("关键词是空的 → 400 invalid,话就是面板要显示的那句", async () => {
		const { app } = makeApp({ searchByType: async () => ({ code: 0 }) });
		const res = await app.request("/search?q=%20");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "搜索关键词不能为空" });
	});

	it("引擎还没起 → 503 unavailable", async () => {
		const { app } = makeApp(null);
		const res = await app.request("/search?q=abc");
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: "unavailable" });
	});

	it("B 站回非 0 → 503 unavailable,B 站的话进 message、数字码进 upstreamCode", async () => {
		const { app } = makeApp({
			searchByType: async () => ({ code: -799, message: "请求过于频繁，请稍后再试" }),
		});
		const res = await app.request("/search?q=abc");
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			code: "unavailable",
			message: "无法访问 B 站：请求过于频繁，请稍后再试",
			upstreamCode: -799,
		});
	});

	it("B 站回非 0 但没带话 → 兜一句「搜索失败」,message 不许是空的", async () => {
		const { app } = makeApp({ searchByType: async () => ({ code: -1 }) });
		const res = await app.request("/search?q=abc");
		expect(await res.json()).toEqual({
			code: "unavailable",
			message: "无法访问 B 站：搜索失败",
			upstreamCode: -1,
		});
	});

	it("调用抛错 → 503 unavailable,原话只进日志", async () => {
		const { app, warn } = makeApp({
			searchByType: async () => {
				throw new Error("socket hang up");
			},
		});
		const res = await app.request("/search?q=abc");
		expect(res.status).toBe(503);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({
			code: "unavailable",
			message: "无法访问 B 站，详情在日志里",
		});
		expect(text).not.toContain("socket hang up");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("socket hang up"));
	});

	it("搜到了 → 200 分页结果", async () => {
		const { app } = makeApp({
			searchByType: async () => ({
				code: 0,
				data: {
					numResults: 1,
					result: [{ mid: 7, uname: '<em class="keyword">阿</em>婆', upic: "//x/a.png", fans: 3 }],
				},
			}),
		});
		const res = await app.request("/search?q=阿婆");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			results: [{ uid: "7", name: "阿婆", avatar: "https://x/a.png", fans: 3 }],
			total: 1,
		});
	});
});
