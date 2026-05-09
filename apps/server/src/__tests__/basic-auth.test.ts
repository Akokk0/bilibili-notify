import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

// ---------------------------------------------------------------------------
// Plan §4.2 Fix 4a — basic-auth on /api/*
// ---------------------------------------------------------------------------

function makeBootstrap(dataDir: string): BootstrapConfig {
	return {
		server: { host: "127.0.0.1", port: 8787 },
		dataDir,
		logLevel: "silent",
	};
}

function basicHeader(user: string, pass: string): string {
	return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

describe("HTTP basic-auth", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-basic-auth-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("with credentials configured: GET /api/globals without header returns 401", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {
			basicAuthCredentials: { username: "admin", password: "s3cret" },
		});

		const res = await app.request("/api/globals");
		expect(res.status).toBe(401);

		await runtime.dispose();
	});

	it("with credentials configured: GET /api/globals with valid creds returns 200", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {
			basicAuthCredentials: { username: "admin", password: "s3cret" },
		});

		const res = await app.request("/api/globals", {
			headers: { Authorization: basicHeader("admin", "s3cret") },
		});
		expect(res.status).toBe(200);
		const body = JSON.parse(await res.text()) as Record<string, unknown>;
		// Globals payload is non-empty when present.
		expect(typeof body).toBe("object");

		await runtime.dispose();
	});

	it("with credentials configured: wrong password returns 401", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {
			basicAuthCredentials: { username: "admin", password: "s3cret" },
		});

		const res = await app.request("/api/globals", {
			headers: { Authorization: basicHeader("admin", "wrong") },
		});
		expect(res.status).toBe(401);

		await runtime.dispose();
	});

	it("without credentials configured: GET /api/globals returns 200 anonymously", async () => {
		// This is intentional — local dev should run bare; the bootstrap layer
		// emits a warn log instead of refusing to start.
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {});

		const res = await app.request("/api/globals");
		expect(res.status).toBe(200);

		await runtime.dispose();
	});

	it("with credentials configured: /api/health is also gated (no anon liveness probe)", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {
			basicAuthCredentials: { username: "admin", password: "s3cret" },
		});

		const noAuth = await app.request("/api/health");
		expect(noAuth.status).toBe(401);

		const withAuth = await app.request("/api/health", {
			headers: { Authorization: basicHeader("admin", "s3cret") },
		});
		expect(withAuth.status).toBe(200);

		await runtime.dispose();
	});
});
