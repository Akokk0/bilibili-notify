/**
 * ApiClient —— `@bilibili-notify/http` 之上的那层薄包,把 B 站流一直依赖的语义原样保住
 * (取代 axios + axios-cookiejar-support 时钉下来的,通用的那部分已搬去 packages/http):
 *  1. **非 2xx 抛错**(等价 axios validateStatus 默认,412 风控页进外层 retry),消息里的 URL 去掉 query;
 *  2. **JSON 尝试解析、失败回退原文**(JSON 接口得对象、correspond HTML 页得字符串);表单 POST 编码;
 *  3. **onBody 只对 2xx 触发**(-101 拦截器挂点);
 *  4. **只取第一跳 Location**(b23.tv 短链),且不摄入那一跳的 Set-Cookie;
 *  5. 重定向跟满(5 跳)还在跳 → 抛「重定向超过 5 跳」;
 *  6. 失败结果(超时、连不上)转成抛错,进外层 retry;
 *  7. 单次请求头盖过 HttpClient 的默认头(同名只留一份)。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CookieJar, generateBrowserIdentity, HttpClient } from "@bilibili-notify/http";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ApiClient } from "../api-client";

let server: Server;
let baseURL: string;
let hits: string[];
let lastReq: { url?: string; method?: string; headers?: IncomingMessage["headers"]; body?: string };

beforeEach(async () => {
	hits = [];
	lastReq = {};
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			hits.push(`${req.method} ${req.url}`);
			lastReq = { url: req.url, method: req.method, headers: req.headers, body };
			const path = req.url?.split("?")[0];
			if (path === "/html") {
				res.setHeader("Content-Type", "text/html");
				res.end('<html><div id="1-name">refresh_csrf_value</div></html>');
			} else if (path === "/status-412") {
				res.statusCode = 412;
				res.setHeader("Content-Type", "text/html");
				res.end("risk banned");
			} else if (path === "/status-code-body") {
				res.statusCode = 500;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ code: -101 }));
			} else if (path === "/see-other") {
				res.statusCode = 303;
				res.setHeader("Location", "/echo");
				res.end();
			} else if (path === "/loop") {
				res.statusCode = 302;
				res.setHeader("Location", "/loop?again=1");
				res.end();
			} else if (path === "/hop") {
				res.setHeader("Set-Cookie", "short_cookie=1; Path=/");
				res.statusCode = 302;
				res.setHeader("Location", "/landing?x=1");
				res.end();
			} else if (path === "/set") {
				res.setHeader("Set-Cookie", "SESSDATA=server_sess; Path=/");
				res.end(JSON.stringify({ code: 0 }));
			} else if (path === "/slow") {
				// 故意不回应 —— 超时用
			} else if (path === "/landing") {
				res.end("<html>landing</html>");
			} else {
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ code: 0 }));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(
	jar = new CookieJar(),
	opts: {
		timeoutMs?: number;
		onBody?: (b: unknown, generation: number | undefined) => void;
		generation?: () => number;
	} = {},
) {
	return new ApiClient({
		http: new HttpClient({
			jar,
			identity: generateBrowserIdentity(),
			headers: { "User-Agent": "test-ua/1.0", Origin: "https://www.bilibili.com" },
			timeoutMs: opts.timeoutMs ?? 5_000,
		}),
		onBody: opts.onBody,
		generation: opts.generation,
	});
}

describe("ApiClient — 响应语义", () => {
	it("JSON 响应自动解析;HTML 响应原文返回(correspond 页场景)", async () => {
		const client = makeClient();
		expect(await client.get(`${baseURL}/echo`)).toEqual({ code: 0 });
		const html = await client.get(`${baseURL}/html`);
		expect(typeof html).toBe("string");
		expect(html).toContain('id="1-name"');
	});

	it("响应 Set-Cookie 落罐(罐子归下面的 HttpClient 管)", async () => {
		const jar = new CookieJar();
		await makeClient(jar).get(`${baseURL}/set`);
		expect(jar.getValue("SESSDATA")).toBe("server_sess");
	});

	it("postForm 以 x-www-form-urlencoded 编码对象,undefined 的字段不发", async () => {
		await makeClient().postForm(`${baseURL}/echo`, {
			csrf: "c&v",
			act: 1,
			skip: undefined,
			on: true,
		});
		expect(lastReq.method).toBe("POST");
		expect(lastReq.headers?.["content-type"]).toContain("application/x-www-form-urlencoded");
		expect(lastReq.body).toBe("csrf=c%26v&act=1&on=true");
	});

	it("303 重定向把 POST 降级为 GET(不重发 body)", async () => {
		await makeClient().postForm(`${baseURL}/see-other`, { a: "1" });
		expect(lastReq.url).toBe("/echo");
		expect(lastReq.method).toBe("GET");
		expect(lastReq.body).toBe("");
	});
});

describe("ApiClient — 失败一律抛(进外层 retry)", () => {
	it("非 2xx 抛错(等价 axios validateStatus,412 风控页进 retry 路径)", async () => {
		await expect(makeClient().get(`${baseURL}/status-412`)).rejects.toThrow(
			/^Request failed with status code 412: GET /,
		);
	});

	it("非 2xx 的响应体不进 onBody,哪怕它是 JSON({code:-101})", async () => {
		const seen: unknown[] = [];
		const client = makeClient(new CookieJar(), { onBody: (b) => seen.push(b) });
		await expect(client.get(`${baseURL}/status-code-body`)).rejects.toThrow(/500/);
		expect(seen).toEqual([]);
	});

	it("错误消息不泄漏 URL query 里的凭据(bili_jct / qrcode_key)", async () => {
		// fetchCookieInfo 等接口把 csrf=bili_jct 拼进 query;非 2xx 时这个 Error 会经
		// onRetry warn + 上层 catch 落日志。错误消息必须只保留路径,绝不带 query。
		const err = await makeClient()
			.get(`${baseURL}/status-412?csrf=SECRET_JCT_TOKEN&qrcode_key=SECRET_QR`)
			.then(
				() => null,
				(e: Error) => e,
			);
		expect(err).toBeInstanceOf(Error);
		expect(err?.message).toMatch(/412/); // 仍能看出失败状态
		expect(err?.message).toContain("/status-412"); // 仍能看出失败端点
		expect(err?.message).not.toContain("SECRET_JCT_TOKEN");
		expect(err?.message).not.toContain("SECRET_QR");
		expect(err?.message).not.toContain("csrf=");
	});

	it("重定向跟满 5 跳还在跳:抛「重定向超过 5 跳」,同样不带 query", async () => {
		const err = await makeClient()
			.get(`${baseURL}/loop?csrf=SECRET_JCT_TOKEN`)
			.then(
				() => null,
				(e: Error) => e,
			);
		expect(err?.message).toMatch(/^重定向超过 5 跳: /);
		expect(err?.message).not.toContain("SECRET_JCT_TOKEN");
		expect(hits).toHaveLength(6);
	});

	it("超时中断挂起的请求(挂死连接不卡刷新链):抛错", async () => {
		const client = makeClient(new CookieJar(), { timeoutMs: 200 });
		await expect(client.get(`${baseURL}/slow`)).rejects.toThrow(/没回/);
	});

	it("连不上:抛错而不是回一个结果对象", async () => {
		const closed = createServer();
		await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
		const { port } = closed.address() as AddressInfo;
		await new Promise<void>((r) => closed.close(() => r()));
		await expect(makeClient().get(`http://127.0.0.1:${port}/x`)).rejects.toThrow(/ECONNREFUSED/);
	});
});

describe("ApiClient — onBody(-101 拦截器挂点)", () => {
	it("对每个 2xx 响应解析后的体触发", async () => {
		const seen: unknown[] = [];
		const client = makeClient(new CookieJar(), { onBody: (b) => seen.push(b) });
		await client.get(`${baseURL}/echo`);
		await client.get(`${baseURL}/html`);
		expect(seen).toEqual([{ code: 0 }, '<html><div id="1-name">refresh_csrf_value</div></html>']);
	});

	// 验红:把取记号挪到请求回来之后(交给 onBody 时现取),第一条红。
	it("记号在**发请求之前**取一次,回应的体交给 onBody 时原样带回:请求在途时记号变了,带回的还是发出去那一刻的", async () => {
		let generation = 1;
		const seen: unknown[] = [];
		const client = makeClient(new CookieJar(), {
			generation: () => generation,
			onBody: (_body, sentIn) => seen.push(sentIn),
		});

		const inFlight = client.get(`${baseURL}/echo`);
		generation = 2;
		await inFlight;
		await client.postForm(`${baseURL}/echo`, {});

		expect(seen).toEqual([1, 2]);
	});

	it("没给取记号的口:onBody 带回的是 undefined", async () => {
		const seen: unknown[] = [];
		const client = makeClient(new CookieJar(), { onBody: (_body, sentIn) => seen.push(sentIn) });
		await client.get(`${baseURL}/echo`);
		expect(seen).toEqual([undefined]);
	});
});

describe("ApiClient — 请求头", () => {
	it("HttpClient 的默认头照常外发,单次请求头最后赢", async () => {
		const client = makeClient();
		await client.get(`${baseURL}/echo`);
		expect(lastReq.headers?.["user-agent"]).toBe("test-ua/1.0");
		expect(lastReq.headers?.origin).toBe("https://www.bilibili.com");

		await client.get(`${baseURL}/echo`, { headers: { "User-Agent": "per-request/3.0" } });
		expect(lastReq.headers?.["user-agent"]).toBe("per-request/3.0");

		await client.postForm(`${baseURL}/echo`, {}, { headers: { "User-Agent": "per-post/4.0" } });
		expect(lastReq.headers?.["user-agent"]).toBe("per-post/4.0");
	});
});

describe("ApiClient.http —— 抓图进图库用的只读窄口", () => {
	// 验红:把 `get http()` 改成回一个新建的 HttpClient,默认头与 cookie 罐两条红。
	it("同一个客户端:带它的默认头与 cookie 罐,非 2xx 不抛、回结果(不是 get 的抛错语义)", async () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("SESSDATA=sess; Path=/", `${baseURL}/`);
		const client = makeClient(jar);

		const response = await client.http.fetch(new URL(`${baseURL}/status-412`), {
			cookies: "send-only",
		});

		expect(response.ok && response.status).toBe(412);
		expect(lastReq.headers?.["user-agent"]).toBe("test-ua/1.0");
		expect(lastReq.headers?.cookie).toContain("SESSDATA=sess");
	});
});

describe("ApiClient.redirectLocation", () => {
	it("只取第一跳的 Location(补成绝对地址),不跟过去", async () => {
		const client = makeClient();
		await expect(client.redirectLocation(`${baseURL}/hop`)).resolves.toBe(`${baseURL}/landing?x=1`);
		expect(hits).toEqual(["GET /hop"]);
	});

	it("没有重定向就是 null", async () => {
		await expect(makeClient().redirectLocation(`${baseURL}/landing`)).resolves.toBeNull();
	});

	it("照常外发罐子的 cookie 与默认头,但不摄入那一跳的 Set-Cookie(与改造前一致)", async () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("SESSDATA=preloaded; Path=/", `${baseURL}/`);
		const client = makeClient(jar);
		await client.redirectLocation(`${baseURL}/hop`);
		expect(lastReq.headers?.cookie).toContain("SESSDATA=preloaded");
		expect(lastReq.headers?.["user-agent"]).toBe("test-ua/1.0");
		expect(jar.getValue("short_cookie")).toBeUndefined();
	});

	it("连不上抛错(与改造前一致),不是 null", async () => {
		const closed = createServer();
		await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
		const { port } = closed.address() as AddressInfo;
		await new Promise<void>((r) => closed.close(() => r()));
		await expect(makeClient().redirectLocation(`http://127.0.0.1:${port}/x`)).rejects.toThrow();
	});
});
