import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountsResponse } from "@bilibili-notify/contract";
import { type AuthState, ok, type SourceAuth } from "@bilibili-notify/internal";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import { createSessionCodec } from "../auth/session.js";
import { createBackupService } from "../backup/service.js";
import { CORE_SETTINGS_FILE } from "../config/store.js";
import { createExtensionMounts } from "../extensions/mount.js";
import { type AppRuntime, createAppRuntime } from "../runtime/bootstrap.js";
import { makeIntegration } from "../subscriptions/__tests__/fixtures.js";
import { fakeIntegrationSecrets } from "./support/backup-integration-secrets.js";
import { noCandidates, noProfile } from "./support/no-candidates.js";

let dataDir: string;
let runtime: AppRuntime;
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-accounts-"));
	runtime = createAppRuntime(
		{ server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" },
		{ dataRoot: dataDir },
		{ integrationSettings: [] },
	);
	await runtime.configStore.load();
});
afterEach(async () => {
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

function appOf() {
	return createApp(runtime, { cardSkins: { store: createCardSkinStore(dataDir) } });
}
async function register(sourceKey: string, auth?: SourceAuth) {
	return runtime.sourceRegistry.register(
		sourceKey,
		{
			descriptor: { label: sourceKey, supportedFeatures: ["post"] },
			searchCreators: noCandidates,
			fetchProfile: noProfile,
			start: async () => {},
			stop: async () => {},
			...(auth ? { auth } : {}),
		},
		makeIntegration() as never,
	);
}
function authOf(): SourceAuth {
	return {
		state: () => ({ status: "logged-in", loggedInAt: "2026-10-30T00:00:00.000Z" }),
		account: () => ({ name: "Account", avatar: `${"a".repeat(64)}.png`, token: "secret" }),
		beginLogin: async () => ok(),
		logout: async () => ok(),
		onChange: () => ({ dispose() {} }),
	};
}

it("accounts lists login sources in registration order and picks only public account fields", async () => {
	await register("acme.first", authOf());
	await register("acme.noauth");
	const second = authOf();
	second.state = () => ({ status: "logged-out" });
	second.account = () => null;
	await register("acme.second", second);
	const res = await appOf().request("/api/accounts");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({
		accounts: [
			{
				sourceKey: "acme.first",
				state: { status: "logged-in", loggedInAt: "2026-10-30T00:00:00.000Z" },
				account: { name: "Account", avatar: `${"a".repeat(64)}.png` },
			},
			{ sourceKey: "acme.second", state: { status: "logged-out" } },
		],
	});
});

it("saved order skips unknown and duplicate keys, appends omissions and survives restart", async () => {
	await register("acme.first", authOf());
	await register("acme.second", authOf());
	await register("acme.third", authOf());
	const app = appOf();
	const order = ["acme.missing", "acme.second", "acme.second"];
	const saved = await app.request("/api/settings", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ core: { accounts: { order } } }),
	});
	expect(saved.status).toBe(200);
	const keys = async () =>
		(
			(await (await app.request("/api/accounts")).json()) as {
				accounts: { sourceKey: string }[];
			}
		).accounts.map((one) => one.sourceKey);
	expect(await keys()).toEqual(["acme.second", "acme.first", "acme.third"]);
	await runtime.dispose();
	runtime = createAppRuntime(
		{ server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" },
		{ dataRoot: dataDir },
		{ integrationSettings: [] },
	);
	await runtime.configStore.load();
	expect(runtime.configStore.getGlobals()).toMatchObject({ accounts: { order } });
});

it("a throwing source makes the entire read unavailable without exposing its exception", async () => {
	await register("acme.good", authOf());
	const broken = authOf();
	broken.account = () => {
		throw new Error("private-token");
	};
	await register("acme.broken", broken);
	const res = await appOf().request("/api/accounts");
	expect(res.status).toBe(503);
	expect(await res.json()).toEqual({
		code: "unavailable",
		message: "主人，读账号状态出错了，请看看日志。",
	});
});

const patchOrder = (app: ReturnType<typeof appOf>, accounts: unknown) =>
	app.request("/api/settings", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ core: { accounts } }),
	});
const readCore = async () =>
	JSON.parse(await readFile(join(dataDir, ...CORE_SETTINGS_FILE), "utf8"));

it("missing defaults stay absent on disk; deleting order or accounts restores registration order", async () => {
	const app = appOf();
	expect(await readCore()).not.toHaveProperty("accounts");
	await runtime.configStore.patchGlobals({ mutedUntil: 42 });
	expect(await readCore()).not.toHaveProperty("accounts");
	await register("acme.first", authOf());
	await register("acme.second", authOf());
	for (const reset of [{ order: null }, { order: [] }, null]) {
		expect((await patchOrder(app, { order: ["acme.second"] })).status).toBe(200);
		expect((await patchOrder(app, reset)).status).toBe(200);
		const body = (await (await app.request("/api/accounts")).json()) as AccountsResponse;
		expect(body.accounts.map((one: { sourceKey: string }) => one.sourceKey)).toEqual([
			"acme.first",
			"acme.second",
		]);
	}
	expect(await readCore()).not.toHaveProperty("accounts");
});

