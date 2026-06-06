import { describe, expect, it, vi } from "vitest";
import { ConfigValidationError } from "../config/store.js";
import { createTargetsRoute } from "../routes/targets.js";
import type { RouteDeps } from "../routes/types.js";

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

describe("targets route", () => {
	it("DELETE /:id 将托管 target 的直接删除错误映射为 409", async () => {
		const app = createTargetsRoute(
			makeDeps({
				deleteTarget: async () => {
					throw new ConfigValidationError(
						"targets",
						{ id: "t1", message: "managed target cannot be deleted directly" },
						"managed target",
					);
				},
			}),
		);

		const res = await app.request("/t1", { method: "DELETE" });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			error: "validation_failed",
			scope: "targets",
			issues: { id: "t1", message: "managed target cannot be deleted directly" },
		});
	});

	it("PATCH /:id 不允许外部修改托管 target 的 testStatus", async () => {
		const app = createTargetsRoute(
			makeDeps({
				patchTarget: async () => {
					throw new ConfigValidationError(
						"targets",
						{ id: "t1", keys: ["testStatus"], message: "managed target cannot be edited directly" },
						"managed target",
					);
				},
			}),
		);

		const res = await app.request("/t1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ testStatus: { ok: true, lastCheckedAt: "2026-06-06T00:00:00.000Z" } }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "validation_failed",
			scope: "targets",
			issues: {
				id: "t1",
				keys: ["testStatus"],
				message: "managed target cannot be edited directly",
			},
		});
	});
});
