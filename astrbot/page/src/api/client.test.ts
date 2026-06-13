import { describe, expect, it } from "vitest";
import {
	ApiError,
	dashboardApi,
	errorDetails,
	resolveApiBase,
	subscribeDashboardEvents,
} from "./client";

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
	it("uses bridge apiGet for bootstrap with the plugin API prefix", async () => {
		const calls: unknown[] = [];
		const restore = installBridge({
			apiGet(endpoint: string, params?: Record<string, string>) {
				calls.push({ kind: "get", endpoint, params });
				return Promise.resolve({ snapshot: {}, globals: {}, subscriptions: [], targets: [] });
			},
			apiPost() {
				throw new Error("unexpected apiPost");
			},
		});
		try {
			await dashboardApi.bootstrap();
			expect(calls).toEqual([{ kind: "get", endpoint: "api/bootstrap", params: {} }]);
		} finally {
			restore();
		}
	});

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
				{ kind: "get", endpoint: "api/subscriptions/lookup", params: { uid: "42" } },
			]);
		} finally {
			restore();
		}
	});

	it("uses bridge apiPost with the plugin API prefix", async () => {
		const calls: unknown[] = [];
		const restore = installBridge({
			apiGet() {
				throw new Error("unexpected apiGet");
			},
			apiPost(endpoint: string, body?: unknown) {
				calls.push({ kind: "post", endpoint, body });
				return Promise.resolve({ status: "pending" });
			},
		});
		try {
			await dashboardApi.beginLogin();
			expect(calls).toEqual([{ kind: "post", endpoint: "api/login/qr", body: undefined }]);
		} finally {
			restore();
		}
	});

	it("uses the plugin API prefix for bridge SSE subscriptions", () => {
		const calls: unknown[] = [];
		const restore = installBridge({
			apiGet() {
				throw new Error("unexpected apiGet");
			},
			apiPost() {
				throw new Error("unexpected apiPost");
			},
			subscribeSSE(endpoint: string, _handlers: unknown, params?: Record<string, string>) {
				calls.push({ endpoint, params });
				return Promise.resolve("sub-1");
			},
		});
		try {
			const cleanup = subscribeDashboardEvents({
				onHydrate() {},
				onRefresh() {},
				onOpen() {},
				onError() {},
			});
			cleanup?.();
			expect(calls).toEqual([{ endpoint: "api/events/stream", params: undefined }]);
		} finally {
			restore();
		}
	});

	it("tunnels PATCH and DELETE through bridge apiPost envelopes", async () => {
		const calls: unknown[] = [];
		const restoreBridge = installBridge({
			apiGet() {
				throw new Error("unexpected apiGet");
			},
			apiPost(endpoint: string, body?: unknown) {
				calls.push({ endpoint, body });
				return Promise.resolve({ id: "sub-1" });
			},
		});
		const restoreFetch = installFetch(() => {
			throw new Error("unexpected direct fetch");
		});
		try {
			await dashboardApi.patchSubscription("sub-1", {
				routing: { dynamic: ["target-1"] },
			});
			await dashboardApi.deleteSubscription("sub-1");
			expect(calls).toEqual([
				{
					endpoint: "api/subscriptions/sub-1",
					body: {
						__bn_proxy_method: "PATCH",
						__bn_proxy_body: { routing: { dynamic: ["target-1"] } },
					},
				},
				{
					endpoint: "api/subscriptions/sub-1",
					body: { __bn_proxy_method: "DELETE" },
				},
			]);
		} finally {
			restoreFetch();
			restoreBridge();
		}
	});
});

function installBridge(bridge: {
	apiGet(endpoint: string, params?: Record<string, string>): Promise<unknown>;
	apiPost(endpoint: string, body?: unknown): Promise<unknown>;
	subscribeSSE?(
		endpoint: string,
		handlers: unknown,
		params?: Record<string, string>,
	): Promise<string>;
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

function installFetch(fetchImpl: typeof fetch) {
	const previous = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	return () => {
		globalThis.fetch = previous;
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
