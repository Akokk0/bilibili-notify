import { describe, expect, it } from "vitest";
import { ApiError, dashboardApi, errorDetails, resolveApiBase } from "./client";

describe("resolveApiBase", () => {
	it("uses the AstrBot plugin API prefix when the page is served under the plugin path", () => {
		expect(
			resolveApiBase({
				locationPathname: "/astrbot_plugin_bilibili_notify/pages/dashboard/index.html",
			}),
		).toBe("/api/plug/astrbot_plugin_bilibili_notify/api");
	});

	it("uses /api during local Vite development", () => {
		expect(resolveApiBase({ locationPathname: "/" })).toBe("/api");
	});

	it("detects the AstrBot plugin API prefix from the bundled script path", () => {
		expect(
			resolveApiBase({
				locationPathname: "/",
				currentScriptSrc: "/astrbot_plugin_bilibili_notify/pages/dashboard/assets/index.js",
			}),
		).toBe("/api/plug/astrbot_plugin_bilibili_notify/api");
	});
});

describe("AstrBot Plugin Page bridge API", () => {
	it("uses bridge apiGet with parsed query params", async () => {
		const calls: unknown[] = [];
		const restore = installBridge({
			apiGet(endpoint: string, params?: Record<string, string>) {
				calls.push({ kind: "get", endpoint, params });
				return Promise.resolve({ uid: "42", name: "UP 42", avatar: "", sign: "", fans: 0 });
			},
			apiPost() {
				throw new Error("unexpected apiPost");
			},
		});
		try {
			await dashboardApi.lookupUser("42");
			expect(calls).toEqual([
				{ kind: "get", endpoint: "subscriptions/lookup", params: { uid: "42" } },
			]);
		} finally {
			restore();
		}
	});

	it("tunnels PATCH and DELETE through bridge apiPost for AstrBot 4.25.x", async () => {
		const calls: unknown[] = [];
		const restore = installBridge({
			apiGet() {
				throw new Error("unexpected apiGet");
			},
			apiPost(endpoint: string, body?: unknown) {
				calls.push({ kind: "post", endpoint, body });
				return Promise.resolve({ app: { logLevel: "debug" } });
			},
		});
		try {
			await dashboardApi.patchGlobals({ app: { logLevel: "debug" } } as unknown as Parameters<
				typeof dashboardApi.patchGlobals
			>[0]);
			await dashboardApi.deleteSubscription("sub-1");
			expect(calls).toEqual([
				{
					kind: "post",
					endpoint: "globals?_method=PATCH",
					body: { app: { logLevel: "debug" } },
				},
				{
					kind: "post",
					endpoint: "subscriptions/sub-1?_method=DELETE",
					body: undefined,
				},
			]);
		} finally {
			restore();
		}
	});
});

function installBridge(bridge: {
	apiGet(endpoint: string, params?: Record<string, string>): Promise<unknown>;
	apiPost(endpoint: string, body?: unknown): Promise<unknown>;
}) {
	const globalWithBridge = globalThis as typeof globalThis & { AstrBotPluginPage?: unknown };
	const previous = globalWithBridge.AstrBotPluginPage;
	globalWithBridge.AstrBotPluginPage = bridge;
	return () => {
		if (previous === undefined) {
			delete globalWithBridge.AstrBotPluginPage;
		} else {
			globalWithBridge.AstrBotPluginPage = previous;
		}
	};
}

describe("errorDetails", () => {
	it("summarizes validation issues from ApiError bodies", () => {
		const details = errorDetails(
			new ApiError(
				400,
				{ message: "配置不合法", issues: [{ path: ["defaults", "ai"], message: "bad" }] },
				"bad request",
			),
		);
		expect(details.summary).toBe("配置不合法");
		expect(details.detail).toContain("defaults.ai: bad");
	});
});
