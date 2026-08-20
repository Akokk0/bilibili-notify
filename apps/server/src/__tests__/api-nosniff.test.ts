import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp } from "../app.js";
import type { BootstrapConfig } from "../config/schema.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

// ---------------------------------------------------------------------------
// `X-Content-Type-Options: nosniff`,钉在 /api/* 这一个口上。
//
// 四条路在发**主人上传的字节**:皮肤包资产(壁纸 + 自带字体)、聊天附件、卡片背景图、
// 卡片字体。它们各自都声明了正确的 content-type,但没有 nosniff 时浏览器仍保留自行
// 嗅探的余地 —— 而皮肤包是可以从外部导入的 zip,里头的字节不是我们写的。真被嗅成
// HTML,那就是一个长在 API 同源上的存储型 XSS。
//
// **为什么是 /api/* 而不是全局**:静态面板资源(serveStatic)是我们自己的构建产物,
// 不是攻击面;而 nosniff 会让浏览器严格照 content-type 办事,万一 Hono 的 mime 表
// 认不出某个构建产物,整块面板就直接不加载了。风险收益不对等,不往那边扩。
//
// 钉成测试而不是「加了就完事」:这类头看不见摸不着,删掉/漏掉都不会有任何报错。
// ---------------------------------------------------------------------------

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

describe("API 响应带 nosniff", () => {
	let dataDir: string;
	let staticDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-nosniff-"));
		staticDir = join(dataDir, "web-dist");
		await mkdir(join(staticDir, "assets"), { recursive: true });
		await writeFile(join(staticDir, "index.html"), "<!doctype html><title>bn</title>");
		await writeFile(join(staticDir, "assets", "index-Ba1b2C3d.js"), "console.log('panel')");
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	async function makeApp() {
		const runtime = createAppRuntime(makeBootstrap(dataDir));
		await runtime.configStore.load();
		return { app: createApp(runtime, { staticDir }), runtime };
	}

	it("发用户上传字节的那条路带 nosniff", async () => {
		const { app, runtime } = await makeApp();
		// 资产不存在也无妨:头挂在中间件上,与路由回什么无关 —— 反倒正好证明这一点。
		const res = await app.request("/api/skins/nope/assets/x.png");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		await runtime.dispose();
	});

	it("普通 JSON 接口同样带 —— 一个口管全部,新路由不用记得自己加", async () => {
		const { app, runtime } = await makeApp();
		const res = await app.request("/api/session");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		await runtime.dispose();
	});

	it("404 的 API 响应也带 —— 错误路径同样会把响应体交给浏览器", async () => {
		const { app, runtime } = await makeApp();
		const res = await app.request("/api/definitely-not-a-route");
		expect(res.status).toBe(404);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		await runtime.dispose();
	});

	it("静态面板资源**不带** —— 那是我们自己的构建产物,收益抵不上 mime 认错就白屏的风险", async () => {
		const { app, runtime } = await makeApp();
		const res = await app.request("/assets/index-Ba1b2C3d.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("x-content-type-options")).toBeNull();
		await runtime.dispose();
	});
});
