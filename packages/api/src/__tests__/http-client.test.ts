/**
 * BiliHttpClient(fetch 传输层)契约 —— 取代 axios + axios-cookiejar-support。
 *
 * 用回环 HTTP server 钉住 bilibili 流真正依赖的行为不变量(前三条与被替换的
 * cookiejar-wrapper.test.ts 同源):
 *  1. 请求自动带上 jar 里的 Cookie;
 *  2. 响应 Set-Cookie 自动落 jar,并立即随后续请求外发;
 *  3. 换新 jar + 新 client 后,旧 jar cookie 绝不外发(loadCookies/clearCookies/
 *     -101 重建隔离);
 *  4. **重定向逐跳收 Set-Cookie**(fetch `redirect:"follow"` 会吞中间跳的
 *     Set-Cookie —— 登录/刷新链在 302 上发 cookie,必须手动跟随);
 *  5. 非 2xx 抛错(等价 axios validateStatus 默认,412 风控页走 retry 路径);
 *  6. JSON 自动解析、HTML 原文返回(correspond 页);表单 POST 编码;
 *     默认头外发与热替换;onBody 回调(-101 拦截器挂点);超时中断。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BiliCookieJar } from "../cookie-jar";
import { BiliHttpClient } from "../http-client";

let server: Server;
let baseURL: string;
let lastReq: {
	url?: string;
	method?: string;
	cookie?: string;
	headers?: IncomingMessage["headers"];
	body?: string;
};

beforeEach(async () => {
	lastReq = {};
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			lastReq = {
				url: req.url,
				method: req.method,
				cookie: req.headers.cookie,
				headers: req.headers,
				body,
			};
			if (req.url === "/set") {
				res.setHeader("Set-Cookie", [
					"SESSDATA=server_sess; Path=/",
					"bili_jct=server_jct; Path=/",
				]);
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ code: 0 }));
			} else if (req.url === "/redirect-start") {
				// 中间跳发 Set-Cookie —— fetch follow 模式会吞掉的场景
				res.setHeader("Set-Cookie", "hop_cookie=hop1; Path=/");
				res.statusCode = 302;
				res.setHeader("Location", "/redirect-target");
				res.end();
			} else if (req.url === "/redirect-target") {
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ code: 0, echoedCookie: req.headers.cookie ?? "" }));
			} else if (req.url === "/see-other") {
				res.statusCode = 303;
				res.setHeader("Location", "/redirect-target");
				res.end();
			} else if (req.url === "/html") {
				res.setHeader("Content-Type", "text/html");
				res.end('<html><div id="1-name">refresh_csrf_value</div></html>');
			} else if (req.url === "/status-412") {
				res.statusCode = 412;
				res.setHeader("Content-Type", "text/html");
				res.end("risk banned");
			} else if (req.url === "/slow") {
				// 故意不回应 —— 超时用
			} else {
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ code: 0 }));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	baseURL = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(
	jar = new BiliCookieJar(),
	opts: {
		timeoutMs?: number;
		onBody?: (b: unknown) => void;
		headers?: Record<string, string>;
	} = {},
) {
	return new BiliHttpClient({
		jar,
		headers: { "User-Agent": "test-ua/1.0", Origin: "https://www.bilibili.com", ...opts.headers },
		timeoutMs: opts.timeoutMs ?? 5_000,
		onBody: opts.onBody,
	});
}

describe("BiliHttpClient — cookie 收发管线(与 axios wrapper 等价)", () => {
	it("请求自动带上 jar 的 Cookie", async () => {
		const jar = new BiliCookieJar();
		jar.setFromSetCookie("SESSDATA=preloaded; Path=/", `${baseURL}/`);
		const client = makeClient(jar);
		const data = (await client.get(`${baseURL}/echo`)) as { code: number };
		expect(lastReq.cookie).toContain("SESSDATA=preloaded");
		expect(data.code).toBe(0);
	});

	it("响应 Set-Cookie 落 jar,并随后续请求外发", async () => {
		const jar = new BiliCookieJar();
		const client = makeClient(jar);
		await client.get(`${baseURL}/set`);
		expect(jar.getValue("SESSDATA")).toBe("server_sess");
		expect(jar.getValue("bili_jct")).toBe("server_jct");
		await client.get(`${baseURL}/echo`);
		expect(lastReq.cookie).toContain("SESSDATA=server_sess");
		expect(lastReq.cookie).toContain("bili_jct=server_jct");
	});

	it("换新 jar + 新 client 后旧 cookie 绝不外发", async () => {
		const oldJar = new BiliCookieJar();
		oldJar.setFromSetCookie("SESSDATA=stale_old; Path=/", `${baseURL}/`);
		await makeClient(oldJar).get(`${baseURL}/echo`);
		expect(lastReq.cookie).toContain("stale_old");

		const newJar = new BiliCookieJar();
		newJar.setFromSetCookie("SESSDATA=fresh_new; Path=/", `${baseURL}/`);
		await makeClient(newJar).get(`${baseURL}/echo`);
		expect(lastReq.cookie).toContain("fresh_new");
		expect(lastReq.cookie).not.toContain("stale_old");
	});

	it("重定向逐跳收 Set-Cookie,且带着新 cookie 跟到目标", async () => {
		const jar = new BiliCookieJar();
		const client = makeClient(jar);
		const data = (await client.get(`${baseURL}/redirect-start`)) as { echoedCookie: string };
		expect(jar.getValue("hop_cookie")).toBe("hop1");
		expect(data.echoedCookie).toContain("hop_cookie=hop1");
	});
});

describe("BiliHttpClient — 请求/响应语义", () => {
	it("JSON 响应自动解析;HTML 响应原文返回(correspond 页场景)", async () => {
		const client = makeClient();
		const json = await client.get(`${baseURL}/echo`);
		expect(json).toEqual({ code: 0 });
		const html = await client.get(`${baseURL}/html`);
		expect(typeof html).toBe("string");
		expect(html).toContain('id="1-name"');
	});

	it("postForm 以 x-www-form-urlencoded 编码对象", async () => {
		const client = makeClient();
		await client.postForm(`${baseURL}/echo`, { csrf: "c&v", act: 1 });
		expect(lastReq.method).toBe("POST");
		expect(lastReq.headers?.["content-type"]).toContain("application/x-www-form-urlencoded");
		expect(lastReq.body).toBe("csrf=c%26v&act=1");
	});

	it("303 重定向把 POST 降级为 GET(不重发 body)", async () => {
		const client = makeClient();
		await client.postForm(`${baseURL}/see-other`, { a: "1" });
		expect(lastReq.url).toBe("/redirect-target");
		expect(lastReq.method).toBe("GET");
		expect(lastReq.body).toBe("");
	});

	it("非 2xx 抛错(等价 axios validateStatus,412 风控页进 retry 路径)", async () => {
		const client = makeClient();
		await expect(client.get(`${baseURL}/status-412`)).rejects.toThrow(/412/);
	});

	it("默认头随请求外发,setHeader 热替换 UA,单次请求头可覆盖", async () => {
		const client = makeClient();
		await client.get(`${baseURL}/echo`);
		expect(lastReq.headers?.["user-agent"]).toBe("test-ua/1.0");
		expect(lastReq.headers?.origin).toBe("https://www.bilibili.com");

		client.setHeader("User-Agent", "swapped-ua/2.0");
		await client.get(`${baseURL}/echo`);
		expect(lastReq.headers?.["user-agent"]).toBe("swapped-ua/2.0");

		await client.get(`${baseURL}/echo`, { headers: { "User-Agent": "per-request/3.0" } });
		expect(lastReq.headers?.["user-agent"]).toBe("per-request/3.0");
	});

	it("onBody 对每个解析后的响应体触发(-101 拦截器挂点)", async () => {
		const seen: unknown[] = [];
		const client = makeClient(new BiliCookieJar(), { onBody: (b) => seen.push(b) });
		await client.get(`${baseURL}/echo`);
		expect(seen).toEqual([{ code: 0 }]);
	});

	it("超时中断挂起的请求(挂死连接不卡刷新链)", async () => {
		const client = makeClient(new BiliCookieJar(), { timeoutMs: 200 });
		await expect(client.get(`${baseURL}/slow`)).rejects.toThrow();
	});
});
