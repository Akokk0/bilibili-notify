import { Buffer } from "node:buffer";
import { fail, ok, type Result } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createDashboardAuth } from "../../auth/dashboard-auth.js";
import { createIpRateLimiter } from "../../auth/ip-rate-limit.js";
import { createSessionCodec, type SessionCreds } from "../../auth/session.js";
import { i18n } from "../../i18n/index.js";
import { createSessionRoute } from "../session.js";

const KEY = Buffer.from("test-key-material-32-bytes-long!!", "utf8");
const CREDS: SessionCreds = { username: "admin", password: "s3cret" };
beforeEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

function makeApp(opts: {
	auth: boolean;
	maxFailures?: number;
	allowedOrigins?: readonly string[];
	changeCredentials?: (creds: SessionCreds) => Promise<Result>;
}) {
	const codec = opts.auth ? createSessionCodec({ keyMaterial: KEY, creds: CREDS }) : undefined;
	const app = new Hono();
	app.route(
		"/api/session",
		createSessionRoute({
			codec,
			rateLimiter: createIpRateLimiter({ maxFailures: opts.maxFailures ?? 5 }),
			allowedOrigins: opts.allowedOrigins,
			...(opts.changeCredentials ? { changeCredentials: opts.changeCredentials } : {}),
		}),
	);
	if (codec) app.use("/api/*", createDashboardAuth(codec));
	app.get("/api/probe", (c) => c.text("ok"));
	return app;
}

/** 非 2xx 的错误体是平铺的 `{ code, message }`(ADR-0026),面板按 `code` 分情况。 */
async function failureOf(res: Response): Promise<{ code: string; message: string }> {
	return (await res.json()) as { code: string; message: string };
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
	it.each([
		[
			"en",
			[
				"Too many failed sign-in attempts. Try again later.",
				"The request body must be JSON.",
				"The request origin is not allowed.",
				"Dashboard sign-in is disabled. Signing in is not required.",
				"Incorrect username or password.",
			],
		],
		[
			"ja",
			[
				"ログインの失敗回数が多すぎます。しばらくしてから再試行してください。",
				"リクエスト本文はJSONで送信してください。",
				"このリクエスト元は許可されていません。",
				"ダッシュボードのログインは無効です。ログインする必要はありません。",
				"ユーザー名またはパスワードが正しくありません。",
			],
		],
		[
			"zh-TW",
			[
				"登入失敗次數過多，請稍後再試。",
				"請求本文必須是 JSON。",
				"不允許此請求來源。",
				"面板未啟用登入，不需要登入。",
				"帳號或密碼錯誤。",
			],
		],
	] as const)(
		"%s localizes sign-in failures without changing origin, throttling or cookie behavior",
		async (locale, text) => {
			const app = makeApp({ auth: true, maxFailures: 1 });
			i18n.set({ locale, voice: "plain" });
			const foreign = makeApp({ auth: true, allowedOrigins: ["https://allowed.test"] });
			const denied = await foreign.request("/api/session/login", {
				method: "POST",
				headers: { origin: "https://foreign.test" },
				body: JSON.stringify(CREDS),
			});
			expect(denied.status).toBe(403);
			expect(await failureOf(denied)).toEqual({ code: "invalid", message: text[2] });
			const disabled = await makeApp({ auth: false }).request("/api/session/login", {
				method: "POST",
			});
			expect(disabled.status).toBe(400);
			expect(await failureOf(disabled)).toEqual({ code: "unsupported", message: text[3] });
			const invalid = await app.request("/api/session/login", { method: "POST", body: "{" });
			expect(invalid.status).toBe(400);
			expect(await failureOf(invalid)).toEqual({ code: "invalid", message: text[1] });
			const wrong = await app.request("/api/session/login", {
				method: "POST",
				body: JSON.stringify({ ...CREDS, password: "wrong" }),
			});
			expect(wrong.status).toBe(401);
			expect(wrong.headers.get("set-cookie")).toBeNull();
			expect(await failureOf(wrong)).toEqual({ code: "unauthorized", message: text[4] });
			const blocked = await app.request("/api/session/login", {
				method: "POST",
				body: JSON.stringify(CREDS),
			});
			expect(blocked.status).toBe(429);
			expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
			expect(await failureOf(blocked)).toEqual({ code: "rate_limited", message: text[0] });
			const fresh = makeApp({ auth: true });
			const success = await fresh.request("/api/session/login", {
				method: "POST",
				body: JSON.stringify(CREDS),
			});
			expect(success.status).toBe(200);
			expect(await success.json()).toEqual({ ok: true });
			expect(
				(await fresh.request("/api/probe", { headers: { cookie: cookieFrom(success) } })).status,
			).toBe(200);
		},
	);
	it("valid credentials → 200 + Set-Cookie, gate then accepts the cookie", async () => {
		const app = makeApp({ auth: true });
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(CREDS),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		const cookie = cookieFrom(res);
		expect(cookie).toMatch(/^bn_session=/);

		const gated = await app.request("/api/probe", { headers: { Cookie: cookie } });
		expect(gated.status).toBe(200);
		expect(await gated.text()).toBe("ok");
	});

	it("wrong password → 401 unauthorized(显式 401:/api/session/* 不触发面板的会话过期钩子)", async () => {
		const app = makeApp({ auth: true });
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "admin", password: "nope" }),
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBeNull();
		expect(await failureOf(res)).toEqual({ code: "unauthorized", message: "账号或密码错误" });
	});

	it("bad body → 400 invalid", async () => {
		const app = makeApp({ auth: true });
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
		expect((await failureOf(res)).code).toBe("invalid");
	});

	it("auth disabled → 400 unsupported(面板据此关掉登录框)", async () => {
		const app = makeApp({ auth: false });
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(CREDS),
		});
		expect(res.status).toBe(400);
		expect((await failureOf(res)).code).toBe("unsupported");
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
		expect((await failureOf(blocked)).code).toBe("rate_limited");
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

	it("configured + disallowed Origin → 403 invalid before rate-limit / creds", async () => {
		const app = makeApp({ auth: true, allowedOrigins: ALLOW });
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: "https://evil.example.org" },
			body: JSON.stringify(CREDS),
		});
		expect(res.status).toBe(403);
		expect(await failureOf(res)).toEqual({ code: "invalid", message: "请求来源不被允许" });
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
		expect((await failureOf(denied)).code).toBe("invalid");
		// Whitelisted origin → falls through to the inert 400.
		const inert = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: ALLOW[0] as string },
			body: JSON.stringify(CREDS),
		});
		expect(inert.status).toBe(400);
		expect((await failureOf(inert)).code).toBe("unsupported");
	});
});

