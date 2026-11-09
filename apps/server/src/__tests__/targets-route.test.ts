/**
 * /api/targets 的失败一律是平铺的 `{ code, message }`(ADR-0026):store 抛的 `ConfigValidationError`
 * 自带标准码,路由按码回状态码,不嗅文案。守卫「错误体」在每条测试收尾对一遍回出去的体。
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ConfigValidationError } from "../config/store.js";
import { i18n } from "../i18n/index.js";
import { createTargetsRoute } from "../routes/targets.js";
import type { RouteDeps } from "../routes/types.js";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

function makeDeps(overrides: Partial<RouteDeps["store"]>): RouteDeps {
	return {
		runtime: {
			serviceCtx: {
				logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			},
		},
		store: {
			getTargets: () => [],
			...overrides,
		},
		puppeteer: null,
		wsTicketStore: null,
	} as unknown as RouteDeps;
}

function json(method: string, body: unknown): RequestInit {
	return {
		method,
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	};
}

describe("targets route 的失败", () => {
	it.each([
		["en", "This push target was not found."],
		["ja", "このプッシュ送信先が見つかりません。"],
		["zh-TW", "找不到此推送目標。"],
	] as const)(
		"%s returns a localized missing-target error on deletion",
		async (locale, message) => {
			const remove = vi.fn(async () => false);
			const app = createTargetsRoute(makeDeps({ deleteTarget: remove }));
			i18n.set({ locale, voice: "plain" });
			const res = await app.request("/original-id", { method: "DELETE" });
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({ code: "not_found", message });
			expect(remove).toHaveBeenCalledExactlyOnceWith("original-id");
		},
	);
	it("POST 体不是合法 JSON → 400 invalid", async () => {
		const app = createTargetsRoute(makeDeps({}));
		const res = await app.request("/", json("POST", "{oops"));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "请求体不是合法的 JSON" });
	});

	it("POST store 拒收 → 400 invalid,逐格原因进 issues,scope 不上线", async () => {
		const app = createTargetsRoute(
			makeDeps({
				upsertTarget: async () => {
					throw ConfigValidationError.invalid(
						"targets",
						"推送目标有 1 格不合法：address：不能为空",
						[{ path: ["address"], message: "不能为空" }],
					);
				},
			}),
		);
		const res = await app.request("/", json("POST", { id: "t1" }));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			code: "invalid",
			message: "推送目标有 1 格不合法：address：不能为空",
			issues: [{ path: ["address"], message: "不能为空" }],
		});
	});

	it("PATCH 体是数组 → 400 invalid", async () => {
		const app = createTargetsRoute(makeDeps({}));
		const res = await app.request("/t1", json("PATCH", "[1]"));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			code: "invalid",
			message: "请求体要是一个 JSON 对象，不能是数组或单个值",
		});
	});

	it("PATCH 没这个目标 → 404 not_found(按码回,不嗅文案)", async () => {
		const app = createTargetsRoute(
			makeDeps({
				patchTarget: async () => {
					throw ConfigValidationError.notFound("targets", "没有 id 为 t1 的推送目标");
				},
			}),
		);
		const res = await app.request("/t1", json("PATCH", { name: "x" }));
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有 id 为 t1 的推送目标" });
	});

	it("PATCH 不允许外部修改托管 target → 409 conflict", async () => {
		const app = createTargetsRoute(
			makeDeps({
				patchTarget: async () => {
					throw ConfigValidationError.conflict("targets", "这个推送目标由它的连接托管，不能直接改");
				},
			}),
		);
		const res = await app.request(
			"/t1",
			json("PATCH", { testStatus: { ok: true, lastCheckedAt: "2026-06-06T00:00:00.000Z" } }),
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			code: "conflict",
			message: "这个推送目标由它的连接托管，不能直接改",
		});
	});

	it("DELETE 没这个目标 → 404 not_found", async () => {
		const app = createTargetsRoute(makeDeps({ deleteTarget: async () => false }));
		const res = await app.request("/ghost", { method: "DELETE" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这个推送目标" });
	});

	it("DELETE 托管 target 的直接删除 → 409 conflict", async () => {
		const app = createTargetsRoute(
			makeDeps({
				deleteTarget: async () => {
					throw ConfigValidationError.conflict("targets", "这个推送目标由它的连接托管，不能直接删");
				},
			}),
		);
		const res = await app.request("/t1", { method: "DELETE" });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			code: "conflict",
			message: "这个推送目标由它的连接托管，不能直接删",
		});
	});

	it("DELETE 成功 → 204", async () => {
		const app = createTargetsRoute(makeDeps({ deleteTarget: async () => true }));
		expect((await app.request("/t1", { method: "DELETE" })).status).toBe(204);
	});
});
