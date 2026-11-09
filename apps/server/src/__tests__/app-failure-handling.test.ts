import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp, createCardSkinStore } from "../app.js";
import { settingsSegment } from "../bilibili/settings.js";
import type { BootstrapConfig } from "../config/schema.js";
import { i18n } from "../i18n/index.js";
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
		i18n.set({ locale: "zh-CN", voice: "maid" });
		dataDir = await mkdtemp(join(tmpdir(), "bn-app-failure-"));
		staticDir = join(dataDir, "web-dist");
		await mkdir(staticDir, { recursive: true });
		await writeFile(join(staticDir, "index.html"), "<!doctype html><title>bn</title>");
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
		i18n.set({ locale: "zh-CN", voice: "maid" });
	});

	async function makeApp(options: { staticDir?: string } = {}) {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
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
	it.each([
		[
			"en",
			[
				"A server error occurred. See the logs for details.",
				"This endpoint does not exist.",
				"You are not signed in, or your session has expired.",
				"The requested item was not found.",
				"The request conflicts with the current state.",
				"Too many requests. Try again later.",
				"Invalid request.",
			],
		],
		[
			"ja",
			[
				"サーバーエラーが発生しました。詳細はログを確認してください。",
				"このエンドポイントは存在しません。",
				"ログインしていないか、セッションが失効しています。",
				"要求された項目が見つかりません。",
				"リクエストが現在の状態と競合しています。",
				"リクエストが多すぎます。しばらくしてから再試行してください。",
				"リクエストが無効です。",
			],
		],
		[
			"zh-TW",
			[
				"伺服器發生錯誤，詳情請查看日誌。",
				"此介面不存在。",
				"尚未登入，或登入階段已失效。",
				"找不到要求的項目。",
				"請求與目前狀態衝突。",
				"請求過於頻繁，請稍後再試。",
				"請求無效。",
			],
		],
	] as const)(
		"%s returns localized HTTP defaults and keeps original diagnostics out of responses",
		async (locale, text) => {
			const { app, runtime } = await makeApp();
			try {
				i18n.set({ locale, voice: "plain" });
				const missing = await app.request("/api/definitely-not-a-route");
				expect(missing.status).toBe(404);
				expect(await missing.json()).toEqual({ code: "not_found", message: text[1] });
				for (const [status, code, message] of [
					[401, "unauthorized", text[2]],
					[404, "not_found", text[3]],
					[409, "conflict", text[4]],
					[429, "rate_limited", text[5]],
					[413, "invalid", text[6]],
					[502, "unavailable", text[0]],
				] as const) {
					makeGlobalsThrow(runtime, new HTTPException(status));
					const res = await app.request("/api/settings");
					expect(res.status).toBe(status);
					expect(await res.json()).toEqual({ code, message });
				}
				const original = new Error("Original secret diagnostic");
				const log = vi.spyOn(runtime.serviceCtx.logger, "error");
				makeGlobalsThrow(runtime, original);
				const res = await app.request("/api/settings");
				expect(res.status).toBe(503);
				expect(await res.json()).toEqual({ code: "unavailable", message: text[0] });
				expect(log).toHaveBeenLastCalledWith(expect.any(String), original);
				makeGlobalsThrow(runtime, new HTTPException(409, { message: "Original response 原文" }));
				expect(await (await app.request("/api/settings")).json()).toEqual({
					code: "conflict",
					message: "Original response 原文",
				});
			} finally {
				await runtime.dispose();
			}
		},
	);

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
