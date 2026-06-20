import { Buffer } from "node:buffer";
import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { createDashboardAuth } from "../../auth/dashboard-auth.js";
import { createIpRateLimiter } from "../../auth/ip-rate-limit.js";
import { createSessionCodec, type SessionCreds } from "../../auth/session.js";
import { createSessionRoute } from "../session.js";

const KEY = Buffer.from("test-key-material-32-bytes-long!!", "utf8");
const CREDS: SessionCreds = { username: "admin", password: "s3cret" };

function makeApp(opts: {
	auth: boolean;
	maxFailures?: number;
	allowedOrigins?: readonly string[];
}) {
	const codec = opts.auth ? createSessionCodec({ keyMaterial: KEY, creds: CREDS }) : undefined;
	const app = new Hono();
	app.route(
		"/api/session",
		createSessionRoute({
			creds: opts.auth ? CREDS : undefined,
			codec,
			rateLimiter: createIpRateLimiter({ maxFailures: opts.maxFailures ?? 5 }),
			allowedOrigins: opts.allowedOrigins,
		}),
	);
	if (codec) app.use("/api/*", createDashboardAuth(codec));
	app.get("/api/probe", (c) => c.text("ok"));
	return app;
}

function cookieFrom(res: Response): string {
	const setCookie = res.headers.get("set-cookie") ?? "";
	return setCookie.split(";")[0] ?? "";
}

describe("session route — GET /api/session", () => {
	it("auth disabled → authRequired:false, authed:true", async () => {
		const app = makeApp({ auth: false });
		const res = await app.request("/api/session");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ authRequired: false, authed: true });
	});

	it("auth enabled, no cookie → authRequired:true, authed:false", async () => {
		const app = makeApp({ auth: true });
		const res = await app.request("/api/session");
		expect(await res.json()).toEqual({ authRequired: true, authed: false });
	});

	it("auth enabled, valid cookie → authed:true", async () => {
		const app = makeApp({ auth: true });
		const login = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(CREDS),
		});
		const res = await app.request("/api/session", {
			headers: { Cookie: cookieFrom(login) },
		});
		expect(await res.json()).toEqual({ authRequired: true, authed: true });
	});
});

describe("session route — POST /api/session/login", () => {
	it("valid credentials → 200 + Set-Cookie, gate then accepts the cookie", async () => {
		const app = makeApp({ auth: true });
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(CREDS),
		});
		expect(res.status).toBe(200);
		const cookie = cookieFrom(res);
		expect(cookie).toMatch(/^bn_session=/);

		const gated = await app.request("/api/probe", { headers: { Cookie: cookie } });
		expect(gated.status).toBe(200);
		expect(await gated.text()).toBe("ok");
	});

	it("wrong password → 401", async () => {
		const app = makeApp({ auth: true });
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "admin", password: "nope" }),
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBeNull();
	});

	it("bad body → 400", async () => {
		const app = makeApp({ auth: true });
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	it("auth disabled → 400 auth_not_required", async () => {
		const app = makeApp({ auth: false });
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(CREDS),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("auth_not_required");
	});

	it("rate-limit: blocked after maxFailures with Retry-After, correct creds still 429", async () => {
		const app = makeApp({ auth: true, maxFailures: 3 });
		for (let i = 0; i < 3; i++) {
			const r = await app.request("/api/session/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "admin", password: "wrong" }),
			});
			expect(r.status).toBe(401);
		}
		const blocked = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(CREDS),
		});
		expect(blocked.status).toBe(429);
		expect(blocked.headers.get("Retry-After")).toBeTruthy();
	});
});

describe("session route — POST /api/session/logout", () => {
	it("clears the cookie and is idempotent", async () => {
		const app = makeApp({ auth: true });
		const res = await app.request("/api/session/logout", { method: "POST" });
		expect(res.status).toBe(200);
		const setCookie = res.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("bn_session=");
		expect(setCookie).toContain("Max-Age=0");
		// Idempotent: a second call with no cookie still 200s.
		const again = await app.request("/api/session/logout", { method: "POST" });
		expect(again.status).toBe(200);
	});

	it("auth disabled → 200 no-op (no Set-Cookie)", async () => {
		const app = makeApp({ auth: false });
		const res = await app.request("/api/session/logout", { method: "POST" });
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toBeNull();
	});
});

