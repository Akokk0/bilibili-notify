import type { ProblemsResponse } from "@bilibili-notify/contract";
import { Hono } from "hono";
import type { RouteDeps } from "./types.js";

/**
 * `/api/problems` — 问题表此刻的全部(各集成报上来的「主人该知道的事」,全在内存)。
 *
 * - `GET /` 按 `since` 先后一次给全。变了服务端发 `problems-changed`(按报的人合并过),面板据此重取。
 *
 * 只读内存里的表,没有失败支。
 */
export function createProblemsRoute(deps: RouteDeps): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		const body: ProblemsResponse = { problems: [...deps.runtime.problems.list()] };
		return c.json(body);
	});

	return app;
}
