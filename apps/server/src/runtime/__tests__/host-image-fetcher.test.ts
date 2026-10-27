/**
 * 宿主自己的抓图口(`AppRuntime.imageFetcher`):核心抓会员自定义图不再借 B 站集成的请求客户端
 * (集成副作用规范「边界与例外」:BN 自己的请求不走集成的客户端)。
 * - 运行时里没有任何集成也抓得到 —— 以前 B 站集成没开时这条路回「bilibili integration is not running」;
 * - BN 自己的客户端:不带 cookie,对端回的 Set-Cookie 也不留到下一次;
 * - 图进图库,读得回原样的字节;
 * - 没注入地址检查时照旧拦内网。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requirePublicAddress } from "@bilibili-notify/http";
import { ok, type Result } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { png } from "../../__tests__/support/report-images.js";
import type { BootstrapConfig } from "../../config/schema.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";

const PNG = png(10, 10, 1);

/** 回环放行(假图床就在回环上),其余照生产的规矩。 */
const loopbackAllowed = (address: string): Result =>
	address.startsWith("127.") ? ok() : requirePublicAddress(address);

let server: Server;
let port: number;
/** 假图床收到的每个请求带的头。 */
let seen: IncomingMessage["headers"][];
let dataDir: string;
let runtime: AppRuntime | undefined;

function makeBootstrap(dir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir: dir, logLevel: "silent" };
}

function makeRuntime(addressCheck?: typeof loopbackAllowed): AppRuntime {
	runtime = createAppRuntime(
		makeBootstrap(dataDir),
		{ dataRoot: dataDir },
		{ integrationSettings: [], ...(addressCheck ? { imageAddressCheck: addressCheck } : {}) },
	);
	return runtime;
}

beforeEach(async () => {
	seen = [];
	server = createServer((req, res) => {
		seen.push(req.headers);
		res.setHeader("set-cookie", "track=1; Path=/");
		res.setHeader("content-type", "image/png");
		res.end(Buffer.from(PNG));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	dataDir = await mkdtemp(join(tmpdir(), "bn-host-image-fetcher-"));
});

afterEach(async () => {
	await runtime?.dispose();
	runtime = undefined;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(dataDir, { recursive: true, force: true });
});

describe("宿主自己的抓图口", () => {
	it("没有任何集成也抓得到;图进图库,读得回原样的字节", async () => {
		const rt = makeRuntime(loopbackAllowed);

		const fetched = await rt.imageFetcher.fetchImage(`http://127.0.0.1:${port}/custom.png`);
		expect(fetched.ok, JSON.stringify(fetched)).toBe(true);
		if (!fetched.ok) return;
		const image = await rt.imageStore.read(fetched.ref);
		expect(image?.mime).toBe("image/png");
		expect(Buffer.from(image?.bytes ?? []).equals(Buffer.from(PNG))).toBe(true);
	});

	it("BN 自己的客户端:不带 cookie,对端回的 Set-Cookie 不留到下一次;带浏览器身份", async () => {
		const rt = makeRuntime(loopbackAllowed);

		expect((await rt.imageFetcher.fetchImage(`http://127.0.0.1:${port}/a.png`)).ok).toBe(true);
		expect((await rt.imageFetcher.fetchImage(`http://127.0.0.1:${port}/b.png`)).ok).toBe(true);
		expect(seen).toHaveLength(2);
		expect(seen.map((headers) => headers.cookie)).toEqual([undefined, undefined]);
		expect(seen[0]?.["user-agent"]).toMatch(/Chrome\//);
	});

	it("没注入地址检查 → 照旧拦内网,不出网", async () => {
		const rt = makeRuntime();

		const fetched = await rt.imageFetcher.fetchImage(`http://127.0.0.1:${port}/custom.png`);
		expect(fetched.ok).toBe(false);
		expect(seen).toEqual([]);
	});
});
