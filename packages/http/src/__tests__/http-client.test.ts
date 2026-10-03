/**
 * HttpClient(fetch 传输层)契约 —— 通用底座,不带任何平台的默认值。
 *
 * 用回环 HTTP server 钉住的不变量(前几条是搬来的、原本钉 B 站流真正依赖的行为):
 *  1. 请求自动带上罐子里的 Cookie;响应 Set-Cookie 自动落罐并随后续请求外发;
 *  2. **重定向逐跳收 Set-Cookie**(fetch `redirect:"follow"` 会吞中间跳的 Set-Cookie ——
 *     登录 / 刷新链在 302 上发 cookie,必须手动跟随);303 与 POST+30x 降成 GET 并剥掉 Content-Type;
 *  3. **非 2xx 不抛**,状态码交给调用方判;网络断、超时、被中止、被否决都回结果形状,不抛;
 *  4. 头的优先级:身份 < 客户端默认头 < 每次请求的头,大小写不敏感;包里不带任何平台的默认头;
 *  5. 换了登录态(罐子 load / clear)之后才回来的响应,它的 Set-Cookie 不写进新罐子。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo, createServer as createNetServer, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { BrowserIdentity } from "../browser-identity";
import { CookieJar } from "../cookie-jar";
import { type Hop, HttpClient, type HttpClientOptions } from "../http-client";

const IDENTITY: BrowserIdentity = {
	userAgent: "identity-ua/1.0",
	secChUa: '"Fixture";v="1"',
	secChUaMobile: "?0",
	secChUaPlatform: '"Fixture"',
};

const BYTES = Uint8Array.from([0x00, 0xff, 0x10, 0x80, 0x41]);

let server: Server;
let baseURL: string;
let hits: string[];
let lastReq: {
	url?: string;
	method?: string;
	cookie?: string;
	headers?: IncomingMessage["headers"];
	body?: string;
};
let releaseGate: () => void;
let gate: Promise<void>;

beforeEach(async () => {
	hits = [];
	lastReq = {};
	gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			hits.push(`${req.method} ${req.url}`);
			lastReq = {
				url: req.url,
				method: req.method,
				cookie: req.headers.cookie,
				headers: req.headers,
				body,
			};
			const path = req.url?.split("?")[0];
			if (path === "/set") {
				res.setHeader("Set-Cookie", ["SESSDATA=server_sess; Path=/", "csrf=server_csrf; Path=/"]);
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ code: 0 }));
			} else if (path === "/redirect-start") {
				// 中间跳发 Set-Cookie —— fetch follow 模式会吞掉的场景
				res.setHeader("Set-Cookie", "hop_cookie=hop1; Path=/");
				res.statusCode = 302;
				res.setHeader("Location", "/redirect-target");
				res.end();
			} else if (path === "/redirect-target") {
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ code: 0, echoedCookie: req.headers.cookie ?? "" }));
			} else if (path === "/see-other") {
				res.statusCode = 303;
				res.setHeader("Location", "/redirect-target");
				res.end();
			} else if (path === "/temporary") {
				res.statusCode = 307;
				res.setHeader("Location", "/redirect-target");
				res.end();
			} else if (path === "/found") {
				res.statusCode = 302;
				res.setHeader("Location", "/redirect-target");
				res.end();
			} else if (path === "/loop") {
				res.statusCode = 302;
				res.setHeader("Location", "/loop");
				res.end();
			} else if (path === "/no-location") {
				res.statusCode = 302;
				res.end("moved, no Location");
			} else if (path === "/to-ftp") {
				res.statusCode = 302;
				res.setHeader("Location", "ftp://files.example/x");
				res.end();
			} else if (path === "/bad-location") {
				res.statusCode = 302;
				res.setHeader("Location", "http://[");
				res.end();
			} else if (path === "/html") {
				res.setHeader("Content-Type", "text/html");
				res.end('<html><div id="1-name">refresh_csrf_value</div></html>');
			} else if (path === "/bytes") {
				res.setHeader("Content-Type", "application/octet-stream");
				res.setHeader("X-Test", "yes");
				res.end(Buffer.from(BYTES));
			} else if (path === "/status-412") {
				res.statusCode = 412;
				res.setHeader("Content-Type", "text/html");
				res.end("risk banned");
			} else if (path === "/slow") {
				// 故意不回应 —— 超时 / 中止用
			} else if (path === "/gated-set") {
				// 等闸门开了才回,回的是上一个会话的 Set-Cookie —— 迟到响应用
				void gate.then(() => {
					res.setHeader("Set-Cookie", "SESSDATA=stale_session; Path=/");
					res.end("late");
				});
			} else if (path === "/cut-off") {
				// 头发出去、body 只给一半就掐线
				res.writeHead(200, { "Content-Length": "100" });
				res.write("0123456789");
				setTimeout(() => res.socket?.destroy(), 20);
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
	releaseGate();
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(
	jar = new CookieJar(),
	opts: Partial<Pick<HttpClientOptions, "headers" | "timeoutMs">> = {},
) {
	return new HttpClient({ jar, identity: IDENTITY, timeoutMs: opts.timeoutMs ?? 5_000, ...opts });
}

describe("HttpClient.fetch — 响应:状态码、响应头、原始字节", () => {
	it("回最终地址、状态码、响应头和原始字节(不做任何解码),文本与 JSON 现转", async () => {
		const res = await makeClient().fetch(`${baseURL}/bytes`);
		if (!res.ok) throw new Error(res.message);
		expect(res.url).toBe(`${baseURL}/bytes`);
		expect(res.status).toBe(200);
		expect(res.isSuccess).toBe(true);
		expect(res.headers.get("x-test")).toBe("yes");
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(Array.from(res.body)).toEqual(Array.from(BYTES));
	});

	it("text() 按 UTF-8 转;json() 回结果形状:合法 JSON 给 value,不是 JSON 回 invalid、不抛", async () => {
		const client = makeClient();
		const json = await client.fetch(`${baseURL}/echo`);
		if (!json.ok) throw new Error(json.message);
		expect(json.text()).toBe('{"code":0}');
		const parsed = json.json();
		expect(parsed).toEqual({ ok: true, value: { code: 0 } });

		const html = await client.fetch(`${baseURL}/html`);
		if (!html.ok) throw new Error(html.message);
		expect(html.text()).toContain('id="1-name"');
		const bad = html.json();
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.code).toBe("invalid");
	});

	it("跟过重定向后,url 是最后落脚的那个地址", async () => {
		const res = await makeClient().fetch(`${baseURL}/redirect-start?x=1`);
		if (!res.ok) throw new Error(res.message);
		expect(res.url).toBe(`${baseURL}/redirect-target`);
	});

	it("非 2xx 不抛:回结果形状里的 status,body 照读,isSuccess 为 false", async () => {
		const res = await makeClient().fetch(`${baseURL}/status-412`);
		if (!res.ok) throw new Error(res.message);
		expect(res.status).toBe(412);
		expect(res.isSuccess).toBe(false);
		expect(res.text()).toBe("risk banned");
	});
});

describe("HttpClient.fetch — cookie 收发管线", () => {
	it("请求自动带上罐子的 Cookie", async () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("SESSDATA=preloaded; Path=/", `${baseURL}/`);
		await makeClient(jar).fetch(`${baseURL}/echo`);
		expect(lastReq.cookie).toContain("SESSDATA=preloaded");
	});

	it("响应 Set-Cookie 落罐,并随后续请求外发", async () => {
		const jar = new CookieJar();
		const client = makeClient(jar);
		await client.fetch(`${baseURL}/set`);
		expect(jar.getValue("SESSDATA")).toBe("server_sess");
		expect(jar.getValue("csrf")).toBe("server_csrf");
		await client.fetch(`${baseURL}/echo`);
		expect(lastReq.cookie).toContain("SESSDATA=server_sess");
		expect(lastReq.cookie).toContain("csrf=server_csrf");
	});

	it("换一只罐子,旧罐子的 cookie 绝不外发", async () => {
		const oldJar = new CookieJar();
		oldJar.setFromSetCookie("SESSDATA=stale_old; Path=/", `${baseURL}/`);
		await makeClient(oldJar).fetch(`${baseURL}/echo`);
		expect(lastReq.cookie).toContain("stale_old");

		const newJar = new CookieJar();
		newJar.setFromSetCookie("SESSDATA=fresh_new; Path=/", `${baseURL}/`);
		await makeClient(newJar).fetch(`${baseURL}/echo`);
		expect(lastReq.cookie).toContain("fresh_new");
		expect(lastReq.cookie).not.toContain("stale_old");
	});

	it("同一个客户端、罐子原地 clear 再 load:之后的请求只带新内容", async () => {
		const jar = new CookieJar();
		const client = makeClient(jar);
		jar.load([{ key: "SESSDATA", value: "first", domain: "127.0.0.1", path: "/" }]);
		await client.fetch(`${baseURL}/echo`);
		expect(lastReq.cookie).toBe("SESSDATA=first");
		jar.clear();
		await client.fetch(`${baseURL}/echo`);
		expect(lastReq.cookie).toBeUndefined();
		jar.load([{ key: "SESSDATA", value: "second", domain: "127.0.0.1", path: "/" }]);
		await client.fetch(`${baseURL}/echo`);
		expect(lastReq.cookie).toBe("SESSDATA=second");
	});

	it("重定向逐跳收 Set-Cookie,且带着新 cookie 跟到目标", async () => {
		const jar = new CookieJar();
		const res = await makeClient(jar).fetch(`${baseURL}/redirect-start`);
		if (!res.ok) throw new Error(res.message);
		expect(jar.getValue("hop_cookie")).toBe("hop1");
		const echoed = res.json();
		if (!echoed.ok) throw new Error(echoed.message);
		expect((echoed.value as { echoedCookie: string }).echoedCookie).toContain("hop_cookie=hop1");
	});

	it('cookies: "send-only" 照常外发罐子的 cookie,但不把响应的 Set-Cookie 写进罐子', async () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("SESSDATA=preloaded; Path=/", `${baseURL}/`);
		await makeClient(jar).fetch(`${baseURL}/redirect-start`, { cookies: "send-only" });
		expect(lastReq.cookie).toContain("SESSDATA=preloaded");
		expect(jar.getValue("hop_cookie")).toBeUndefined();
	});

	it("🔴 迟到的响应:发出之后罐子被 load / clear 换过,它的 Set-Cookie 不写进新罐子", async () => {
		const jar = new CookieJar();
		const client = makeClient(jar);
		jar.load([{ key: "SESSDATA", value: "old_session", domain: "127.0.0.1", path: "/" }]);
		const inFlight = client.fetch(`${baseURL}/gated-set`);
		await waitUntil(() => hits.includes("GET /gated-set"));
		jar.clear();
		jar.load([{ key: "SESSDATA", value: "new_session", domain: "127.0.0.1", path: "/" }]);
		releaseGate();
		const res = await inFlight;
		expect(res.ok).toBe(true);
		expect(jar.getValue("SESSDATA")).toBe("new_session");
		expect(jar.serialize().map((c) => c.value)).toEqual(["new_session"]);
	});
});

describe("HttpClient.fetch — 请求头", () => {
	it("身份的四个头随每个请求外发", async () => {
		await makeClient().fetch(`${baseURL}/echo`);
		expect(lastReq.headers?.["user-agent"]).toBe("identity-ua/1.0");
		expect(lastReq.headers?.["sec-ch-ua"]).toBe('"Fixture";v="1"');
		expect(lastReq.headers?.["sec-ch-ua-mobile"]).toBe("?0");
		expect(lastReq.headers?.["sec-ch-ua-platform"]).toBe('"Fixture"');
	});

	it("包里没有任何平台的默认头:没交进来的 Origin / Referer / priority 就不发", async () => {
		await makeClient().fetch(`${baseURL}/echo`);
		expect(lastReq.headers?.origin).toBeUndefined();
		expect(lastReq.headers?.referer).toBeUndefined();
		expect(lastReq.headers?.priority).toBeUndefined();
		expect(lastReq.headers?.["sec-fetch-dest"]).toBeUndefined();
	});

	it("优先级:身份 < 客户端默认头 < 每次请求的头;大小写不敏感,线上只有一个值", async () => {
		const client = makeClient(new CookieJar(), {
			headers: { Origin: "https://default.example", "user-agent": "default-ua/2.0" },
		});
		await client.fetch(`${baseURL}/echo`);
		expect(lastReq.headers?.origin).toBe("https://default.example");
		expect(lastReq.headers?.["user-agent"]).toBe("default-ua/2.0");
		expect(lastReq.headers?.["sec-ch-ua"]).toBe('"Fixture";v="1"');

		await client.fetch(`${baseURL}/echo`, { headers: { "User-Agent": "per-call-ua/3.0" } });
		expect(lastReq.headers?.["user-agent"]).toBe("per-call-ua/3.0");
		expect(lastReq.headers?.origin).toBe("https://default.example");

		await client.fetch(`${baseURL}/echo`, {
			headers: new Headers({ origin: "https://call.example" }),
		});
		expect(lastReq.headers?.origin).toBe("https://call.example");
	});
});

describe("HttpClient.fetch — 线上头序(裸 TCP 收原始请求)", () => {
	/** 收一个原始请求头(不经 Node 解析),回我们关心的那几个名字,原样大小写与顺序。 */
	async function rawHeaderNames(
		run: (url: string) => Promise<unknown>,
		ours: string[],
	): Promise<string[]> {
		const raw = createNetServer();
		const heads: string[][] = [];
		const sockets = new Set<Socket>();
		raw.on("connection", (sock) => {
			sockets.add(sock);
			let buf = "";
			sock.on("data", (d) => {
				buf += d.toString("latin1");
				const end = buf.indexOf("\r\n\r\n");
				if (end < 0) return;
				heads.push(buf.slice(0, end).split("\r\n").slice(1));
				sock.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
			});
		});
		await new Promise<void>((r) => raw.listen(0, "127.0.0.1", r));
		try {
			await run(`http://127.0.0.1:${(raw.address() as AddressInfo).port}/x`);
		} finally {
			for (const sock of sockets) sock.destroy();
			await new Promise<void>((r) => raw.close(() => r()));
		}
		const wanted = new Set(ours.map((n) => n.toLowerCase()));
		return (heads[0] ?? [])
			.map((line) => line.slice(0, line.indexOf(":")))
			.filter((n) => wanted.has(n.toLowerCase()));
	}
	const OURS = [
		"Accept",
		"Origin",
		"X-Extra",
		"User-Agent",
		"sec-ch-ua",
		"sec-ch-ua-mobile",
		"sec-ch-ua-platform",
		"Cookie",
	];

	it("没写身份头的调用方:默认头、这次的头,然后才是补上的身份四件,最后 Cookie", async () => {
		const jar = new CookieJar();
		jar.load([{ key: "k", value: "v", domain: "127.0.0.1", path: "/" }]);
		const names = await rawHeaderNames(
			(url) =>
				makeClient(jar, { headers: { Accept: "x", Origin: "o" } }).fetch(url, {
					headers: { "X-Extra": "1" },
				}),
			OURS,
		);
		expect(names).toEqual([
			"Accept",
			"Origin",
			"X-Extra",
			"User-Agent",
			"sec-ch-ua",
			"sec-ch-ua-mobile",
			"sec-ch-ua-platform",
			"Cookie",
		]);
	});

	it("调用方把身份头写在自己想要的位置:头序与大小写原样保住,不重复补", async () => {
		const names = await rawHeaderNames(
			(url) =>
				makeClient(new CookieJar(), {
					headers: {
						Accept: "x",
						"User-Agent": "mine/1.0",
						Origin: "o",
						"sec-ch-ua": "q",
						"sec-ch-ua-mobile": "?1",
						"sec-ch-ua-platform": '"P"',
					},
				}).fetch(url),
			OURS,
		);
		expect(names).toEqual([
			"Accept",
			"User-Agent",
			"Origin",
			"sec-ch-ua",
			"sec-ch-ua-mobile",
			"sec-ch-ua-platform",
		]);
	});
});

