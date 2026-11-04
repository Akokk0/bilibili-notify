/**
 * 开发时 Vite 的代理表:哪些路径转给 server。
 *
 * 🔴 代理键是**前缀匹配**:`"/ext"` 会把 SPA 自己的路由 `/extensions` 也吞掉 —— 页面停在
 * 拓展页时一次整页重载,浏览器请求 `GET /extensions`,被转到 server,回来的是一句
 * `{"error":"not_found"}`(2026-09-11 主人热开发时撞上)。别的页面没事只是因为没撞上前缀。
 * 所以这里把每条代理键对着 SPA 的路由表过一遍:只许转 server 的路径,不许沾任何一个页面。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { describe, expect, it } from "vite-plus/test";
import config from "../../vite.config";

/**
 * SPA 自己的页面路由 —— 从 App.tsx 的 `<Route path=…>` 现读,新页面自动进来。参数段换成一个
 * 像样的值(`:id` → `bridge`),可选段去掉。
 */
function spaRoutes(): string[] {
	const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
	const routes = new Set<string>();
	for (const match of source.matchAll(/<Route\s+path="([^"]+)"/g)) {
		const raw = match[1] as string;
		const filled = raw
			.split("/")
			.filter((seg) => !seg.endsWith("?"))
			.map((seg) => (seg.startsWith(":") ? "bridge" : seg))
			.join("/");
		routes.add(filled === "" ? "/" : filled);
		routes.add(
			raw
				.split("/")
				.filter((seg) => !seg.startsWith(":"))
				.join("/") || "/",
		);
	}
	return [...routes];
}

/** server 那头真存在的、必须转过去的路径。 */
const SERVER_PATHS = ["/api/health", "/ws", "/ext/bridge", "/ext/bridge/blob/x"];

function proxyMatches(key: string, path: string): boolean {
	// Vite:以 ^ 开头的键是正则,否则是前缀。
	return key.startsWith("^") ? new RegExp(key).test(path) : path.startsWith(key);
}

describe("vite 代理表", () => {
	const proxy = (config as { server?: { proxy?: Record<string, unknown> } }).server?.proxy ?? {};
	const keys = Object.keys(proxy);

	it("有代理表", () => {
		expect(keys.length).toBeGreaterThan(0);
	});

	it("SPA 的每个页面路由都不被任何一条代理吞掉", () => {
		const routes = spaRoutes();
		expect(routes).toContain("/extensions");
		for (const route of routes) {
			const hit = keys.filter((key) => proxyMatches(key, route));
			expect(hit, `${route} 被代理键 ${JSON.stringify(hit)} 吞了`).toEqual([]);
		}
	});

	it("server 的那几条路径都转得过去", () => {
		for (const path of SERVER_PATHS) {
			expect(
				keys.some((key) => proxyMatches(key, path)),
				`${path} 没人转`,
			).toBe(true);
		}
	});
});

it("开发页面能读取当前工作区导出，即使旧 lib 缺少这些导出", async () => {
	const root = mkdtempSync(join(tmpdir(), "bn-web-dev-"));
	const webRoot = fileURLToPath(new URL("../../", import.meta.url));
	let server: Awaited<ReturnType<typeof createServer>> | undefined;
	try {
		const modules = join(root, "node_modules/@bilibili-notify");
		mkdirSync(modules, { recursive: true });
		for (const name of ["internal", "contract"]) {
			const pkg = join(root, name);
			mkdirSync(join(pkg, "lib"), { recursive: true });
			writeFileSync(
				join(pkg, "package.json"),
				JSON.stringify({
					name: `@bilibili-notify/${name}`,
					type: "module",
					exports: { ".": "./lib/index.mjs", "./card-skin": "./lib/index.mjs" },
				}),
			);
			writeFileSync(join(pkg, "lib/index.mjs"), 'export const OLD_EXPORT = "stale";');
			symlinkSync(pkg, join(modules, name), "junction");
		}
		const entry = join(root, "page.ts");
		writeFileSync(
			entry,
			`import { cardSkinRankGuide } from "@bilibili-notify/internal/card-skin";
import { SKIN_CSS_MODEL_HOOK_NOTES } from "@bilibili-notify/contract";
export const view = { rankGuide: typeof cardSkinRankGuide, modelHooks: typeof SKIN_CSS_MODEL_HOOK_NOTES };`,
		);
		server = await createServer({
			...config,
			configFile: false,
			root: webRoot,
			cacheDir: join(root, "cache"),
			server: { middlewareMode: true, watch: null, ws: false },
			optimizeDeps: { noDiscovery: true, include: [] },
		});
		const page = await server.ssrLoadModule(entry);
		expect(page.view).toEqual({ rankGuide: "function", modelHooks: "object" });
	} finally {
		await server?.close();
		rmSync(root, { recursive: true, force: true });
	}
});