it.each(["", 7, null])(
	"invalid order entry %s is rejected without changing stored order",
	async (entry) => {
		const app = appOf();
		await patchOrder(app, { order: ["acme.first"] });
		const before = await readFile(join(dataDir, ...CORE_SETTINGS_FILE), "utf8");
		const res = await patchOrder(app, { order: [entry] });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			issues: [expect.objectContaining({ path: ["core", "accounts", "order", 0] })],
		});
		expect(await readFile(join(dataDir, ...CORE_SETTINGS_FILE), "utf8")).toBe(before);
	},
);

it("bad accounts settings are isolated on restart and their original bytes are preserved on unrelated writes", async () => {
	const raw = await readCore();
	raw.accounts = { order: [9] };
	await writeFile(join(dataDir, ...CORE_SETTINGS_FILE), JSON.stringify(raw));
	await runtime.dispose();
	runtime = createAppRuntime(
		{ server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" },
		{ dataRoot: dataDir },
		{ integrationSettings: [] },
	);
	await runtime.configStore.load();
	expect(runtime.configStore.getGlobals().accounts).toBeUndefined();
	expect(runtime.configStore.getInvalidSettings()).toEqual(
		expect.arrayContaining([expect.objectContaining({ path: ["accounts"] })]),
	);
	await runtime.configStore.patchGlobals({ mutedUntil: 55 });
	expect((await readCore()).accounts).toEqual({ order: [9] });
});

it("account order round trips through both backup kinds and overwrite restore", async () => {
	const svc = createBackupService({
		configStore: runtime.configStore,
		integrationSecrets: fakeIntegrationSecrets(),
	});
	const order = ["acme.second", "acme.unknown", "acme.second"];
	for (const kind of ["sanitized", "full"] as const) {
		await patchOrder(appOf(), { order });
		const envelope = await svc.exportBackup({
			kind,
			pin: "123456",
			sections: { globals: true, subscriptions: false, connections: false, targets: false },
		});
		await patchOrder(appOf(), null);
		await svc.importBackup({ envelope, pin: "123456", mode: "overwrite" });
		expect(runtime.configStore.getGlobals()).toMatchObject({ accounts: { order } });
		expect((await readCore()).accounts).toEqual({ order });
	}
});

it.each<AuthState>([
	{ status: "logged-out" },
	{
		status: "awaiting-scan",
		qr: { dataUrl: "data:image/png;base64,QQ", expiresAt: "2026-10-30T01:00:00.000Z" },
	},
	{ status: "confirming", message: "Confirm" },
	{ status: "expired", message: "Expired" },
	{ status: "error", message: "Failed" },
	{ status: "logged-in", loggedInAt: "2026-10-30T00:00:00.000Z" },
])(
	"reads fresh state $status without synthesizing an account and removes withdrawn sources",
	async (state) => {
		const auth = authOf();
		delete auth.account;
		const handle = await register("acme.first", auth);
		const app = appOf();
		await app.request("/api/accounts");
		auth.state = () => state;
		expect(await (await app.request("/api/accounts")).json()).toEqual({
			accounts: [{ sourceKey: "acme.first", state }],
		});
		await handle.dispose();
		expect(await (await app.request("/api/accounts")).json()).toEqual({ accounts: [] });
	},
);

it("avatar changes are read fresh and a returning source retains its saved position", async () => {
	await patchOrder(appOf(), { order: ["acme.second"] });
	const auth = authOf();
	const first = await register("acme.second", auth);
	await register("acme.first", authOf());
	await first.dispose();
	auth.account = () => ({ name: "New", avatar: `${"b".repeat(64)}.webp` });
	await register("acme.second", auth);
	const res = (await (await appOf().request("/api/accounts")).json()) as AccountsResponse;
	expect(res.accounts[0]).toMatchObject({
		sourceKey: "acme.second",
		account: { name: "New", avatar: `${"b".repeat(64)}.webp` },
	});
});

it("both read and settings write require the configured session or desktop token", async () => {
	const creds = { username: "admin", password: "password" };
	const codec = createSessionCodec({ keyMaterial: Buffer.from("a".repeat(32)), creds });
	for (const options of [
		{ basicAuthCredentials: creds, sessionCodec: codec },
		{ desktopToken: "desktop-secret" },
	]) {
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(dataDir) },
			...options,
		});
		expect((await app.request("/api/accounts")).status).toBe(401);
		expect((await patchOrder(app, { order: [] })).status).toBe(401);
		const headers =
			"desktopToken" in options
				? { "x-bn-desktop-token": "desktop-secret" }
				: { Cookie: `bn_session=${codec.sign()}` };
		expect((await app.request("/api/accounts", { headers })).status).toBe(200);
		expect(
			(
				await app.request("/api/settings", {
					method: "PATCH",
					headers: { ...headers, "Content-Type": "application/json" },
					body: JSON.stringify({ core: { accounts: { order: [] } } }),
				})
			).status,
		).toBe(200);
	}
});

it("waits for loader settle before listing registered login sources", async () => {
	const mounts = createExtensionMounts({ logger: runtime.serviceCtx.logger });
	const app = createApp(runtime, {
		cardSkins: { store: createCardSkinStore(dataDir) },
		extensions: {
			mounts,
			loaded: () => [],
			status: () => undefined,
			settle: async () => {
				await register("acme.settled", authOf());
			},
		},
	});
	const body = (await (await app.request("/api/accounts")).json()) as AccountsResponse;
	expect(body.accounts.map((one: { sourceKey: string }) => one.sourceKey)).toEqual([
		"acme.settled",
	]);
});