describe("HttpClient.fetch — 方法与 body、重定向的降级", () => {
	it("POST 带字符串或字节 body,Content-Type 由调用方的头给", async () => {
		const client = makeClient();
		await client.fetch(`${baseURL}/echo`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "csrf=c%26v&act=1",
		});
		expect(lastReq.method).toBe("POST");
		expect(lastReq.headers?.["content-type"]).toBe("application/x-www-form-urlencoded");
		expect(lastReq.body).toBe("csrf=c%26v&act=1");

		await client.fetch(`${baseURL}/echo`, {
			method: "POST",
			body: new TextEncoder().encode("raw"),
		});
		expect(lastReq.body).toBe("raw");
	});

	it("请求头的值不合法(带换行):回 invalid,不抛、不发", async () => {
		const res = await makeClient().fetch(`${baseURL}/echo`, { headers: { "X-Bad": "a\nb" } });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("invalid");
		expect(hits).toEqual([]);
	});

	it("GET / HEAD 带 body:回 invalid,一个请求都不发", async () => {
		const res = await makeClient().fetch(`${baseURL}/echo`, { body: "x" });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("invalid");
		expect(hits).toEqual([]);
	});

	it("303 把 POST 降成 GET:不重发 body,Content-Type 也剥掉", async () => {
		await makeClient().fetch(`${baseURL}/see-other`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "a=1",
		});
		expect(lastReq.url).toBe("/redirect-target");
		expect(lastReq.method).toBe("GET");
		expect(lastReq.body).toBe("");
		expect(lastReq.headers?.["content-type"]).toBeUndefined();
	});

	it("302 上的 POST 同样降成 GET", async () => {
		await makeClient().fetch(`${baseURL}/found`, { method: "POST", body: "a=1" });
		expect(lastReq.method).toBe("GET");
		expect(lastReq.body).toBe("");
	});

	it("307 保持方法与 body", async () => {
		await makeClient().fetch(`${baseURL}/temporary`, {
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			body: "keep-me",
		});
		expect(lastReq.url).toBe("/redirect-target");
		expect(lastReq.method).toBe("POST");
		expect(lastReq.body).toBe("keep-me");
		expect(lastReq.headers?.["content-type"]).toBe("text/plain");
	});
});

