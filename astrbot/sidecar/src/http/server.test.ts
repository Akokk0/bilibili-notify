import type { LoginSnapshot } from "@bilibili-notify/api";
import { BiliLoginStatus } from "@bilibili-notify/api";
import {
	type AstrBotPushTarget,
	type DeliveryResult,
	makeDefaultGlobalConfig,
	type Subscription,
} from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ASTRBOT_ADAPTER_ID,
	ASTRBOT_PUSH_ADAPTER,
	ASTRBOT_TARGET_ID,
} from "../runtime/callback-sink.js";
import {
	type DeliveryJob,
	SidecarDeliveryQueue,
	SidecarEventQueue,
} from "../runtime/event-queue.js";
import { createSidecarSnapshot } from "../runtime/state.js";
import type { SidecarHttpRuntime } from "./server.js";
import { closeSidecarServer, createSidecarHttpServer, listenSidecarServer } from "./server.js";

const TEST_TOKEN = "test-token";
const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN}` };

const TARGET: AstrBotPushTarget = {
	id: "33333333-3333-4333-8333-333333333333",
	name: "测试群聊",
	adapterId: ASTRBOT_ADAPTER_ID,
	platform: "astrbot",
	scope: "group",
	enabled: true,
	session: {
		unified_msg_origin: "aiocqhttp:GroupMessage:123456",
		platform: "aiocqhttp",
		messageType: "group",
		sessionId: "123456",
		sessionName: "测试群聊",
	},
};

describe("sidecar http server", () => {
	const servers: ReturnType<typeof createSidecarHttpServer>[] = [];

	afterEach(async () => {
		while (servers.length > 0) {
			const server = servers.pop();
			if (server) await closeSidecarServer(server);
		}
	});

	it("exposes health, meta, bootstrap and root routes", async () => {
		const harness = createTestHarness();
		const server = createSidecarHttpServer({
			getSnapshot: harness.snapshot,
			runtime: harness.runtime,
			authToken: TEST_TOKEN,
		});
		servers.push(server);
		const address = await listenSidecarServer(server, "127.0.0.1", 0);
		const baseUrl = `http://${address.host}:${address.port}`;

		const [healthResponse, metaResponse, bootstrapResponse, rootResponse] = await Promise.all([
			fetch(`${baseUrl}/api/health`, { headers: AUTH_HEADERS }),
			fetch(`${baseUrl}/api/meta`, { headers: AUTH_HEADERS }),
			fetch(`${baseUrl}/api/bootstrap`, { headers: AUTH_HEADERS }),
			fetch(baseUrl),
		]);

		expect(healthResponse.status).toBe(200);
		expect(metaResponse.status).toBe(200);
		expect(bootstrapResponse.status).toBe(200);
		expect(rootResponse.status).toBe(200);
		expect(await healthResponse.json()).toMatchObject({
			status: "ready",
			version: "0.0.0-dev",
			aiBackend: "astrbot",
			capabilities: { tokenAuth: true, pluginPageProxy: true, sse: true },
			business: {
				started: true,
				authStarted: false,
				subscriptions: { count: 0 },
				events: { size: 0 },
			},
		});
		expect(await metaResponse.json()).toMatchObject({
			business: {
				started: true,
				authStarted: false,
			},
		});
		expect(await bootstrapResponse.json()).toMatchObject({
			globals: { app: { logLevel: "info" } },
			subscriptions: [],
			adapters: [ASTRBOT_PUSH_ADAPTER],
			targets: [],
		});
		expect(await rootResponse.text()).toContain("bilibili-notify AstrBot sidecar");
	});

	it("requires token for protected API routes", async () => {
		const harness = createTestHarness();
		const server = createSidecarHttpServer({
			getSnapshot: harness.snapshot,
			runtime: harness.runtime,
			authToken: TEST_TOKEN,
		});
		servers.push(server);
		const address = await listenSidecarServer(server, "127.0.0.1", 0);
		const baseUrl = `http://${address.host}:${address.port}`;

		const response = await fetch(`${baseUrl}/api/subscriptions`);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ error: "unauthorized" });
		expect(harness.runtime.listSubscriptions).not.toHaveBeenCalled();
	});

	it("polls events, streams SSE and rejects malformed cursors", async () => {
		const harness = createTestHarness();
		harness.events.push({ type: "auth-lost" });
		harness.events.push({
			type: "notification",
			targetId: ASTRBOT_TARGET_ID,
			private: false,
			payload: { kind: "text", text: "hello" },
			result: { ok: true, latencyMs: 12 },
		});
		const server = createSidecarHttpServer({
			getSnapshot: harness.snapshot,
			runtime: harness.runtime,
			authToken: TEST_TOKEN,
		});
		servers.push(server);
		const address = await listenSidecarServer(server, "127.0.0.1", 0);
		const baseUrl = `http://${address.host}:${address.port}`;

		const okResponse = await fetch(`${baseUrl}/api/events?after=1`, { headers: AUTH_HEADERS });
		expect(okResponse.status).toBe(200);
		expect(await okResponse.json()).toEqual([
			expect.objectContaining({ id: 2, type: "notification" }),
		]);

		const streamResponse = await fetch(`${baseUrl}/api/events/stream`, { headers: AUTH_HEADERS });
		expect(streamResponse.status).toBe(200);
		expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
		const reader = streamResponse.body?.getReader();
		expect(reader).toBeDefined();
		const chunk = await reader?.read();
		await reader?.cancel();
		expect(new TextDecoder().decode(chunk?.value)).toContain("event: hydrate");

		const badResponse = await fetch(`${baseUrl}/api/events?after=abc`, { headers: AUTH_HEADERS });
		expect(badResponse.status).toBe(400);
		expect(await badResponse.json()).toMatchObject({
			error: "invalid_after",
		});
	});

	it("claims delivery jobs and records ack/nack receipts", async () => {
		const harness = createTestHarness();
		const job = harness.deliveries.enqueue({
			target: TARGET,
			private: false,
			payload: { kind: "text", text: "hello" },
		});
		const server = createSidecarHttpServer({
			getSnapshot: harness.snapshot,
			runtime: harness.runtime,
			authToken: TEST_TOKEN,
		});
		servers.push(server);
		const address = await listenSidecarServer(server, "127.0.0.1", 0);
		const baseUrl = `http://${address.host}:${address.port}`;

		const claimResponse = await fetch(`${baseUrl}/api/deliveries?limit=1`, {
			headers: AUTH_HEADERS,
		});
		expect(claimResponse.status).toBe(200);
		const claimed = (await claimResponse.json()) as DeliveryJob[];
		expect(claimed).toHaveLength(1);
		expect(claimed[0]).toMatchObject({
			deliveryId: job.deliveryId,
			targetId: TARGET.id,
			attempt: 1,
			session: { unified_msg_origin: "aiocqhttp:GroupMessage:123456" },
		});

		const nackResponse = await fetch(`${baseUrl}/api/deliveries/${job.deliveryId}/nack`, {
			method: "POST",
			headers: { ...AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ error: "send failed token=secret" }),
		});
		expect(nackResponse.status).toBe(200);
		expect(await nackResponse.json()).toMatchObject({
			deliveryId: job.deliveryId,
			ok: false,
			dropped: false,
			err: "send failed token=[REDACTED]",
		});

		const missingAckResponse = await fetch(`${baseUrl}/api/deliveries/missing/ack`, {
			method: "POST",
			headers: AUTH_HEADERS,
		});
		expect(missingAckResponse.status).toBe(404);
	});

	it("patches globals and resets them through danger endpoints", async () => {
		const harness = createTestHarness();
		const server = createSidecarHttpServer({
			getSnapshot: harness.snapshot,
			runtime: harness.runtime,
			authToken: TEST_TOKEN,
		});
		servers.push(server);
		const address = await listenSidecarServer(server, "127.0.0.1", 0);
		const baseUrl = `http://${address.host}:${address.port}`;

		const patchResponse = await fetch(`${baseUrl}/api/globals`, {
			method: "PATCH",
			headers: { ...AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ app: { logLevel: "debug" } }),
		});

		expect(patchResponse.status).toBe(200);
		expect(await patchResponse.json()).toMatchObject({ app: { logLevel: "debug" } });
		expect(harness.runtime.setGlobals).toHaveBeenCalledTimes(1);

		const resetResponse = await fetch(`${baseUrl}/api/danger/reset-globals`, {
			method: "POST",
			headers: AUTH_HEADERS,
		});
		expect(resetResponse.status).toBe(200);
		expect(await resetResponse.json()).toMatchObject({ app: { logLevel: "info" } });
		expect(harness.runtime.resetGlobals).toHaveBeenCalledTimes(1);
	});

	it("creates, patches, lists and deletes AstrBot subscriptions", async () => {
		const harness = createTestHarness();
		const server = createSidecarHttpServer({
			getSnapshot: harness.snapshot,
			runtime: harness.runtime,
			authToken: TEST_TOKEN,
		});
		servers.push(server);
		const address = await listenSidecarServer(server, "127.0.0.1", 0);
		const baseUrl = `http://${address.host}:${address.port}`;

		const postResponse = await fetch(`${baseUrl}/api/subscriptions`, {
			method: "POST",
			headers: { ...AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({
				uid: "123456",
				name: "测试 UP 主",
				dynamic: false,
				live: true,
			}),
		});

		expect(postResponse.status).toBe(200);
		const posted = (await postResponse.json()) as Array<Record<string, unknown>>;
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({
			uid: "123456",
			name: "测试 UP 主",
			routing: {
				dynamic: [],
				live: [ASTRBOT_TARGET_ID],
				liveEnd: [ASTRBOT_TARGET_ID],
			},
		});
		expect(harness.runtime.upsertSubscription).toHaveBeenCalledTimes(1);

		const subscriptionId = String(posted[0]?.id ?? "");
		const patchResponse = await fetch(`${baseUrl}/api/subscriptions/${subscriptionId}`, {
			method: "PATCH",
			headers: { ...AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ notes: "备注" }),
		});
		expect(patchResponse.status).toBe(200);
		expect(await patchResponse.json()).toMatchObject({ id: subscriptionId, notes: "备注" });

		const listResponse = await fetch(`${baseUrl}/api/subs`, { headers: AUTH_HEADERS });
		expect(listResponse.status).toBe(200);
		expect(await listResponse.json()).toEqual([expect.objectContaining({ id: subscriptionId })]);

		const deleteResponse = await fetch(`${baseUrl}/api/subscriptions/${subscriptionId}`, {
			method: "DELETE",
			headers: AUTH_HEADERS,
		});
		expect(deleteResponse.status).toBe(204);

		const emptyResponse = await fetch(`${baseUrl}/api/subscriptions`, { headers: AUTH_HEADERS });
		expect(await emptyResponse.json()).toEqual([]);
	});

	it("manages AstrBot targets and sends pure text test pushes", async () => {
		const harness = createTestHarness();
		const server = createSidecarHttpServer({
			getSnapshot: harness.snapshot,
			runtime: harness.runtime,
			authToken: TEST_TOKEN,
		});
		servers.push(server);
		const address = await listenSidecarServer(server, "127.0.0.1", 0);
		const baseUrl = `http://${address.host}:${address.port}`;

		const adaptersResponse = await fetch(`${baseUrl}/api/adapters`, { headers: AUTH_HEADERS });
		expect(adaptersResponse.status).toBe(200);
		expect(await adaptersResponse.json()).toEqual([ASTRBOT_PUSH_ADAPTER]);

		const createResponse = await fetch(`${baseUrl}/api/targets`, {
			method: "POST",
			headers: { ...AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify(TARGET),
		});
		expect(createResponse.status).toBe(200);
		expect(await createResponse.json()).toEqual([TARGET]);

		const patchResponse = await fetch(`${baseUrl}/api/targets/${TARGET.id}`, {
			method: "PATCH",
			headers: { ...AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ name: "新名称" }),
		});
		expect(patchResponse.status).toBe(200);
		expect(await patchResponse.json()).toMatchObject({ id: TARGET.id, name: "新名称" });

		const pushResponse = await fetch(`${baseUrl}/api/push/test`, {
			method: "POST",
			headers: { ...AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ targetId: TARGET.id, text: "hello" }),
		});
		expect(pushResponse.status).toBe(200);
		expect(await pushResponse.json()).toMatchObject({ ok: true, latencyMs: 1 });
		expect(harness.runtime.pushTest).toHaveBeenCalledWith(TARGET.id, {
			kind: "text",
			text: "hello",
		});

		const deleteResponse = await fetch(`${baseUrl}/api/targets/${TARGET.id}`, {
			method: "DELETE",
			headers: AUTH_HEADERS,
		});
		expect(deleteResponse.status).toBe(204);
	});

	it("exposes login, lookup and search control endpoints", async () => {
		const harness = createTestHarness();
		const server = createSidecarHttpServer({
			getSnapshot: harness.snapshot,
			runtime: harness.runtime,
			authToken: TEST_TOKEN,
		});
		servers.push(server);
		const address = await listenSidecarServer(server, "127.0.0.1", 0);
		const baseUrl = `http://${address.host}:${address.port}`;

		const statusResponse = await fetch(`${baseUrl}/api/login/status`, { headers: AUTH_HEADERS });
		expect(statusResponse.status).toBe(200);
		expect(await statusResponse.json()).toMatchObject({
			status: BiliLoginStatus.NOT_LOGIN,
			msg: "未登录",
		});
		expect(harness.runtime.ensureAuthStarted).toHaveBeenCalledTimes(1);

		const qrResponse = await fetch(`${baseUrl}/api/auth/qr`, {
			method: "POST",
			headers: AUTH_HEADERS,
		});
		expect(qrResponse.status).toBe(200);
		expect(await qrResponse.json()).toMatchObject({
			status: BiliLoginStatus.LOGIN_QR,
			msg: "",
			data: "data:image/png;base64,QR",
		});
		expect(harness.runtime.beginLogin).toHaveBeenCalledTimes(1);

		const lookupResponse = await fetch(`${baseUrl}/api/subs/lookup?uid=42`, {
			headers: AUTH_HEADERS,
		});
		expect(lookupResponse.status).toBe(200);
		expect(await lookupResponse.json()).toMatchObject({ uid: "42", name: "UP 42" });

		const searchResponse = await fetch(`${baseUrl}/api/subscriptions/search?q=test&page=2`, {
			headers: AUTH_HEADERS,
		});
		expect(searchResponse.status).toBe(200);
		expect(await searchResponse.json()).toMatchObject({
			page: 2,
			pageSize: 5,
			results: [expect.objectContaining({ uid: "1001" })],
		});

		const logoutResponse = await fetch(`${baseUrl}/api/login/logout`, {
			method: "POST",
			headers: AUTH_HEADERS,
		});
		expect(logoutResponse.status).toBe(200);
		expect(await logoutResponse.json()).toMatchObject({ status: BiliLoginStatus.NOT_LOGIN });
		expect(harness.runtime.logout).toHaveBeenCalledTimes(1);
	});
});

