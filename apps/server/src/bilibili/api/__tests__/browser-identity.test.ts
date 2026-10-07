/**
 * Api 的浏览器身份与长期客户端接线(身份的生成与「只升不降」归 packages/http,测在那边)。
 *
 * 观察点是**线上真正发出去的头**:`api.client` 就是 Api 自己持的那个客户端,拿它往回环
 * server 打一个请求,头里有什么就是 B 站会看到的东西(B 站的默认头、生成身份的 UA 与 sec-ch-ua
 * 三件)。UA 只来自身份:没有自定义 UA 这个设置、也没有改 UA 的口子(ADR-0025 决策 7)——
 * 填了自定义 UA 而 sec-ch-ua 仍是生成的 Chrome 身份,拼出来是一个自相矛盾的指纹。
 *
 * 客户端与 cookie 罐是**长期有效的同一个**:登出再登录(loadCookies / clearCookies)原地换罐子
 * 内容,不重建客户端 —— 在途的请求不会因为换号而拿着旧罐子继续跑。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Api } from "../api";
import type { ApiClient } from "../api-client";

let server: Server;
let baseURL: string;
let lastHeaders: IncomingMessage["headers"];

beforeEach(async () => {
	lastHeaders = {};
	server = createServer((req, res) => {
		lastHeaders = req.headers;
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ code: 0 }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeApi() {
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	const api = new Api({
		serviceCtx: { logger } as never,
		callbacks: {},
	});
	const client = (api as unknown as { client: ApiClient }).client;
	return { api, client };
}

/** 本实例的生成身份(私有字段;线上所有 UA 的唯一来源)。 */
const identityOf = (api: Api) =>
	(api as unknown as { browserIdentity: { userAgent: string; secChUa: string } }).browserIdentity;

const major = (ua: string | undefined) => /Chrome\/(\d+)\./.exec(ua ?? "")?.[1];

describe("Api — 浏览器身份接线", () => {
	it("线上是生成身份:UA 与 sec-ch-ua 版本自洽,B 站默认头都在", async () => {
		const { api, client } = makeApi();
		await client.get(`${baseURL}/x`);
		const ua = lastHeaders["user-agent"] as string;
		expect(ua).toBe(identityOf(api).userAgent);
		expect(lastHeaders["sec-ch-ua"]).toBe(identityOf(api).secChUa);
		expect(major(ua)).toBeDefined();
		expect(lastHeaders["sec-ch-ua"]).toContain(`"Google Chrome";v="${major(ua)}"`);
		expect(lastHeaders["sec-ch-ua-mobile"]).toBe("?0");
		expect(lastHeaders["sec-ch-ua-platform"]).toBe('"Linux"');
		expect(lastHeaders.accept).toBe("application/json, text/plain, */*");
		expect(lastHeaders.origin).toBe("https://www.bilibili.com");
		expect(lastHeaders.referer).toBe("https://www.bilibili.com/");
		expect(lastHeaders.priority).toBe("u=1, i");
		expect(lastHeaders["sec-fetch-dest"]).toBe("empty");
		expect(lastHeaders["sec-fetch-mode"]).toBe("cors");
		expect(lastHeaders["sec-fetch-site"]).toBe("same-site");
	});

	it("身份随实例稳定:换号、登出、再登录之后线上的 UA 一直是同一个", async () => {
		const { api, client } = makeApi();
		await client.get(`${baseURL}/x`);
		const ua = lastHeaders["user-agent"];
		await api.loadCookies({ cookiesJson: "[]" });
		await api.clearCookies();
		await client.get(`${baseURL}/x`);
		expect(lastHeaders["user-agent"]).toBe(ua);
		expect(ua).toBe(identityOf(api).userAgent);
	});

	// 自定义 UA 删了:这两个口子是它仅有的入口(设置里填的值经它们改 UA)。口子还在,谁都能再把 UA 和身份拆开。
	it("没有改 UA 的口子:Api 上没有 setUserAgent / getUserAgent", () => {
		const { api } = makeApi();

		expect("setUserAgent" in api).toBe(false);
		expect("getUserAgent" in api).toBe(false);
	});
});