describe("HttpClient.fetch — 重定向的跳数", () => {
	it("maxRedirects: 0 不跟:3xx 原样回,带 Location,只发一个请求", async () => {
		const res = await makeClient().fetch(`${baseURL}/redirect-start`, { maxRedirects: 0 });
		if (!res.ok) throw new Error(res.message);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/redirect-target");
		expect(res.url).toBe(`${baseURL}/redirect-start`);
		expect(hits).toEqual(["GET /redirect-start"]);
	});

	it("跟满跳数还在 30x:不造失败码,把那个 3xx 当响应原样回,Set-Cookie 照收", async () => {
		const jar = new CookieJar();
		const res = await makeClient(jar).fetch(`${baseURL}/loop`, { maxRedirects: 2 });
		if (!res.ok) throw new Error(res.message);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/loop");
		expect(hits).toEqual(["GET /loop", "GET /loop", "GET /loop"]);
	});

	it("默认最多跟 5 跳:死循环共发 6 个请求就停", async () => {
		const res = await makeClient().fetch(`${baseURL}/loop`);
		if (!res.ok) throw new Error(res.message);
		expect(res.status).toBe(302);
		expect(hits).toHaveLength(6);
	});

	it("30x 没带 Location:没处可跟,当普通响应原样回", async () => {
		const res = await makeClient().fetch(`${baseURL}/no-location`);
		if (!res.ok) throw new Error(res.message);
		expect(res.status).toBe(302);
		expect(res.text()).toBe("moved, no Location");
		expect(hits).toEqual(["GET /no-location"]);
	});

	it("重定向到不是 http(s) 的地址:回 invalid,不去连", async () => {
		const res = await makeClient().fetch(`${baseURL}/to-ftp`);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("invalid");
		expect(hits).toEqual(["GET /to-ftp"]);
	});

	it("Location 不是合法地址:回 unavailable(对端的毛病),不抛", async () => {
		const res = await makeClient().fetch(`${baseURL}/bad-location`);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("unavailable");
	});
});

