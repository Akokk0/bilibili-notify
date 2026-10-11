/**
 * 单元测试 — `GET /api/problems`:问题表此刻的全部,按 `since` 先后一次给全。
 *
 * 路由只读内存里的表(真表,不是替身),没有失败支;挂不挂进 app 由 `routes-by-resource-mount` 守着。
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { createProblemTable } from "../../problems/problem-table.js";
import { makeLogger } from "../../subscriptions/__tests__/fixtures.js";
import { createProblemsRoute } from "../problems.js";
import type { RouteDeps } from "../types.js";

function appOf() {
	const problems = createProblemTable({ logger: makeLogger() });
	const deps = { runtime: { problems } } as unknown as RouteDeps;
	return { app: createProblemsRoute(deps), problems };
}

describe("GET /api/problems", () => {
	it("空表:200,problems 是空数组", async () => {
		const { app } = appOf();
		const res = await app.request("/");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ problems: [] });
	});

	it("表里有什么给什么:来源级与订阅级,带 since,按先后", async () => {
		const { app, problems } = appOf();
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-10-11T00:00:00.000Z"));
			problems.report({ reporter: "src", code: "auth_lost", message: "登录失效", notify: true });
			vi.setSystemTime(new Date("2026-10-11T00:01:00.000Z"));
			problems.report({
				reporter: "src",
				about: { subscriptionId: "s1" },
				code: "monitor_stopped",
				message: "停了",
			});
		} finally {
			vi.useRealTimers();
		}
		const body = await (await app.request("/")).json();
		expect(body).toEqual({
			problems: [
				{
					reporter: "src",
					code: "auth_lost",
					message: "登录失效",
					since: "2026-10-11T00:00:00.000Z",
				},
				{
					reporter: "src",
					about: { subscriptionId: "s1" },
					code: "monitor_stopped",
					message: "停了",
					since: "2026-10-11T00:01:00.000Z",
				},
			],
		});
	});

	it("问题清掉后读不到", async () => {
		const { app, problems } = appOf();
		problems.report({ reporter: "src", code: "auth_lost", message: "x" });
		problems.resolve({ reporter: "src", code: "auth_lost" });
		expect(await (await app.request("/")).json()).toEqual({ problems: [] });
	});
});
