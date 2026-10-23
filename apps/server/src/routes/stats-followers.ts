import type { FollowersResponse } from "@bilibili-notify/contract";
import { Hono } from "hono";
import type { RouteDeps } from "./types.js";

/**
 * `GET /api/stats/followers` — 返回最近一轮资料刷新算出的 entries。Dashboard 的
 * FansPanel 用作初次水合数据;之后由 WS `push-events` 的 `followers-refreshed`
 * 事件增量补丁同一 react-query 缓存。
 *
 * Bootstrap 阶段(资料刷新尚未挂上)返回空数组 + 503 体内提示,前端面板
 * 显示"采样中…"。第一轮 tick 完成后切换到 200 + entries。
 */

export function createStatsFollowersRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	app.get("/", (c) => {
		const refresh = deps.runtime.profileRefresh;
		if (!refresh) {
			return c.json<FollowersResponse>({ entries: [] });
		}
		return c.json<FollowersResponse>({ entries: refresh.getLastEntries() });
	});
	return app;
}