describe("HttpClient.fetch — 每跳之前的检查回调(可否决)", () => {
	it("每跳之前都调:第一次请求是第 0 跳,之后每跟一次重定向加一,带上一跳的地址与状态码", async () => {
		const seen: Array<{ url: string; index: number; from?: { url: string; status: number } }> = [];
		const res = await makeClient().fetch(`${baseURL}/redirect-start`, {
			beforeHop: (hop: Hop) => {
				seen.push({
					url: hop.url.href,
					index: hop.index,
					from: hop.from && { url: hop.from.url.href, status: hop.from.status },
				});
				return { ok: true };
			},
		});
		expect(res.ok).toBe(true);
		expect(seen).toEqual([
			{ url: `${baseURL}/redirect-start`, index: 0 },
			{
				url: `${baseURL}/redirect-target`,
				index: 1,
				from: { url: `${baseURL}/redirect-start`, status: 302 },
			},
		]);
	});

	it("否决某一跳:回调给的失败原样回,那一跳根本没发;前一跳的 Set-Cookie 已经收了", async () => {
		const jar = new CookieJar();
		const res = await makeClient(jar).fetch(`${baseURL}/redirect-start`, {
			beforeHop: (hop) =>
				hop.index === 1 ? { ok: false, code: "invalid", message: "不许去内网" } : { ok: true },
		});
		expect(res).toEqual({ ok: false, code: "invalid", message: "不许去内网" });
		expect(hits).toEqual(["GET /redirect-start"]);
		expect(jar.getValue("hop_cookie")).toBe("hop1");
	});

	it("否决第 0 跳:一个请求都不发;回调可以是异步的", async () => {
		const res = await makeClient().fetch(`${baseURL}/echo`, {
			beforeHop: async () => ({ ok: false, code: "invalid", message: "地址不行" }),
		});
		expect(res).toEqual({ ok: false, code: "invalid", message: "地址不行" });
		expect(hits).toEqual([]);
	});
});