function createTestHarness() {
	const events = new SidecarEventQueue();
	const deliveries = new SidecarDeliveryQueue({ events, maxAttempts: 2, baseBackoffMs: 10 });
	let globals = makeDefaultGlobalConfig();
	const subscriptions: Subscription[] = [];
	const targets: AstrBotPushTarget[] = [];
	let login: LoginSnapshot = {
		status: BiliLoginStatus.NOT_LOGIN,
		msg: "未登录",
	};
	const runtime: SidecarHttpRuntime = {
		ensureAuthStarted: vi.fn(async () => login),
		beginLogin: vi.fn(async () => {
			login = {
				status: BiliLoginStatus.LOGIN_QR,
				msg: "",
				data: "data:image/png;base64,QR",
			};
			return login;
		}),
		logout: vi.fn(async () => {
			login = { status: BiliLoginStatus.NOT_LOGIN, msg: "账号未登录，请点击「扫码登录」" };
			return login;
		}),
		getGlobals: vi.fn(() => structuredClone(globals)),
		setGlobals: vi.fn(async (next) => {
			globals = structuredClone(next);
			return structuredClone(globals);
		}),
		resetGlobals: vi.fn(async () => {
			globals = makeDefaultGlobalConfig();
			return structuredClone(globals);
		}),
		listSubscriptions: vi.fn(() => structuredClone(subscriptions)),
		listAdapters: vi.fn(() => [ASTRBOT_PUSH_ADAPTER]),
		listTargets: vi.fn(() => structuredClone(targets)),
		upsertSubscription: vi.fn(async (subscription) => {
			const idx = subscriptions.findIndex((entry) => entry.id === subscription.id);
			if (idx === -1) {
				subscriptions.push(subscription);
			} else {
				subscriptions[idx] = subscription;
			}
			return subscription;
		}),
		patchSubscription: vi.fn(async (id, patch) => {
			const idx = subscriptions.findIndex((entry) => entry.id === id);
			if (idx === -1) throw new Error(`subscription not found: ${id}`);
			const next = deepMerge(subscriptions[idx], patch) as Subscription;
			subscriptions[idx] = next;
			return next;
		}),
		removeSubscription: vi.fn(async (id: string) => {
			const idx = subscriptions.findIndex((entry) => entry.id === id);
			if (idx === -1) return undefined;
			const [removed] = subscriptions.splice(idx, 1);
			return removed;
		}),
		upsertTarget: vi.fn(async (target) => {
			const idx = targets.findIndex((entry) => entry.id === target.id);
			if (idx === -1) targets.push(target);
			else targets[idx] = target;
			return target;
		}),
		patchTarget: vi.fn(async (id, patch) => {
			const idx = targets.findIndex((entry) => entry.id === id);
			if (idx === -1) throw new Error(`target not found: ${id}`);
			const next = deepMerge(targets[idx], patch) as AstrBotPushTarget;
			targets[idx] = next;
			return next;
		}),
		removeTarget: vi.fn(async (id) => {
			const idx = targets.findIndex((entry) => entry.id === id);
			if (idx === -1) return undefined;
			const [removed] = targets.splice(idx, 1);
			return removed;
		}),
		clearSubscriptions: vi.fn(async () => {
			subscriptions.length = 0;
			return [];
		}),
		clearTargets: vi.fn(async () => {
			targets.length = 0;
			return [];
		}),
		clearSubscriptionOverrides: vi.fn(async () => subscriptions),
		lookupUser: vi.fn(async (uid) => ({
			uid,
			name: `UP ${uid}`,
			avatar: "https://example.invalid/avatar.png",
			sign: "签名",
			fans: 42,
		})),
		searchUsers: vi.fn(async (_query, page = 1) => ({
			results: [
				{
					uid: "1001",
					name: "搜索结果",
					avatar: "https://example.invalid/avatar.png",
					sign: "",
					fans: 100,
				},
			],
			page,
			pageSize: 5,
			total: 1,
		})),
		drainEvents: vi.fn((afterId = 0) => events.drain(afterId)),
		claimDeliveries: vi.fn((limit = 10) => deliveries.claim({ limit })),
		ackDelivery: vi.fn(async (deliveryId) => deliveries.ack(deliveryId)),
		nackDelivery: vi.fn(async (deliveryId, error) => deliveries.nack(deliveryId, error)),
		pushTest: vi.fn(
			async (_targetId, _payload) => ({ ok: true, latencyMs: 1 }) satisfies DeliveryResult,
		),
	};

	return {
		deliveries,
		events,
		runtime,
		snapshot: () =>
			createSidecarSnapshot({
				status: "ready",
				version: "0.0.0-dev",
				pid: 4321,
				host: "127.0.0.1",
				port: 0,
				startedAt: "2026-06-03T00:00:00.000Z",
				readyAt: "2026-06-03T00:00:01.000Z",
				aiBackend: "astrbot",
				capabilities: {
					tokenAuth: true,
					pluginPageProxy: true,
					sse: true,
					deliveryQueue: true,
					aiProviderBridge: false,
				},
				business: {
					started: true,
					authStarted: login.status !== BiliLoginStatus.NOT_LOGIN,
					deliveries: deliveries.snapshot(),
					engines: {
						dynamic: true,
						live: false,
					},
					subscriptions: {
						count: subscriptions.length,
						path: "/tmp/subscriptions.json",
					},
					events: events.snapshot(),
					login,
				},
			}),
	};
}

function deepMerge(base: unknown, patch: unknown): unknown {
	if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		out[key] = deepMerge(out[key], value);
	}
	return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
