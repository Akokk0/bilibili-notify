import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createApp, createCardSkinStore } from "../../app.js";
import { createSessionCodec } from "../../auth/session.js";
import { integrationStateFile } from "../../integration-store/files.js";
import { HTTP_COOKIES_KEY, HTTP_IDENTITY_KEY } from "../../integration-store/host-keys.js";
import { createAppRuntime } from "../../runtime/bootstrap.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function boot(auth = false) {
	const root = await mkdtemp(join(tmpdir(), "bn-identity-route-"));
	roots.push(root);
	const runtime = createAppRuntime(
		{ server: { host: "127.0.0.1", port: 8787 }, dataDir: root, logLevel: "silent" },
		{ dataRoot: root },
		{
			integrationSettings: [
				{
					key: "probe",
					schema: z.object({ interval: z.number().default(30).meta({ label: "Interval" }) }),
					identityReset: "restart",
				},
				{
					key: "other",
					schema: z.object({ interval: z.number().default(30).meta({ label: "Interval" }) }),
				},
			],
		},
	);
	await runtime.configStore.load();
	const creds = { username: "fixture-admin", password: "fixture-password" };
	const app = createApp(runtime, {
		...(auth
			? {
					basicAuthCredentials: creds,
					sessionCodec: createSessionCodec({ keyMaterial: Buffer.alloc(32, 1), creds }),
				}
			: {}),
		cardSkins: { store: createCardSkinStore(root) },
	});
	return { runtime, app, root };
}

describe("POST integration settings reset-identity", () => {
	it.each(["unknown", "other", "probe"])(
		"rejects unknown, unsupported or unopened integration: %s",
		async (key) => {
			const { runtime, app } = await boot();
			try {
				const response = await app.request(`/api/settings/integrations/${key}/reset-identity`, {
					method: "POST",
				});
				expect(response.status).toBe(key === "unknown" ? 404 : key === "other" ? 400 : 503);
				expect(((await response.json()) as { code: string }).code).toBe(
					key === "unknown" ? "not_found" : key === "other" ? "unsupported" : "unavailable",
				);
			} finally {
				await runtime.dispose();
			}
		},
	);
	it("requires the dashboard session before changing host state", async () => {
		const { runtime, app } = await boot(true);
		try {
			const target = await runtime.integrationStore.open("probe");
			await target.hostState.set(HTTP_IDENTITY_KEY, "kept");
			const response = await app.request("/api/settings/integrations/probe/reset-identity", {
				method: "POST",
			});
			expect(response.status).toBe(401);
			expect(target.hostState.get(HTTP_IDENTITY_KEY)).toBe("kept");
		} finally {
			await runtime.dispose();
		}
	});
	it("reports a failed write without changing the in-memory identity", async () => {
		const { runtime, app, root } = await boot();
		try {
			const target = await runtime.integrationStore.open("probe");
			await target.hostState.set(HTTP_IDENTITY_KEY, "kept");
			const file = join(
				root,
				...integrationStateFile("probe", runtime.configStore.reservedIntegrationKeys),
			);
			await rm(file);
			await mkdir(file);
			const response = await app.request("/api/settings/integrations/probe/reset-identity", {
				method: "POST",
			});
			expect(response.status).toBe(503);
			expect(((await response.json()) as { code: string }).code).toBe("unavailable");
			expect(target.hostState.get(HTTP_IDENTITY_KEY)).toBe("kept");
		} finally {
			await runtime.dispose();
		}
	});
	it("only clears the opted-in integration identity and preserves cookies and integration state", async () => {
		const { runtime, app } = await boot();
		try {
			const target = await runtime.integrationStore.open("probe");
			const other = await runtime.integrationStore.open("other");
			expect((await target.hostState.set(HTTP_IDENTITY_KEY, { userAgent: "old" })).ok).toBe(true);
			expect((await other.hostState.set(HTTP_IDENTITY_KEY, { userAgent: "other" })).ok).toBe(true);
			expect((await target.state.set("cursor", "kept")).ok).toBe(true);
			expect((await target.hostSecrets.set(HTTP_COOKIES_KEY, "cookie-jar-kept")).ok).toBe(true);
			const response = await app.request("/api/settings/integrations/probe/reset-identity", {
				method: "POST",
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true, appliesOn: "restart" });
			expect(target.hostState.get(HTTP_IDENTITY_KEY)).toBeUndefined();
			expect(target.state.get("cursor")).toBe("kept");
			expect(target.hostSecrets.get(HTTP_COOKIES_KEY)).toBe("cookie-jar-kept");
			expect(other.hostState.get(HTTP_IDENTITY_KEY)).toEqual({ userAgent: "other" });
		} finally {
			await runtime.dispose();
		}
	});
});