describe("HttpClient.fetch — 失败回结果形状,不抛", () => {
	it("超时:挂起的请求回 timeout(按跳算),单次请求可以覆盖默认超时", async () => {
		const client = makeClient(new CookieJar(), { timeoutMs: 5_000 });
		const res = await client.fetch(`${baseURL}/slow`, { timeoutMs: 150 });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("timeout");

		const short = await makeClient(new CookieJar(), { timeoutMs: 150 }).fetch(`${baseURL}/slow`);
		expect(short.ok).toBe(false);
		if (!short.ok) expect(short.code).toBe("timeout");
	});

	it("网络断(连不上):回 unavailable,message 里有底层原因,不抛", async () => {
		const closed = createServer();
		await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
		const { port } = closed.address() as AddressInfo;
		await new Promise<void>((r) => closed.close(() => r()));
		const res = await makeClient().fetch(`http://127.0.0.1:${port}/x?token=SECRET_TOKEN`);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.code).toBe("unavailable");
			expect(res.message).toContain("ECONNREFUSED");
			expect(res.message).not.toContain("SECRET_TOKEN");
		}
	});

	it("body 读到一半断线:同样是 unavailable", async () => {
		const res = await makeClient().fetch(`${baseURL}/cut-off`);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("unavailable");
	});

	it("调用方的 signal 中止在途请求:回 indeterminate(结果不明),不抛", async () => {
		const controller = new AbortController();
		const pending = makeClient().fetch(`${baseURL}/slow`, { signal: controller.signal });
		await waitUntil(() => hits.includes("GET /slow"));
		controller.abort(new DOMException("停用了", "AbortError"));
		const res = await pending;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("indeterminate");
	});

	it("signal 发请求之前就已中止:一个请求都不发", async () => {
		const res = await makeClient().fetch(`${baseURL}/echo`, { signal: AbortSignal.abort() });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("indeterminate");
		expect(hits).toEqual([]);
	});

	it("signal 的中止原因是 TimeoutError(调用方自己用了 AbortSignal.timeout):算 timeout", async () => {
		const res = await makeClient().fetch(`${baseURL}/slow`, { signal: AbortSignal.timeout(100) });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("timeout");
	});

	it("地址不合法、不是 http(s):回 invalid,message 不带 query", async () => {
		const bad = await makeClient().fetch("not a url?token=SECRET_TOKEN");
		expect(bad.ok).toBe(false);
		if (!bad.ok) {
			expect(bad.code).toBe("invalid");
			expect(bad.message).not.toContain("SECRET_TOKEN");
		}
		const scheme = await makeClient().fetch("file:///etc/hosts");
		expect(scheme.ok).toBe(false);
		if (!scheme.ok) expect(scheme.code).toBe("invalid");
	});

	it("失败的 message 不泄漏 query 里的凭据(超时那一支)", async () => {
		const res = await makeClient().fetch(`${baseURL}/slow?csrf=SECRET_JCT&qrcode_key=SECRET_QR`, {
			timeoutMs: 100,
		});
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.message).toContain("/slow");
			expect(res.message).not.toContain("SECRET_JCT");
			expect(res.message).not.toContain("csrf=");
		}
	});
});

/** 轮询等一个条件成立(不用 waitFor,不依赖假定时器)。 */
async function waitUntil(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("等条件超时");
		await new Promise((r) => setTimeout(r, 5));
	}
}
