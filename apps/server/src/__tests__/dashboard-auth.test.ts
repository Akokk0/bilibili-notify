import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp } from "../app.js";
import { createSessionCodec } from "../auth/session.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

// ---------------------------------------------------------------------------
// Dashboard auth — cookie-session model (replaces the old HTTP Basic gate).
// Q4: cookie-only, no Basic, 401 without WWW-Authenticate.
// ---------------------------------------------------------------------------

const KEY = Buffer.from("test-key-material-32-bytes-long!!", "utf8");
const CREDS = { username: "admin", password: "s3cret" };

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("dashboard cookie auth", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-dash-auth-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("auth configured: no cookie → 401 without WWW-Authenticate", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, { basicAuthCredentials: CREDS, sessionCodec: codec });

		const res = await app.request("/api/globals");
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBeNull();

		await runtime.dispose();
	});

	it("auth configured: valid bn_session cookie → 200", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, { basicAuthCredentials: CREDS, sessionCodec: codec });

		const res = await app.request("/api/globals", {
			headers: { Cookie: `bn_session=${codec.sign()}` },
		});
		expect(res.status).toBe(200);

		await runtime.dispose();
	});

	it("auth configured: Authorization: Basic is NOT accepted (cookie-only)", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, { basicAuthCredentials: CREDS, sessionCodec: codec });

		const res = await app.request("/api/globals", {
			headers: {
				Authorization: `Basic ${Buffer.from("admin:s3cret", "utf8").toString("base64")}`,
			},
		});
		expect(res.status).toBe(401);

		await runtime.dispose();
	});

	it("auth NOT configured: /api/globals is open (local dev / bare)", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, {});

		const res = await app.request("/api/globals");
		expect(res.status).toBe(200);

		await runtime.dispose();
	});

	it("desktop token configured: /api/* requires the launcher token but /api/health stays probeable", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, { desktopToken: "desktop-secret" });

		const health = await app.request("/api/health");
		expect(health.status).toBe(200);

		const sessionMissing = await app.request("/api/session");
		expect(sessionMissing.status).toBe(401);

		const session = await app.request("/api/session", {
			headers: { "x-bn-desktop-token": "desktop-secret" },
		});
		expect(session.status).toBe(200);
		expect(await session.json()).toEqual({ authRequired: false, authed: true });

		const globalsWrong = await app.request("/api/globals", {
			headers: { "x-bn-desktop-token": "wrong" },
		});
		expect(globalsWrong.status).toBe(401);

		const globals = await app.request("/api/globals", {
			headers: { "x-bn-desktop-token": "desktop-secret" },
		});
		expect(globals.status).toBe(200);

		await runtime.dispose();
	});

	it("auth configured: /api/health is also gated by the cookie", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, { basicAuthCredentials: CREDS, sessionCodec: codec });

		const noAuth = await app.request("/api/health");
		expect(noAuth.status).toBe(401);

		const withCookie = await app.request("/api/health", {
			headers: { Cookie: `bn_session=${codec.sign()}` },
		});
		expect(withCookie.status).toBe(200);

		await runtime.dispose();
	});

	it("login → returned cookie unlocks /api/globals end-to-end", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, { basicAuthCredentials: CREDS, sessionCodec: codec });

		const login = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(CREDS),
		});
		expect(login.status).toBe(200);
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		expect(cookie).toMatch(/^bn_session=/);

		const res = await app.request("/api/globals", { headers: { Cookie: cookie } });
		expect(res.status).toBe(200);

		await runtime.dispose();
	});

	it("exemption is exact: /api/sessionXYZ-style prefixes are NOT exempt (gated)", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, { basicAuthCredentials: CREDS, sessionCodec: codec });

		for (const p of ["/api/sessionXYZ", "/api/session-foo", "/api/sessionsecret"]) {
			const res = await app.request(p);
			expect(res.status, p).toBe(401);
		}

		await runtime.dispose();
	});

	it("/api/auth/ws-ticket stays gated (no cookie → 401)", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, { basicAuthCredentials: CREDS, sessionCodec: codec });

		const res = await app.request("/api/auth/ws-ticket", { method: "POST" });
		expect(res.status).toBe(401);

		await runtime.dispose();
	});

	it("sliding renewal: past-half-life cookie → 200 + fresh Set-Cookie; fresh → none", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const ttlMs = 10_000;
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS, ttlMs });
		const app = createApp(runtime, { basicAuthCredentials: CREDS, sessionCodec: codec });

		// Issued ~60% of the TTL ago → still valid, but past half-life.
		const aged = codec.sign(Date.now() - ttlMs * 0.6);
		const slid = await app.request("/api/globals", {
			headers: { Cookie: `bn_session=${aged}` },
		});
		expect(slid.status).toBe(200);
		expect(slid.headers.get("set-cookie") ?? "").toContain("bn_session=");

		const fresh = await app.request("/api/globals", {
			headers: { Cookie: `bn_session=${codec.sign()}` },
		});
		expect(fresh.status).toBe(200);
		expect(fresh.headers.get("set-cookie")).toBeNull();

		await runtime.dispose();
	});

	it("createApp fail-closed: exactly one of creds/codec set → throws", async () => {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });

		expect(() => createApp(runtime, { basicAuthCredentials: CREDS })).toThrow();
		expect(() => createApp(runtime, { sessionCodec: codec })).toThrow();

		await runtime.dispose();
	});
});
