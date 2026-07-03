import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp } from "../app.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

// ---------------------------------------------------------------------------
// Dashboard 静态资源缓存策略 —— serveStatic 默认只发 Last-Modified,浏览器会
// 按启发式缓存旧 index.html/JS,镜像更新后面板仍是旧版(用户观察到「核心
// 更新了但面板没更新」)。Vite 的 /assets/* 文件名含内容 hash → immutable
// 永久缓存;其余入口文件(index.html / sponsors.json / SPA fallback)必须
// no-cache 每次向服务器确认。/api/* 不受影响。
// ---------------------------------------------------------------------------

const IMMUTABLE = "public, max-age=31536000, immutable";

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("static cache headers", () => {
	let dataDir: string;
	let staticDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-static-cache-"));
		staticDir = join(dataDir, "web-dist");
		await mkdir(join(staticDir, "assets"), { recursive: true });
		await writeFile(join(staticDir, "index.html"), "<!doctype html><title>bn</title>");
		await writeFile(join(staticDir, "assets", "index-Ba1b2C3d.js"), "console.log('panel')");
		await writeFile(join(staticDir, "sponsors.json"), "[]");
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	async function makeApp() {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		const app = createApp(runtime, { staticDir });
		return { app, runtime };
	}

	it("hashed /assets/* → immutable 永久缓存", async () => {
		const { app, runtime } = await makeApp();
		const res = await app.request("/assets/index-Ba1b2C3d.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
		await runtime.dispose();
	});

	it("/ (index.html 目录索引) → no-cache 强制回源确认", async () => {
		const { app, runtime } = await makeApp();
		const res = await app.request("/");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-cache");
		await runtime.dispose();
	});

	it("/index.html 直连 → no-cache", async () => {
		const { app, runtime } = await makeApp();
		const res = await app.request("/index.html");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-cache");
		await runtime.dispose();
	});

	it("SPA fallback(未知客户端路由)→ no-cache", async () => {
		const { app, runtime } = await makeApp();
		const res = await app.request("/rules/some-up");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(res.headers.get("cache-control")).toBe("no-cache");
		await runtime.dispose();
	});

	it("public 目录文件(sponsors.json,无 hash)→ no-cache", async () => {
		const { app, runtime } = await makeApp();
		const res = await app.request("/sponsors.json");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-cache");
		await runtime.dispose();
	});

	it("/api/* 404 JSON 不被静态缓存策略沾染", async () => {
		const { app, runtime } = await makeApp();
		const res = await app.request("/api/does-not-exist");
		expect(res.status).toBe(404);
		expect(res.headers.get("cache-control")).toBeNull();
		await runtime.dispose();
	});
});
