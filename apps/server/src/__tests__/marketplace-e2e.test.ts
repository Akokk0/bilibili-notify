/**
 * 🔴 市场那两口在**真 BN** 上是接着的:index.ts 里 `createMarketplace` 那一段漏接,路由测试
 * (假的 marketplace)与模块测试(假的网络)全绿,而面板上那一节永远是 404。
 *
 * 这里不验签名(内置公钥对应的私钥不在测试里),只证明:官方源被列出来、去拉了那个固定
 * 地址、拿不到时把原因如实交回。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarketplaceResponse } from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { EXTENSION_MARKETPLACE_URL } from "../update/trusted-keys.js";

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") {
				probe.close(() => reject(new Error("failed to allocate test port")));
				return;
			}
			const { port } = address;
			probe.close(() => resolve(port));
		});
	});
}

describe("拓展市场 e2e", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle;
	let port: number;

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-marketplace-e2e-"));
		port = await findFreePort();
		handle = await startStandaloneServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
			shutdownTimeoutMs: 1_000,
		});
	});

	afterAll(async () => {
		vi.unstubAllGlobals();
		await handle.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	it("GET /api/ext/marketplace:官方源在名单上,真去拉了固定地址,拿不到就说拿不到", async () => {
		const realFetch = globalThis.fetch;
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
				seen.push(url);
				return new Response("nope", { status: 404 });
			}),
		);
		const res = await fetch(`http://127.0.0.1:${port}/api/ext/marketplace?refresh=1`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as MarketplaceResponse;
		expect(body.available).toBe(true);
		expect(body.sources).toEqual([
			expect.objectContaining({
				id: "official",
				official: true,
				ok: false,
				err: expect.stringContaining("拿不到"),
			}),
		]);
		expect(seen).toContain(EXTENSION_MARKETPLACE_URL);
	});
});
