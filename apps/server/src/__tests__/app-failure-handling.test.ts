import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

// ---------------------------------------------------------------------------
// 全局出错处理与 notFound(ADR-0026 决策 6):抛出来的一律按 unavailable 回、原始错误进日志、
// 不再把 String(err) 回给客户端;HTTPException 按它的状态码挑码;notFound 回标准的 not_found。
// 路由本身还没迁,这里只钉「路由抛了 / 没有这条路」两个口。
// ---------------------------------------------------------------------------

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("全局出错处理与 notFound", () => {
	let dataDir: string;
	let staticDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-app-failure-"));
		staticDir = join(dataDir, "web-dist");
		await mkdir(staticDir, { recursive: true });
		await writeFile(join(staticDir, "index.html"), "<!doctype html><title>bn</title>");
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	async function makeApp(options: { staticDir?: string } = {}) {
		const runtime = createAppRuntime(makeBootstrap(dataDir), { dataRoot: dataDir });
		await runtime.configStore.load();
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			...options,
		});
		return { app, runtime };
	}

	/** 让 `GET /api/settings` 在读配置那一步抛出 `thrown` —— 真路由、真装配,只把底下的一步弄炸。 */
	function makeGlobalsThrow(
		runtime: Awaited<ReturnType<typeof makeApp>>["runtime"],
		thrown: unknown,
	) {
		vi.spyOn(runtime.configStore, "getGlobals").mockImplementation(() => {
			throw thrown;
		});
	}

	it("路由抛了普通错误:回 unavailable + 固定的一句话,原话不外泄", async () => {
		const { app, runtime } = await makeApp();
		// local-path-ok:故意造一条带家目录路径的报错,验它不外泄
		makeGlobalsThrow(runtime, new Error("boom at /Users/x/secret.txt"));
		const res = await app.request("/api/settings");
		const text = await res.text();
		expect(res.status).toBe(503);
		expect(JSON.parse(text)).toEqual({
			code: "unavailable",
			message: "服务端出错了，详情在日志里",
		});
		expect(text).not.toContain("boom");
		expect(text).not.toContain("secret.txt");
		await runtime.dispose();
	});

	it("路由抛了普通错误:原始错误记进错误日志", async () => {
		const { app, runtime } = await makeApp();
		const boom = new Error("boom");
		makeGlobalsThrow(runtime, boom);
		const logError = vi.spyOn(runtime.serviceCtx.logger, "error");
		await app.request("/api/settings");
		expect(logError).toHaveBeenCalledWith(expect.any(String), boom);
		await runtime.dispose();
	});

	it.each([
		[401, "unauthorized"],
		[404, "not_found"],
		[409, "conflict"],
		[413, "invalid"],
		[422, "invalid"],
		[429, "rate_limited"],
	] as const)("HTTPException %i:状态码照原样,码是 %s,message 用它自己的", async (status, code) => {
		const { app, runtime } = await makeApp();
		makeGlobalsThrow(runtime, new HTTPException(status, { message: "它自己的话" }));
		const res = await app.request("/api/settings");
		expect(res.status).toBe(status);
		expect(await res.json()).toEqual({ code, message: "它自己的话" });
		await runtime.dispose();
	});

	it("HTTPException 没带 message:给一句中文,不是空串", async () => {
		const { app, runtime } = await makeApp();
		makeGlobalsThrow(runtime, new HTTPException(413));
		const res = await app.request("/api/settings");
		const body = (await res.json()) as { code: string; message: string };
		expect(res.status).toBe(413);
		expect(body.code).toBe("invalid");
		expect(body.message).toMatch(/[一-鿿]/);
		await runtime.dispose();
	});

	it("HTTPException 5xx:按 unavailable 回,状态码照原样", async () => {
		const { app, runtime } = await makeApp();
		makeGlobalsThrow(runtime, new HTTPException(502, { message: "上游挂了" }));
		const res = await app.request("/api/settings");
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ code: "unavailable", message: "上游挂了" });
		await runtime.dispose();
	});

	it("不存在的 API 路径:404 + not_found", async () => {
		const { app, runtime } = await makeApp();
		const res = await app.request("/api/definitely-not-a-route");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这个接口" });
		await runtime.dispose();
	});

	it("POST 打到不存在的非 API 路径:同样回 not_found(SPA 回落只认 GET)", async () => {
		const { app, runtime } = await makeApp({ staticDir });
		const res = await app.request("/somewhere", { method: "POST" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这个接口" });
		await runtime.dispose();
	});

	it("SPA 回落照旧:配了 staticDir 时,非 API 的 GET 落到 index.html", async () => {
		const { app, runtime } = await makeApp({ staticDir });
		const page = await app.request("/some/client/route");
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("<title>bn</title>");
		const api = await app.request("/api/definitely-not-a-route");
		expect(api.status).toBe(404);
		await runtime.dispose();
	});
});
