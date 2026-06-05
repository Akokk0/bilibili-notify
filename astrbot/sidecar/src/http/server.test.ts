import type { LoginSnapshot } from "@bilibili-notify/api";
import { BiliLoginStatus } from "@bilibili-notify/api";
import type { Subscription } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASTRBOT_TARGET_ID } from "../runtime/callback-sink.js";
import { SidecarEventQueue } from "../runtime/event-queue.js";
import { createSidecarSnapshot } from "../runtime/state.js";
import type { SidecarHttpRuntime } from "./server.js";
import { closeSidecarServer, createSidecarHttpServer, listenSidecarServer } from "./server.js";

describe("sidecar http server", () => {
	const servers: ReturnType<typeof createSidecarHttpServer>[] = [];

	afterEach(async () => {
		while (servers.length > 0) {
			const server = servers.pop();
			if (server) await closeSidecarServer(server);
		}
	});

	it("exposes health, meta and root routes", async () => {
		const harness = createTestHarness();
		const server = createSidecarHttpServer({
			getSnapshot: harness.snapshot,
			runtime: harness.runtime,
		});
		servers.push(server);
		const address = await listenSidecarServer(server, "127.0.0.1", 0);
		const baseUrl = `http://${address.host}:${address.port}`;

		const [healthResponse, metaResponse, rootResponse] = await Promise.all([
			fetch(`${baseUrl}/api/health`),
			fetch(`${baseUrl}/api/meta`),
			fetch(baseUrl),
		]);

		expect(healthResponse.status).toBe(200);
		expect(metaResponse.status).toBe(200);
		expect(rootResponse.status).toBe(200);
		expect(await healthResponse.json()).toMatchObject({
			status: "ready",
			version: "0.0.0-dev",
			aiBackend: "astrbot",
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
		expect(await rootResponse.text()).toContain("bilibili-notify AstrBot sidecar");
	});

	it("polls events and rejects malformed cursors", async () => {
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
		});
		servers.push(server);
		const address = await listenSidecarServer(server, "127.0.0.1", 0);
		const baseUrl = `http://${address.host}:${address.port}`;

		const okResponse = await fetch(`${baseUrl}/api/events?after=1`);
		expect(okResponse.status).toBe(200);
		expect(await okResponse.json()).toEqual([
			expect.objectContaining({ id: 2, type: "notification" }),
		]);

		const badResponse = await fetch(`${baseUrl}/api/events?after=abc`);
		expect(badResponse.status).toBe(400);
		expect(await badResponse.json()).toMatchObject({
			error: "invalid_after",
		});
	});

	it("creates, lists and deletes AstrBot subscriptions", async () => {
		const harness = createTestHarness();
		const server = createSidecarHttpServer({
			getSnapshot: harness.snapshot,
			runtime: harness.runtime,
		});
		servers.push(server);
		const address = await listenSidecarServer(server, "127.0.0.1", 0);
		const baseUrl = `http://${address.host}:${address.port}`;

		const postResponse = await fetch(`${baseUrl}/api/subscriptions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
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

		const listResponse = await fetch(`${baseUrl}/api/subscriptions`);
		expect(listResponse.status).toBe(200);
		expect(await listResponse.json()).toEqual(posted);

		const subscriptionId = String(posted[0]?.id ?? "");
		const deleteResponse = await fetch(`${baseUrl}/api/subscriptions/${subscriptionId}`, {
			method: "DELETE",
		});
		expect(deleteResponse.status).toBe(204);

		const emptyResponse = await fetch(`${baseUrl}/api/subscriptions`);
		expect(await emptyResponse.json()).toEqual([]);
	});

	it("exposes login status and QR control endpoints", async () => {
		const harness = createTestHarness();
		const server = createSidecarHttpServer({
			getSnapshot: harness.snapshot,
			runtime: harness.runtime,
		});
		servers.push(server);
		const address = await listenSidecarServer(server, "127.0.0.1", 0);
		const baseUrl = `http://${address.host}:${address.port}`;

		const statusResponse = await fetch(`${baseUrl}/api/login/status`);
		expect(statusResponse.status).toBe(200);
		expect(await statusResponse.json()).toMatchObject({
			status: BiliLoginStatus.NOT_LOGIN,
			msg: "未登录",
		});
		expect(harness.runtime.ensureAuthStarted).toHaveBeenCalledTimes(1);

		const qrResponse = await fetch(`${baseUrl}/api/login/qr`, { method: "POST" });
		expect(qrResponse.status).toBe(200);
		expect(await qrResponse.json()).toMatchObject({
			status: BiliLoginStatus.LOGIN_QR,
			msg: "",
			data: "data:image/png;base64,QR",
		});
		expect(harness.runtime.beginLogin).toHaveBeenCalledTimes(1);
	});
});

function createTestHarness() {
	const events = new SidecarEventQueue();
	const subscriptions: Subscription[] = [];
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
		listSubscriptions: vi.fn(() => [...subscriptions]),
		upsertSubscription: vi.fn(async (subscription) => {
			const idx = subscriptions.findIndex((entry) => entry.id === subscription.id);
			if (idx === -1) {
				subscriptions.push(subscription);
			} else {
				subscriptions[idx] = subscription;
			}
			return subscription;
		}),
		removeSubscription: vi.fn(async (id: string) => {
			const idx = subscriptions.findIndex((entry) => entry.id === id);
			if (idx === -1) return undefined;
			const [removed] = subscriptions.splice(idx, 1);
			return removed;
		}),
		drainEvents: vi.fn((afterId = 0) => events.drain(afterId)),
	};

	return {
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
				business: {
					started: true,
					authStarted: login.status !== BiliLoginStatus.NOT_LOGIN,
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
