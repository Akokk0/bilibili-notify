/**
 * 开发时 Vite 的代理表:哪些路径转给 server。
 *
 * 🔴 代理键是**前缀匹配**:`"/ext"` 会把 SPA 自己的路由 `/extensions` 也吞掉 —— 页面停在
 * 拓展页时一次整页重载,浏览器请求 `GET /extensions`,被转到 server,回来的是一句
 * `{"error":"not_found"}`(2026-09-11 主人热开发时撞上)。别的页面没事只是因为没撞上前缀。
 * 所以这里把每条代理键对着 SPA 的路由表过一遍:只许转 server 的路径,不许沾任何一个页面。
 */

import { readFileSync } from "node:fs";
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
