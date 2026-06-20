/**
 * 单元测试 — history 路由的 limit/since 输入校验(P2-J)。
 *
 * 报告 #P2:`limit=Number("abc")` → NaN 经 Math.min/max 透传成 limit=NaN
 * 静默喂给 query();`since` 非 ISO 直接透传致静默 no-op / 错误过滤。修复后
 * 非法 limit / since 显式 400,而非静默坏行为。
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createHistoryRoute } from "../history.js";
import type { RouteDeps } from "../types.js";

let query: ReturnType<typeof vi.fn>;

function makeApp() {
	query = vi.fn(async () => []);
	const deps = {
		runtime: { historyStore: { query, imageDir: () => "/tmp" } },
	} as unknown as RouteDeps;
	return createHistoryRoute(deps);
}

describe("history route — limit/since 校验 (P2-J)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("limit 非数字 → 400,不调用 query", async () => {
		const res = await makeApp().request("/?limit=abc");
		expect(res.status).toBe(400);
		expect(query).not.toHaveBeenCalled();
	});

	it("since 非 ISO → 400,不调用 query", async () => {
		const res = await makeApp().request("/?since=notadate");
		expect(res.status).toBe(400);
		expect(query).not.toHaveBeenCalled();
	});

	it("合法 limit → 200,query 收到 clamp 后的 limit", async () => {
		const res = await makeApp().request("/?limit=50");
		expect(res.status).toBe(200);
		expect(query).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 50 });
	});

	it("limit 越界 → clamp 到 [1,500](500 上限)", async () => {
		await makeApp().request("/?limit=9999");
		expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 500 });
	});

	it("合法 ISO since → 200 透传", async () => {
		const since = "2026-01-01T00:00:00.000Z";
		const res = await makeApp().request(`/?since=${encodeURIComponent(since)}`);
		expect(res.status).toBe(200);
		expect(query.mock.calls[0]?.[0]).toMatchObject({ since });
	});

	it("无任何 query 参数 → 200,默认 limit=100", async () => {
		const res = await makeApp().request("/");
		expect(res.status).toBe(200);
		expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 100 });
	});
});
