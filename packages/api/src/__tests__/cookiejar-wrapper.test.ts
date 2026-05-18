/**
 * 回归守护 — 依赖回退 `axios-cookiejar-support@^6 → ^5`(纯 ESM → CJS,修
 * koishi Node20 `ERR_REQUIRE_ESM`)的**运行时行为等价性**。
 *
 * 该回退的唯一论据是「打包格式回退、运行时行为不变」。bilibili-api.ts 用法是
 * `wrapper(axios.create({ jar, ... }))` + 依赖自动 Cookie 收发,且 loadCookies /
 * clearCookies / 终态时重建 `new CookieJar()` 后经 `initClient()` 重新 `wrapper`
 * 重绑。本测试用回环 HTTP server(非外网,确定性可单测)断言 acs@5 wrapper 下
 * 三条 bilibili 流真正依赖的不变量:
 *
 *  1. wrapper 后请求自动带上 jar 里的 Cookie(等价 GET/POST 自动带 SESSDATA/
 *     bili_jct);
 *  2. 响应 `Set-Cookie` 自动落进同一 jar(等价 QR 登录 poll 取 Set-Cookie /
 *     cookie 刷新拿新 SESSDATA),且立即随后续请求外发;
 *  3. 换一个新 jar 重新 `wrapper(axios.create({ jar }))` 后,旧 jar 的 cookie
 *     绝不外发、只发新 jar 的(等价 loadCookies/clearCookies/-101 重建 jar +
 *     initClient 重绑后的隔离保证);
 *  4. acs@5 注入的是 node http(s).Agent 形态的 cookie agent(走
 *     `http-cookie-agent/http`,非 undici),与本仓 axios 默认 http(s) 传输一致。
 *
 * 注:cookie 用 host-only(不显式写 `Domain=`)—— tough-cookie@6 对 IP 写
 * 显式 Domer 会按 public-suffix 拒绝;真实 bilibili-api.ts 走 `.bilibili.com`
 * 域,本测试只验 wrapper 收发管线本身,域匹配语义由 tough-cookie 自身保证。
 *
 * 复发点:有人把 acs 改回 6.x(ESM,koishi 端再炸 ERR_REQUIRE_ESM),或
 * acs/hca 某 major 改了 jar 注入语义 / 改走 undici 传输导致默认 http(s).Agent
 * 路径下 Cookie 不再自动收发。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let server: Server;
let baseURL: string;
let lastCookieHeader: string | undefined;

beforeEach(async () => {
	lastCookieHeader = undefined;
	server = createServer((req: IncomingMessage, res) => {
		lastCookieHeader = req.headers.cookie;
		if (req.url === "/set") {
			// 模拟 B 站登录 / 刷新返回 Set-Cookie(host-only,无显式 Domain)
			res.setHeader("Set-Cookie", [
				"SESSDATA=server_issued_sess; Path=/",
				"bili_jct=server_issued_jct; Path=/",
			]);
		}
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ code: 0 }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	baseURL = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("axios-cookiejar-support@5 wrapper — bilibili-api.ts 用法运行时等价性", () => {
	it("wrapper(axios.create({ jar })) 后请求自动带上 jar 的 Cookie", async () => {
		const jar = new CookieJar();
		// 模拟 loadCookies 写入的会话 cookie
		await jar.setCookie("SESSDATA=preloaded_sess; Path=/", baseURL);
		await jar.setCookie("bili_jct=preloaded_jct; Path=/", baseURL);

		const client = wrapper(axios.create({ jar, timeout: 5_000 }));
		const { data } = await client.get(`${baseURL}/echo`);

		expect(lastCookieHeader).toBeDefined();
		expect(lastCookieHeader).toContain("SESSDATA=preloaded_sess");
		expect(lastCookieHeader).toContain("bili_jct=preloaded_jct");
		expect(data.code).toBe(0);
	});

	it("响应 Set-Cookie 自动落进同一 jar,且随后续请求外发(QR 登录 / cookie 刷新取新 Cookie)", async () => {
		const jar = new CookieJar();
		const client = wrapper(axios.create({ jar, timeout: 5_000 }));

		await client.get(`${baseURL}/set`);

		const stored = await jar.getCookies(baseURL);
		const byKey = Object.fromEntries(stored.map((c) => [c.key, c.value]));
		expect(byKey.SESSDATA).toBe("server_issued_sess");
		expect(byKey.bili_jct).toBe("server_issued_jct");

		// 复用同一 client 再请求 —— 刚收到的 Cookie 立即随后续请求外发
		// (等价刷新后续 API 自动带新 SESSDATA)
		await client.get(`${baseURL}/echo`);
		expect(lastCookieHeader).toContain("SESSDATA=server_issued_sess");
		expect(lastCookieHeader).toContain("bili_jct=server_issued_jct");
	});

	it("重建 new CookieJar() + 重新 wrapper 后,旧 jar 的 cookie 绝不外发(loadCookies/clearCookies/-101 隔离)", async () => {
		const oldJar = new CookieJar();
		await oldJar.setCookie("SESSDATA=stale_old_session; Path=/", baseURL);
		const oldClient = wrapper(axios.create({ jar: oldJar, timeout: 5_000 }));
		await oldClient.get(`${baseURL}/echo`);
		expect(lastCookieHeader).toContain("SESSDATA=stale_old_session");

		// initClient 重建语义:新 jar + 新 wrapper(axios.create({ jar }))
		const newJar = new CookieJar();
		await newJar.setCookie("SESSDATA=fresh_new_session; Path=/", baseURL);
		const newClient = wrapper(axios.create({ jar: newJar, timeout: 5_000 }));
		await newClient.get(`${baseURL}/echo`);

		expect(lastCookieHeader).toContain("SESSDATA=fresh_new_session");
		// 关键安全不变量:旧会话 cookie 绝不残留外发
		expect(lastCookieHeader).not.toContain("stale_old_session");
	});

	it("acs@5 注入 node http(s).Agent 形态的 cookie agent(走 http-cookie-agent/http,非 undici)", async () => {
		// acs@5 在 request 拦截器里按需把 http(s)CookieAgent 注入到 *每次请求的
		// config*(不是 client.defaults)。axios request 拦截器 LIFO 执行,acs 的
		// 在 wrapper() 内最先注册 → 最后执行;故在 *response* 拦截器(FIFO,拿到
		// 的 config 已是跑完所有 request 拦截器后的最终态)里断言 acs 注入了
		// node http.Agent 形态的 agent(有 createConnection,非 undici
		// Dispatcher 的 .dispatch)。这条保证回退后仍走 axios 默认 http(s).Agent
		// 传输自动收发 Cookie。
		const jar = new CookieJar();
		const client = wrapper(axios.create({ jar, timeout: 5_000 }));
		let injectedHttpAgent: unknown;
		let injectedHttpsAgent: unknown;
		client.interceptors.response.use((resp) => {
			injectedHttpAgent = resp.config.httpAgent;
			injectedHttpsAgent = resp.config.httpsAgent;
			return resp;
		});

		await client.get(`${baseURL}/echo`);

		expect(injectedHttpAgent).toBeDefined();
		expect(injectedHttpsAgent).toBeDefined();
		expect(typeof (injectedHttpAgent as { createConnection?: unknown }).createConnection).toBe(
			"function",
		);
		// undici Dispatcher 暴露 .dispatch();node http.Agent 没有 —— 确认非 undici 传输
		expect((injectedHttpAgent as { dispatch?: unknown }).dispatch).toBeUndefined();
	});
});