describe("Api — 每一条出站请求的 UA 都是身份的那一个", () => {
	const update = (api: Api) =>
		(api as unknown as { updateBiliTicket(): Promise<void> }).updateBiliTicket();

	it("取 ticket 的 POST 没有自己的 UA 特例:不带逐请求的 UA 覆盖,走客户端默认头(身份的)", async () => {
		const { api } = makeApi();
		const seen: Array<Record<string, string> | undefined> = [];
		(api as unknown as { client: { postForm: unknown } }).client.postForm = async (
			_url: string,
			_body: unknown,
			opts?: { headers?: Record<string, string> },
		) => {
			seen.push(opts?.headers);
			return { code: 0, data: { nav: { img: "https://x/a.png", sub: "https://x/b.png" } } };
		};

		await update(api);

		expect(seen).toHaveLength(1);
		expect(Object.keys(seen[0] ?? {}).map((name) => name.toLowerCase())).not.toContain(
			"user-agent",
		);
	});

	// ticket 的地址是写死的 B 站域名,回环 server 接不到它 —— 在全局 fetch 这一层看真正交出去的头。
	it("取 ticket 的 POST 与普通 GET 发出去的 UA 一模一样,都是身份的", async () => {
		const { api, client } = makeApi();
		const sent: Array<{ url: string; ua: string | null }> = [];
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			sent.push({
				url: String(input),
				ua: new Headers(init?.headers).get("user-agent"),
			});
			return new Response(
				JSON.stringify({
					code: 0,
					data: { nav: { img: "https://x/a.png", sub: "https://x/b.png" } },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		try {
			await client.get("https://example.test/x");
			await update(api);
		} finally {
			spy.mockRestore();
		}

		expect(sent).toHaveLength(2);
		expect(sent[1]?.url).toContain("GenWebTicket");
		expect(sent.map((request) => request.ua)).toEqual([
			identityOf(api).userAgent,
			identityOf(api).userAgent,
		]);
	});
});

describe("Api — 登出再登录:客户端是同一个,罐子里是新内容", () => {
	// 回环地址当 cookie 的域,这样线上也看得到 cookie。
	const session = (sess: string, jct: string) =>
		JSON.stringify([
			{ key: "SESSDATA", value: sess, domain: "127.0.0.1", path: "/", expires: "Infinity" },
			{ key: "bili_jct", value: jct, domain: "127.0.0.1", path: "/", expires: "Infinity" },
		]);
	const jarKeys = (api: Api) =>
		(JSON.parse(api.getCookiesJson() ?? "[]") as Array<{ key: string; value: string }>).map(
			(c) => `${c.key}=${c.value}`,
		);

	it("loadCookies → clearCookies → loadCookies:同一个客户端实例,线上与罐里都只有新会话", async () => {
		const { api, client } = makeApi();
		const clientAtStart = (api as unknown as { client: ApiClient }).client;

		await api.loadCookies({ cookiesJson: session("sess_A", "jct_A") });
		await client.get(`${baseURL}/x`);
		expect(lastHeaders.cookie).toContain("SESSDATA=sess_A");

		await api.clearCookies();
		expect(jarKeys(api)).toEqual([]);
		await client.get(`${baseURL}/x`);
		expect(lastHeaders.cookie).toBeUndefined();

		await api.loadCookies({ cookiesJson: session("sess_B", "jct_B") });
		expect((api as unknown as { client: ApiClient }).client).toBe(clientAtStart);
		expect(client).toBe(clientAtStart);
		expect(jarKeys(api)).toEqual([
			"SESSDATA=sess_B",
			"bili_jct=jct_B",
			"buvid3=some_non_empty_value",
		]);
		await client.get(`${baseURL}/x`);
		expect(lastHeaders.cookie).toContain("SESSDATA=sess_B");
		expect(lastHeaders.cookie).not.toContain("sess_A");
	});

	it("不经登出直接换号(重新扫码):上一个号的 cookie 一条都不残留", async () => {
		const { api, client } = makeApi();
		await api.loadCookies({ cookiesJson: session("sess_A", "jct_A") });
		await api.loadCookies({ cookiesJson: session("sess_B", "jct_B") });
		expect(jarKeys(api).join(";")).not.toContain("_A");
		await client.get(`${baseURL}/x`);
		expect(lastHeaders.cookie).not.toContain("sess_A");
		expect(lastHeaders.cookie).not.toContain("jct_A");
	});

	it("有 bili_jct 时补的 buvid3 与盘上的 cookie 同在一罐(分两次 load 会抹掉前一批)", async () => {
		const { api } = makeApi();
		await api.loadCookies({ cookiesJson: session("sess_A", "jct_A") });
		expect(jarKeys(api)).toContain("SESSDATA=sess_A");
		expect(jarKeys(api)).toContain("buvid3=some_non_empty_value");
	});

	it("-101 终态清理(terminateSession)清的是同一只罐子,客户端不换", async () => {
		const { api, client } = makeApi();
		await api.loadCookies({ cookiesJson: session("sess_A", "jct_A") });
		await (api as unknown as { terminateSession(msg: string): Promise<void> }).terminateSession(
			"test",
		);
		expect(jarKeys(api)).toEqual([]);
		expect((api as unknown as { client: ApiClient }).client).toBe(client);
		await client.get(`${baseURL}/x`);
		expect(lastHeaders.cookie).toBeUndefined();
	});
});
