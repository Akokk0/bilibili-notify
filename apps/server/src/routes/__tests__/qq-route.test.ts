/**
 * 单元测试 — /api/qq 路由只剩扫码绑定(那两个口的测试在 qq-bind-route.test.ts)。
 * 挑群 / 频道地址的两个读口(`/sessions/:connectionId`、`/guilds/:connectionId`)已经搬到
 * `GET /api/connections/:id/addresses`,这里钉住旧的两个不再存在。
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { createQQRoute } from "../qq.js";
import type { RouteDeps } from "../types.js";

function makeApp() {
	return createQQRoute({
		runtime: {
			serviceCtx: { logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } },
		},
	} as unknown as RouteDeps);
}

describe("/api/qq 不再有的两个读口", () => {
	it.each(["/sessions/a1", "/guilds/a1"])("GET %s → 404(路由不存在)", async (path) => {
		const res = await makeApp().request(path);
		expect(res.status).toBe(404);
	});
});
