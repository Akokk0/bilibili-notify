/**
 * 单元测试 — logs 路由的 limit/day 输入校验(镜像 history-route 的
 * 「非法 query 显式 400 而非静默坏行为」契约)。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createLogsRoute } from "../logs.js";
import type { RouteDeps } from "../types.js";

let query: ReturnType<typeof vi.fn>;

function makeApp() {
	query = vi.fn(async () => []);
	const deps = {
		runtime: {
			logStore: { query, dayFilePath: (d: string) => join(tmpdir(), `bn-logs-test-${d}.jsonl`) },
		},
	} as unknown as RouteDeps;
	return createLogsRoute(deps);
}

describe("logs route — limit/day 校验", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("limit 非数字 → 400,不调用 query", async () => {
		const res = await makeApp().request("/?limit=abc");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "limit 要是数字：abc" });
		expect(query).not.toHaveBeenCalled();
	});

	it("day 非 YYYY-MM-DD → 400,不调用 query", async () => {
		const res = await makeApp().request("/?day=2026_05_17");
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			message: expect.stringContaining("day"),
		});
		expect(query).not.toHaveBeenCalled();
	});

	it("合法 limit → 200,clamp 后透传", async () => {
		const res = await makeApp().request("/?limit=50");
		expect(res.status).toBe(200);
		expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 50 });
	});

	it("limit 越界 → clamp 到 500 上限", async () => {
		await makeApp().request("/?limit=9999");
		expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 500 });
	});

	it("合法 day → 200 透传", async () => {
		const res = await makeApp().request("/?day=2026-05-17");
		expect(res.status).toBe(200);
		expect(query.mock.calls[0]?.[0]).toMatchObject({ day: "2026-05-17" });
	});

	it("无参数 → 200,默认 limit=200", async () => {
		const res = await makeApp().request("/");
		expect(res.status).toBe(200);
		expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 200 });
	});

	it("/raw 缺 day / 非法 day → 400", async () => {
		const missing = await makeApp().request("/raw");
		expect(missing.status).toBe(400);
		expect(await missing.json()).toMatchObject({ code: "invalid" });
		const bad = await makeApp().request("/raw?day=bad");
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ code: "invalid" });
	});

	/** 这条下载是 GET,失败也是平铺的 `{ code, message }` JSON —— 面板下载时读 `message`,不是一段纯文本。 */
	it("/raw 那一天没有日志文件 → 404 not_found", async () => {
		const res = await makeApp().request("/raw?day=1999-01-01");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这一天的日志文件" });
	});
});