describe("dashboard-auth gate", () => {
	it("no cookie → 401 without WWW-Authenticate; Basic header is NOT accepted", async () => {
		const app = makeApp({ auth: true });
		const noCookie = await app.request("/api/probe");
		expect(noCookie.status).toBe(401);
		expect(noCookie.headers.get("www-authenticate")).toBeNull();
		// 显式 401(`unauthorized` 默认回 403):面板见 401 才回登录框,只有看板自己的会话失效才回它。
		expect(await failureOf(noCookie)).toEqual({ code: "unauthorized", message: "需要先登录面板" });

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

describe("session route — PUT /api/session/credentials(面板改账号密码)", () => {
	const NEW = { username: "owner", password: "n3w-secret" };

	async function login(app: Hono, creds: SessionCreds = CREDS): Promise<string> {
		const res = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(creds),
		});
		expect(res.status).toBe(200);
		return cookieFrom(res);
	}

	function change(app: Hono, cookie: string | undefined, body: unknown) {
		return app.request("/api/session/credentials", {
			method: "PUT",
			headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
			body: JSON.stringify(body),
		});
	}

	it.each([
		[
			"en",
			[
				"This deployment cannot change dashboard credentials because sign-in is disabled or credentials are not managed by a configuration file.",
				"Sign in before changing your credentials.",
				"The current password is incorrect.",
				"The username must contain 1 to 256 characters.",
				"The new password must contain 8 to 256 characters.",
			],
		],
		[
			"ja",
			[
				"この環境ではダッシュボードの認証情報を変更できません。ログインが無効か、認証情報が設定ファイルで管理されていません。",
				"認証情報を変更する前にログインしてください。",
				"現在のパスワードが正しくありません。",
				"ユーザー名は1～256文字で指定してください。",
				"新しいパスワードは8～256文字で指定してください。",
			],
		],
		[
			"zh-TW",
			[
				"此部署無法修改面板帳號密碼，可能未啟用登入，或帳號不由設定檔管理。",
				"請先登入，再修改帳號密碼。",
				"目前密碼錯誤。",
				"帳號不可為空，最多 256 個字元。",
				"新密碼必須為 8 至 256 個字元。",
			],
		],
	] as const)(
		"%s explains credential rejection without writing or rotating the session",
		async (locale, text) => {
			const write = vi.fn(async (_creds: SessionCreds) => ok());
			const app = makeApp({ auth: true, changeCredentials: write });
			const cookie = await login(app);
			i18n.set({ locale, voice: "plain" });
			const unsupported = await change(makeApp({ auth: true }), cookie, {});
			expect(unsupported.status).toBe(400);
			expect(await failureOf(unsupported)).toEqual({ code: "unsupported", message: text[0] });
			const unauthenticated = await change(app, undefined, {});
			expect(unauthenticated.status).toBe(401);
			expect(await failureOf(unauthenticated)).toEqual({ code: "unauthorized", message: text[1] });
			const wrong = await change(app, cookie, { currentPassword: "wrong", ...NEW });
			expect(wrong.status).toBe(401);
			expect(await failureOf(wrong)).toEqual({ code: "unauthorized", message: text[2] });
			for (const username of ["", "x".repeat(257)]) {
				const res = await change(app, cookie, {
					currentPassword: CREDS.password,
					...NEW,
					username,
				});
				expect(res.status).toBe(400);
				expect(await failureOf(res)).toEqual({ code: "invalid", message: text[3] });
			}
			for (const password of ["x".repeat(7), "x".repeat(257)]) {
				const res = await change(app, cookie, {
					currentPassword: CREDS.password,
					...NEW,
					password,
				});
				expect(res.status).toBe(400);
				expect(await failureOf(res)).toEqual({ code: "invalid", message: text[4] });
			}
			expect(write).not.toHaveBeenCalled();
			expect((await app.request("/api/probe", { headers: { cookie } })).status).toBe(200);
			const changed = await change(app, cookie, { currentPassword: CREDS.password, ...NEW });
			expect(changed.status).toBe(200);
			expect(await changed.json()).toEqual({ ok: true });
			expect(write).toHaveBeenCalledExactlyOnceWith(NEW);
			expect(changed.headers.get("set-cookie")).toContain("Max-Age=0");
			expect((await app.request("/api/probe", { headers: { cookie } })).status).toBe(401);
			expect(await login(app, NEW)).toMatch(/^bn_session=/);
		},
	);
	it("登录着、当前密码对 → 写回、清 cookie;旧会话当场失效,新账号登得进", async () => {
		const written: SessionCreds[] = [];
		const app = makeApp({
			auth: true,
			changeCredentials: async (creds) => {
				written.push(creds);
				return ok();
			},
		});
		const cookie = await login(app);

		const res = await change(app, cookie, { currentPassword: "s3cret", ...NEW });
		expect(res.status, await res.clone().text()).toBe(200);
		expect(written).toEqual([NEW]);
		expect(res.headers.get("set-cookie")).toContain("Max-Age=0");

		expect((await app.request("/api/probe", { headers: { Cookie: cookie } })).status).toBe(401);
		const fresh = await login(app, NEW);
		expect((await app.request("/api/probe", { headers: { Cookie: fresh } })).status).toBe(200);
	});

	it("没登录 → 401,不写", async () => {
		const write = vi.fn(async () => ok());
		const app = makeApp({ auth: true, changeCredentials: write });
		const res = await change(app, undefined, { currentPassword: "s3cret", ...NEW });
		expect(res.status).toBe(401);
		expect(write).not.toHaveBeenCalled();
	});

	it("当前密码不对 → 401,不写,原来的会话照用", async () => {
		const write = vi.fn(async () => ok());
		const app = makeApp({ auth: true, changeCredentials: write });
		const cookie = await login(app);
		const res = await change(app, cookie, { currentPassword: "nope", ...NEW });
		expect(res.status).toBe(401);
		expect(write).not.toHaveBeenCalled();
		expect((await app.request("/api/probe", { headers: { Cookie: cookie } })).status).toBe(200);
	});

	it.each([
		["账号是空的", { username: "  ", password: "n3w-secret" }],
		["密码不到 8 位", { username: "owner", password: "short" }],
	])("%s → 400 invalid,不写", async (_label, next) => {
		const write = vi.fn(async () => ok());
		const app = makeApp({ auth: true, changeCredentials: write });
		const cookie = await login(app);
		const res = await change(app, cookie, { currentPassword: "s3cret", ...next });
		expect(res.status).toBe(400);
		expect((await failureOf(res)).code).toBe("invalid");
		expect(write).not.toHaveBeenCalled();
	});

	it("写不了(旧式部署的环境变量、没有配置文件)→ 原样回那条失败,凭据不换", async () => {
		const app = makeApp({
			auth: true,
			changeCredentials: async () => fail("not_configured", "环境变量每次开机都会盖掉"),
		});
		const cookie = await login(app);
		const res = await change(app, cookie, { currentPassword: "s3cret", ...NEW });
		expect(await failureOf(res)).toEqual({
			code: "not_configured",
			message: "环境变量每次开机都会盖掉",
		});
		expect((await app.request("/api/probe", { headers: { Cookie: cookie } })).status).toBe(200);
	});

	it("面板没开登录、或这个部署没接写口 → unsupported", async () => {
		const noAuth = makeApp({ auth: false });
		expect((await failureOf(await change(noAuth, undefined, {}))).code).toBe("unsupported");
		const noWriter = makeApp({ auth: true });
		const cookie = await login(noWriter);
		const res = await change(noWriter, cookie, { currentPassword: "s3cret", ...NEW });
		expect((await failureOf(res)).code).toBe("unsupported");
	});
});
