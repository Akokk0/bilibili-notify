import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import { createSessionCodec } from "../auth/session.js";
import { settingsSegment } from "../bilibili/settings.js";
import type { BootstrapConfig } from "../config/schema.js";
import { i18n } from "../i18n/index.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

// ---------------------------------------------------------------------------
// Dashboard auth — cookie-session model (replaces the old HTTP Basic gate).
// Q4: cookie-only, no Basic, 401 without WWW-Authenticate.
// ---------------------------------------------------------------------------

const KEY = Buffer.from("test-key-material-32-bytes-long!!", "utf8");
const CREDS = { username: "admin", password: "s3cret" };
beforeEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

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
	it.each([
		["en", "Sign in to the dashboard first.", "A desktop launcher access token is required."],
		[
			"ja",
			"先にダッシュボードにログインしてください。",
			"デスクトップランチャーのアクセストークンが必要です。",
		],
		["zh-TW", "請先登入面板。", "需要桌面啟動器的存取權杖。"],
	] as const)(
		"%s localizes both authentication gates without exposing secrets or rejecting valid credentials",
		async (locale, cookieMessage, tokenMessage) => {
			const runtime = createAppRuntime(
				makeBootstrap(dataDir),
				{ dataRoot: dataDir },
				{ integrationSettings: [settingsSegment] },
			);
			await runtime.configStore.load();
			try {
				const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
				const shared = { cardSkins: { store: createCardSkinStore(runtime.dataRoot) } };
				const app = createApp(runtime, {
					...shared,
					basicAuthCredentials: CREDS,
					sessionCodec: codec,
				});
				const desktop = createApp(runtime, { ...shared, desktopToken: "Original desktop secret" });
				i18n.set({ locale, voice: "plain" });
				const denied = await app.request("/api/settings");
				expect(denied.status).toBe(401);
				expect(denied.headers.get("www-authenticate")).toBeNull();
				expect(await denied.json()).toEqual({ code: "unauthorized", message: cookieMessage });
				const rejectedHeaders: Record<string, string>[] = [
					{},
					{ "x-bn-desktop-token": "Wrong token" },
				];
				for (const headers of rejectedHeaders) {
					const res = await desktop.request("/api/settings", { headers });
					expect(res.status).toBe(401);
					expect(res.headers.get("set-cookie")).toBeNull();
					expect(await res.json()).toEqual({ code: "unauthorized", message: tokenMessage });
				}
				expect(
					(
						await app.request("/api/settings", {
							headers: { cookie: `bn_session=${codec.sign()}` },
						})
					).status,
				).toBe(200);
				expect(
					(
						await desktop.request("/api/settings", {
							headers: { "x-bn-desktop-token": "Original desktop secret" },
						})
					).status,
				).toBe(200);
			} finally {
				await runtime.dispose();
			}
		},
	);

	it.each([
		"/api/settings/invalid",
		"/api/ext/not-installed/settings/invalid",
		"/api/system/backup/preview",
	])("invalid settings readers share cookie and desktop auth: %s", async (path) => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		try {
			const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
			const shared = { cardSkins: { store: createCardSkinStore(runtime.dataRoot) } };
			const app = createApp(runtime, {
				...shared,
				basicAuthCredentials: CREDS,
				sessionCodec: codec,
			});
			expect((await app.request(path)).status).toBe(401);
			expect(
				(await app.request(path, { headers: { Cookie: `bn_session=${codec.sign()}` } })).status,
			).not.toBe(401);
			const desktop = createApp(runtime, { ...shared, desktopToken: "desktop-secret" });
			expect((await desktop.request(path)).status).toBe(401);
			expect(
				(await desktop.request(path, { headers: { "x-bn-desktop-token": "desktop-secret" } }))
					.status,
			).not.toBe(401);
		} finally {
			await runtime.dispose();
		}
	});

	it("auth configured: no cookie → 401 without WWW-Authenticate", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			basicAuthCredentials: CREDS,
			sessionCodec: codec,
		});

		const res = await app.request("/api/settings");
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBeNull();
		// 错误体平铺 `{ code, message }`;401 是显式给的(`unauthorized` 默认回 403)。
		expect(await res.json()).toEqual({ code: "unauthorized", message: "需要先登录面板" });

		await runtime.dispose();
	});

	it("auth configured: valid bn_session cookie → 200", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			basicAuthCredentials: CREDS,
			sessionCodec: codec,
		});

		const res = await app.request("/api/settings", {
			headers: { Cookie: `bn_session=${codec.sign()}` },
		});
		expect(res.status).toBe(200);

		await runtime.dispose();
	});

	it("auth configured: Authorization: Basic is NOT accepted (cookie-only)", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			basicAuthCredentials: CREDS,
			sessionCodec: codec,
		});

		const res = await app.request("/api/settings", {
			headers: {
				Authorization: `Basic ${Buffer.from("admin:s3cret", "utf8").toString("base64")}`,
			},
		});
		expect(res.status).toBe(401);

		await runtime.dispose();
	});

	it("auth NOT configured: /api/settings is open (local dev / bare)", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
		});

		const res = await app.request("/api/settings");
		expect(res.status).toBe(200);

		await runtime.dispose();
	});

	it("desktop token configured: /api/* requires the launcher token but /api/health stays probeable", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			desktopToken: "desktop-secret",
		});

		const health = await app.request("/api/health");
		expect(health.status).toBe(200);

		const sessionMissing = await app.request("/api/session");
		expect(sessionMissing.status).toBe(401);
		expect(await sessionMissing.json()).toEqual({
			code: "unauthorized",
			message: "缺少桌面壳的访问令牌",
		});

		const session = await app.request("/api/session", {
			headers: { "x-bn-desktop-token": "desktop-secret" },
		});
		expect(session.status).toBe(200);
		expect(await session.json()).toEqual({ authRequired: false, authed: true });

		const globalsWrong = await app.request("/api/settings", {
			headers: { "x-bn-desktop-token": "wrong" },
		});
		expect(globalsWrong.status).toBe(401);

		const globals = await app.request("/api/settings", {
			headers: { "x-bn-desktop-token": "desktop-secret" },
		});
		expect(globals.status).toBe(200);

		await runtime.dispose();
	});

	// 桌面版里 `<img>`、CSS `url()`、`@font-face` 带不了自定义头(ADR-0036 决策 5 下 10-03 的 🔗):
	// 带对令牌头的那一次种下 cookie,之后只带 cookie 也能过;cookie 不对照样 401。
	it("desktop token configured: a valid header plants a cookie that passes the gate on its own", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			desktopToken: "desktop-secret",
		});

		const first = await app.request("/api/settings", {
			headers: { "x-bn-desktop-token": "desktop-secret" },
		});
		expect(first.status).toBe(200);
		const [pair = "", ...attrs] = (first.headers.get("set-cookie") ?? "")
			.split(";")
			.map((part) => part.trim());
		expect(pair).toMatch(/^[a-z_]+=.+/);
		expect(attrs).toEqual(expect.arrayContaining(["Path=/api", "HttpOnly", "SameSite=Strict"]));

		const viaCookie = await app.request("/api/settings", { headers: { cookie: pair } });
		expect(viaCookie.status).toBe(200);
		// 已经带着对的 cookie:不再重种。
		expect(viaCookie.headers.get("set-cookie")).toBeNull();

		const cookieName = pair.slice(0, pair.indexOf("="));
		const wrongCookie = await app.request("/api/settings", {
			headers: { cookie: `${cookieName}=wrong` },
		});
		expect(wrongCookie.status).toBe(401);

		const wrongHeader = await app.request("/api/settings", {
			headers: { "x-bn-desktop-token": "wrong" },
		});
		expect(wrongHeader.status).toBe(401);
		expect(wrongHeader.headers.get("set-cookie")).toBeNull();

		await runtime.dispose();
	});

	it("auth configured: /api/health is also gated by the cookie", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			basicAuthCredentials: CREDS,
			sessionCodec: codec,
		});

		const noAuth = await app.request("/api/health");
		expect(noAuth.status).toBe(401);

		const withCookie = await app.request("/api/health", {
			headers: { Cookie: `bn_session=${codec.sign()}` },
		});
		expect(withCookie.status).toBe(200);

		await runtime.dispose();
	});

	it("login → returned cookie unlocks /api/settings end-to-end", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			basicAuthCredentials: CREDS,
			sessionCodec: codec,
		});

		const login = await app.request("/api/session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(CREDS),
		});
		expect(login.status).toBe(200);
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		expect(cookie).toMatch(/^bn_session=/);

		const res = await app.request("/api/settings", { headers: { Cookie: cookie } });
		expect(res.status).toBe(200);

		await runtime.dispose();
	});

	it("exemption is exact: /api/sessionXYZ-style prefixes are NOT exempt (gated)", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			basicAuthCredentials: CREDS,
			sessionCodec: codec,
		});

		for (const p of ["/api/sessionXYZ", "/api/session-foo", "/api/sessionsecret"]) {
			const res = await app.request(p);
			expect(res.status, p).toBe(401);
		}

		await runtime.dispose();
	});

	it("/api/ws/ticket stays gated (no cookie → 401)", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			basicAuthCredentials: CREDS,
			sessionCodec: codec,
		});

		const res = await app.request("/api/ws/ticket", { method: "POST" });
		expect(res.status).toBe(401);

		await runtime.dispose();
	});

	it("sliding renewal: past-half-life cookie → 200 + fresh Set-Cookie; fresh → none", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const ttlMs = 10_000;
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS, ttlMs });
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			basicAuthCredentials: CREDS,
			sessionCodec: codec,
		});

		// Issued ~60% of the TTL ago → still valid, but past half-life.
		const aged = codec.sign(Date.now() - ttlMs * 0.6);
		const slid = await app.request("/api/settings", {
			headers: { Cookie: `bn_session=${aged}` },
		});
		expect(slid.status).toBe(200);
		expect(slid.headers.get("set-cookie") ?? "").toContain("bn_session=");

		const fresh = await app.request("/api/settings", {
			headers: { Cookie: `bn_session=${codec.sign()}` },
		});
		expect(fresh.status).toBe(200);
		expect(fresh.headers.get("set-cookie")).toBeNull();

		await runtime.dispose();
	});

	it("createApp fail-closed: exactly one of creds/codec set → throws", async () => {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		const codec = createSessionCodec({ keyMaterial: KEY, creds: CREDS });

		expect(() =>
			createApp(runtime, {
				cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
				basicAuthCredentials: CREDS,
			}),
		).toThrow();
		expect(() =>
			createApp(runtime, {
				cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
				sessionCodec: codec,
			}),
		).toThrow();

		await runtime.dispose();
	});
});
