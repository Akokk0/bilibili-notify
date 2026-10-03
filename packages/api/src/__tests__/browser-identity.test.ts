/**
 * BilibiliAPI 的浏览器身份与长期客户端接线(身份的生成与「只升不降」归 packages/http,测在那边)。
 *
 * 观察点是**线上真正发出去的头**:`api.client` 就是 BilibiliAPI 自己持的那个客户端,拿它往回环
 * server 打一个请求,头里有什么就是 B 站会看到的东西(B 站的默认头、生成身份的 UA 与 sec-ch-ua
 * 三件、自定义 UA 的覆盖)。
 *
 * 客户端与 cookie 罐是**长期有效的同一个**:登出再登录(loadCookies / clearCookies)原地换罐子
 * 内容,不重建客户端 —— 在途的请求不会因为换号而拿着旧罐子继续跑。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ApiClient } from "../api-client";
import { BilibiliAPI } from "../bilibili-api";

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

function makeApi(userAgent?: string) {
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	const api = new BilibiliAPI({
		serviceCtx: { logger } as never,
		config: { userAgent },
		callbacks: {},
	});
	const client = (api as unknown as { client: ApiClient }).client;
	return { api, client };
}

const major = (ua: string | undefined) => /Chrome\/(\d+)\./.exec(ua ?? "")?.[1];

describe("BilibiliAPI — 浏览器身份接线", () => {
	it("未配置 UA → 线上是生成身份:UA 与 sec-ch-ua 版本自洽,B 站默认头都在", async () => {
		const { client } = makeApi();
		await client.get(`${baseURL}/x`);
		const ua = lastHeaders["user-agent"] as string;
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
		expect(api.getUserAgent()).toBe(ua);
	});

	it("配置了自定义 UA → 自定义值优先生效,sec-ch-ua 仍是生成身份(现有开关语义不变)", async () => {
		const { client } = makeApi("my-custom-ua/9.9");
		await client.get(`${baseURL}/x`);
		expect(lastHeaders["user-agent"]).toBe("my-custom-ua/9.9");
		expect(lastHeaders["sec-ch-ua"]).toContain('"Google Chrome"');
	});

	it("setUserAgent 热换:后续请求生效;清空 → 回到本实例的生成身份,而非冻结常量", async () => {
		const { api, client } = makeApi();
		const generated = api.getUserAgent();
		api.setUserAgent("  hot-swapped/2.0  ");
		await client.get(`${baseURL}/x`);
		expect(lastHeaders["user-agent"]).toBe("hot-swapped/2.0");
		api.setUserAgent(undefined);
		await client.get(`${baseURL}/x`);
		expect(lastHeaders["user-agent"]).toBe(generated);
		expect(generated).toMatch(/Chrome\/\d+\.0\.0\.0/);
	});
});

describe("BilibiliAPI — 登出再登录:客户端是同一个,罐子里是新内容", () => {
	// 回环地址当 cookie 的域,这样线上也看得到 cookie。
	const session = (sess: string, jct: string) =>
		JSON.stringify([
			{ key: "SESSDATA", value: sess, domain: "127.0.0.1", path: "/", expires: "Infinity" },
			{ key: "bili_jct", value: jct, domain: "127.0.0.1", path: "/", expires: "Infinity" },
		]);
	const jarKeys = (api: BilibiliAPI) =>
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