describe("session route — Origin gate (F3, defence-in-depth)", () => {
	const ALLOW = ["https://dash.example.com"];

	it("no allow-list configured → Origin ignored (login still works from any/no Origin)", async () => {
		const app = makeApp({ auth: true });
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: "https://evil.example.org" },
			body: JSON.stringify(CREDS),
		});
		expect(res.status).toBe(200);
	});

	it("configured + disallowed Origin → 403 before rate-limit / creds", async () => {
		const app = makeApp({ auth: true, allowedOrigins: ALLOW });
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: "https://evil.example.org" },
			body: JSON.stringify(CREDS),
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("forbidden_origin");
	});

	it("configured + missing Origin → 403 (non-browser automation unsupported with gate)", async () => {
		const app = makeApp({ auth: true, allowedOrigins: ALLOW });
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(CREDS),
		});
		expect(res.status).toBe(403);
	});

	it("configured + whitelisted Origin → proceeds normally (200 + cookie)", async () => {
		const app = makeApp({ auth: true, allowedOrigins: ALLOW });
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ALLOW[0] as string },
			body: JSON.stringify(CREDS),
		});
		expect(res.status).toBe(200);
		expect(cookieFrom(res)).toMatch(/^bn_session=/);
	});

	it("logout: disallowed Origin → 403 + no cookie cleared (forced-logout CSRF blocked)", async () => {
		const app = makeApp({ auth: true, allowedOrigins: ALLOW });
		const res = await app.request("/api/session/logout", {
			method: "POST",
			headers: { Origin: "https://evil.example.org" },
		});
		expect(res.status).toBe(403);
		expect(res.headers.get("set-cookie")).toBeNull();
	});

	it("logout: whitelisted Origin → 200 clears the cookie", async () => {
		const app = makeApp({ auth: true, allowedOrigins: ALLOW });
		const res = await app.request("/api/session/logout", {
			method: "POST",
			headers: { Origin: ALLOW[0] as string },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
	});

	it("disallowed-Origin flood does NOT consume the rate-limit bucket (403 is pre-bucket)", async () => {
		// maxFailures=1: if the Origin-rejected requests touched fail(), the very
		// next legit request would already be 429. They must not.
		const app = makeApp({ auth: true, maxFailures: 1, allowedOrigins: ALLOW });
		for (let i = 0; i < 10; i++) {
			const r = await app.request("/api/session/login", {
				method: "POST",
				headers: { "content-type": "application/json", Origin: "https://evil.example.org" },
				body: JSON.stringify({ username: "admin", password: "wrong" }),
			});
			expect(r.status).toBe(403);
		}
		// Bucket untouched → a correctly-originated valid login still succeeds.
		const ok = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ALLOW[0] as string },
			body: JSON.stringify(CREDS),
		});
		expect(ok.status).toBe(200);
		expect(cookieFrom(ok)).toMatch(/^bn_session=/);
	});

	it("Origin match is case-insensitive on the HEADER NAME (uppercase `ORIGIN` still gated)", async () => {
		const app = makeApp({ auth: true, allowedOrigins: ALLOW });
		// Allowed origin sent under an upper-cased header name → must still pass
		// (Hono header lookup is case-insensitive; gate must not be bypassable
		// nor falsely-tripped by header casing).
		const pass = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json", ORIGIN: ALLOW[0] as string },
			body: JSON.stringify(CREDS),
		});
		expect(pass.status).toBe(200);
		// Disallowed origin under upper-cased header name → still 403.
		const fail = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json", ORIGIN: "https://evil.example.org" },
			body: JSON.stringify(CREDS),
		});
		expect(fail.status).toBe(403);
	});

	it("GET /api/session is deliberately NOT Origin-gated (SPA boot probe must work cross-origin)", async () => {
		const app = makeApp({ auth: true, allowedOrigins: ALLOW });
		const res = await app.request("/api/session", {
			headers: { Origin: "https://evil.example.org" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ authRequired: true, authed: false });
	});

	it("no allow-list configured → logout ignores an arbitrary Origin (legacy behaviour preserved)", async () => {
		const app = makeApp({ auth: true });
		const res = await app.request("/api/session/logout", {
			method: "POST",
			headers: { Origin: "https://evil.example.org" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
	});

	it("auth disabled + Origin gate configured: /login still 403s a bad Origin BEFORE the auth_not_required 400", async () => {
		// Locks the ordering: Origin gate is the very first thing, even when the
		// feature is otherwise inert (creds undefined). A cross-site caller must
		// not even learn whether auth is configured.
		const app = makeApp({ auth: false, allowedOrigins: ALLOW });
		const denied = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: "https://evil.example.org" },
			body: JSON.stringify(CREDS),
		});
		expect(denied.status).toBe(403);
		// Whitelisted origin → falls through to the inert 400.
		const inert = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ALLOW[0] as string },
			body: JSON.stringify(CREDS),
		});
		expect(inert.status).toBe(400);
		expect(((await inert.json()) as { error: string }).error).toBe("auth_not_required");
	});
});

describe("dashboard-auth gate", () => {
	it("no cookie → 401 without WWW-Authenticate; Basic header is NOT accepted", async () => {
		const app = makeApp({ auth: true });
		const noCookie = await app.request("/api/probe");
		expect(noCookie.status).toBe(401);
		expect(noCookie.headers.get("www-authenticate")).toBeNull();

		const basic = await app.request("/api/probe", {
			headers: {
				Authorization: `Basic ${Buffer.from("admin:s3cret", "utf8").toString("base64")}`,
			},
		});
		expect(basic.status).toBe(401);
	});

	it("auth disabled → gate is absent, probe is open", async () => {
		const app = makeApp({ auth: false });
		const res = await app.request("/api/probe");
		expect(res.status).toBe(200);
	});
});
