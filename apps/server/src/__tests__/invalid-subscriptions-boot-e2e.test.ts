import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEmptySubscription } from "@bilibili-notify/internal";
import { expect, it } from "vite-plus/test";
import { CONFIG_DIR } from "../config/store.js";
import { type ServerHandle, startServer } from "../index.js";
import { openTestGeneration } from "./support/generation.js";

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("No port"));
				return;
			}
			server.close(() => resolve(address.port));
		});
	});
}

// Cutting either the startup sweep's config reader or the deletion sweep's reader loses this cache.
it("boots with isolated rows, preserves their cache across startup and deletion, and rejects HTTP overwrites safely", async () => {
	const root = await mkdtemp(join(tmpdir(), "bn-4-22-boot-"));
	let handle: ServerHandle | undefined;
	try {
		const dir = await openTestGeneration(root);
		await mkdir(join(dir, ...CONFIG_DIR), { recursive: true });
		await mkdir(join(dir, "runtime"), { recursive: true });
		const good = makeEmptySubscription({
			id: randomUUID(),
			identity: { sourceKey: "acme", externalId: "good" },
		});
		const bad = {
			...makeEmptySubscription({
				id: randomUUID(),
				identity: { sourceKey: "bilibili", externalId: "12345" },
			}),
			enabled: "private-token",
			extra: { token: "private-canary" },
		};
		const file = join(dir, ...CONFIG_DIR, "subscriptions.json");
		await writeFile(file, JSON.stringify({ tags: [], subscriptions: [good, bad] }));
		const cache = join(dir, "runtime", "subscription-state.json");
		const profile = { cachedProfile: { name: "kept", refreshedAt: "2026-01-01T00:00:00.000Z" } };
		await writeFile(cache, JSON.stringify({ [bad.id]: profile, orphan: profile }));
		handle = await startServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(await freePort()),
				"--data-dir",
				root,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
			installProcessHandlers: false,
		});
		const request = (path: string, method = "GET", body?: unknown) =>
			fetch(`${handle?.url}${path}`, {
				method,
				...(body === undefined
					? {}
					: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
			});
		expect(JSON.parse(await readFile(cache, "utf8"))).toEqual({ [bad.id]: profile });
		const listed = await (await request("/api/subscriptions")).json();
		expect(listed).toEqual([expect.objectContaining({ id: good.id })]);
		const problems = await (await request("/api/problems")).json();
		expect(problems).toMatchObject({
			problems: expect.arrayContaining([
				expect.objectContaining({ reporter: "core", code: "subscriptions_invalid" }),
			]),
		});
		expect(JSON.stringify(problems)).not.toMatch(/private-token|private-canary|12345/);
		const candidate = makeEmptySubscription({ id: randomUUID(), identity: bad.identity });
		const refused = await request("/api/subscriptions", "POST", candidate);
		expect(refused.status).toBe(409);
		expect(JSON.stringify(await refused.json())).not.toMatch(/12345|private-/);
		expect((await request(`/api/subscriptions/${bad.id}`, "PATCH", { enabled: true })).status).toBe(
			404,
		);
		expect((await request(`/api/subscriptions/${bad.id}`, "DELETE")).status).toBe(404);
		expect((await request(`/api/subscriptions/${good.id}`, "DELETE")).status).toBe(204);
		await handle.close("test");
		handle = undefined;
		expect(JSON.parse(await readFile(cache, "utf8"))).toEqual({ [bad.id]: profile });
		expect(JSON.parse(await readFile(file, "utf8")).subscriptions).toEqual([bad]);
	} finally {
		await handle?.close("test cleanup");
		await rm(root, { recursive: true, force: true });
	}
});
