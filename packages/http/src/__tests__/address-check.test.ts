/**
 * `FetchOptions.addressCheck` 与 `maxBodyBytes` —— 抓图那一层要的两样(ADR-0025 决策 8):拦内网、响应体封顶。
 *
 * 判定挂在**真正建连接用的那一次解析**上(守卫连接函数):名字自己解析、解析出来的每个地址都判、连的就是判过的
 * 那一个;URL 里直接写 IP 字面量的不经解析当场判。重定向的每一跳、每一条新连接都经过同一个判定点,所以没有
 * 「检查时一个地址、连接时另一个」的 DNS 重绑定窗口。
 *
 * 全部用回环假服务 + 注入的解析表:假名字解析到哪由测试说了算,真 DNS 一次不查。回环本身算内网,所以正向用例
 * 注入一个放行回环的判定;被拒的用例要是真去连了(10.0.0.1 之类),测试的拦外网守卫会把这条判红。
 *
 * 不给 `addressCheck` 的请求走的还是原来那条路,线上一个字节不变 —— 那一半由 `http-client.test.ts` 与
 * `apps/server/src/bilibili/api` 的头序测试原样钉着。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ok, type Result } from "@bilibili-notify/internal/constants";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { BrowserIdentity } from "../browser-identity";
import { CookieJar } from "../cookie-jar";
import { HttpClient } from "../http-client";
import { requirePublicAddress } from "../public-address";

const IDENTITY: BrowserIdentity = {
	userAgent: "identity-ua/1.0",
	secChUa: '"Fixture";v="1"',
	secChUaMobile: "?0",
	secChUaPlatform: '"Fixture"',
};

/** 测试用的判定:回环放行(假服务就在回环上),其余照生产的规矩。 */
const loopbackAllowed = (address: string): Result =>
	address.startsWith("127.") ? ok() : requirePublicAddress(address);

let server: Server;
let port: number;
let hits: string[];
let rawHeaderNames: string[];
/** 假服务这一头看到的「连接被对端掐断」。 */
let abortedByPeer: Promise<void>;
/** 解析表:名字 → 每次解析依次回的地址组(用完了就一直回最后一组)。 */
let table: Record<string, string[][]>;
let lookups: string[];
let clients: HttpClient[];

beforeEach(async () => {
	hits = [];
	rawHeaderNames = [];
	lookups = [];
	clients = [];
	table = {
		"good.test": [["127.0.0.1"]],
		"evil.test": [["10.0.0.1"]],
		"mixed.test": [["127.0.0.1", "10.0.0.1"]],
		"dual.test": [["::1", "127.0.0.1"]],
		"rebind.test": [["127.0.0.1"], ["10.0.0.1"]],
	};
	let markAborted: () => void = () => {};
	abortedByPeer = new Promise<void>((resolve) => {
		markAborted = resolve;
	});
	server = createServer((req: IncomingMessage, res) => {
		hits.push(`${req.method} ${req.headers.host} ${req.url}`);
		rawHeaderNames = req.rawHeaders.filter((_, i) => i % 2 === 0);
		const path = req.url ?? "/";
		if (path === "/to-internal-name") {
			res.writeHead(302, { location: `http://evil.test:${port}/secret` }).end();
		} else if (path === "/to-internal-literal") {
			res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
		} else if (path === "/to-good") {
			res.writeHead(302, { location: `http://good.test:${port}/ok` }).end();
		} else if (path === "/cookie") {
			res.setHeader("Set-Cookie", ["a=1; Path=/", "b=2; Path=/"]);
			res.setHeader("X-Test", "yes");
			res.end("ok");
		} else if (path.startsWith("/sized/")) {
			// 带 Content-Length 的定长体。
			res.end(Buffer.alloc(Number(path.slice("/sized/".length)), 7));
		} else if (path === "/endless") {
			// 不带 Content-Length、不肯停的流。
			res.writeHead(200, { "content-type": "application/octet-stream" });
			const chunk = Buffer.alloc(16 * 1024, 7);
			const timer = setInterval(() => res.write(chunk), 1);
			res.on("close", () => {
				clearInterval(timer);
				markAborted();
			});
		} else if (path === "/hang") {
			// 永远不回。
		} else {
			res.end("ok");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
	await Promise.all(clients.map((client) => client.dispose()));
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function lookup(hostname: string): Promise<string[]> {
	lookups.push(hostname);
	const answers = table[hostname];
	if (!answers) {
		throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
	}
	const nth = lookups.filter((name) => name === hostname).length - 1;
	return answers[Math.min(nth, answers.length - 1)] ?? [];
}

function makeClient(over: { jar?: CookieJar; timeoutMs?: number } = {}): HttpClient {
	const client = new HttpClient({
		jar: over.jar ?? new CookieJar(),
		identity: IDENTITY,
		timeoutMs: over.timeoutMs ?? 5_000,
		lookup,
	});
	clients.push(client);
	return client;
}

const url = (host: string, path = "/ok") => `http://${host}:${port}${path}`;

describe("addressCheck — 判的是建连接用的那一次解析", () => {
	it("名字解析到放行的地址:连上,请求里的 Host 还是原来的名字", async () => {
		const res = await makeClient().fetch(url("good.test"), { addressCheck: loopbackAllowed });
		if (!res.ok) throw new Error(res.message);
		expect(res.status).toBe(200);
		expect(res.text()).toBe("ok");
		expect(hits).toEqual([`GET good.test:${port} /ok`]);
		expect(lookups).toEqual(["good.test"]);
	});

	it("名字解析到内网地址:回 invalid,只解析一次、一个连接都不发", async () => {
		const res = await makeClient().fetch(url("evil.test"), { addressCheck: loopbackAllowed });
		expect(res).toMatchObject({ ok: false, code: "invalid" });
		if (!res.ok) expect(res.message).toContain("10.0.0.1");
		expect(lookups).toEqual(["evil.test"]);
		expect(hits).toEqual([]);
	});

	it.each([
		["IPv4", "http://169.254.169.254/latest/meta-data"],
		["IPv4,带端口", "http://10.0.0.1:8080/"],
		["IPv6,带方括号", "http://[fd00::1]/"],
		["IPv6 里嵌着的 IPv4", "http://[::ffff:10.0.0.1]/"],
	])("地址直接写 IP 字面量(%s)的内网:不经解析当场回 invalid", async (_name, target) => {
		const res = await makeClient().fetch(target, { addressCheck: loopbackAllowed });
		expect(res).toMatchObject({ ok: false, code: "invalid" });
		expect(lookups).toEqual([]);
	});

	it("生产默认的判定下回环也是内网:名字解析到 127.0.0.1、字面量 127.0.0.1 都回 invalid", async () => {
		const client = makeClient();
		for (const target of [url("good.test"), url("127.0.0.1")]) {
			const res = await client.fetch(target, { addressCheck: requirePublicAddress });
			expect(res, target).toMatchObject({ ok: false, code: "invalid" });
		}
		expect(hits).toEqual([]);
	});

	it("一个名字解析出好几个地址、其中任何一个是内网:整个拒,放行的那个也不连", async () => {
		const res = await makeClient().fetch(url("mixed.test"), { addressCheck: loopbackAllowed });
		expect(res).toMatchObject({ ok: false, code: "invalid" });
		if (!res.ok) expect(res.message).toContain("10.0.0.1");
		expect(hits).toEqual([]);
	});

	it("解析出好几个都放行的地址:先连 IPv4 的那个", async () => {
		// 假服务只听 127.0.0.1;解析表先回的是 ::1。
		const allowAll = (): Result => ok();
		const res = await makeClient().fetch(url("dual.test"), { addressCheck: allowAll });
		if (!res.ok) throw new Error(res.message);
		expect(res.status).toBe(200);
	});

	it("名字解析不出来:回 unavailable(不是 invalid),原因带着", async () => {
		const res = await makeClient().fetch(url("nowhere.test"), { addressCheck: loopbackAllowed });
		expect(res).toMatchObject({ ok: false, code: "unavailable" });
		if (!res.ok) expect(res.message).toContain("ENOTFOUND");
	});
});

describe("addressCheck — 重定向的每一跳都判", () => {
	it("第一跳放行、302 到一个解析到内网的名字:第二跳回 invalid,没连过去", async () => {
		const res = await makeClient().fetch(url("good.test", "/to-internal-name"), {
			addressCheck: loopbackAllowed,
		});
		expect(res).toMatchObject({ ok: false, code: "invalid" });
		expect(hits).toEqual([`GET good.test:${port} /to-internal-name`]);
		expect(lookups).toEqual(["good.test", "evil.test"]);
	});

	it("第一跳放行、302 到内网的 IP 字面量:第二跳回 invalid", async () => {
		const res = await makeClient().fetch(url("good.test", "/to-internal-literal"), {
			addressCheck: loopbackAllowed,
		});
		expect(res).toMatchObject({ ok: false, code: "invalid" });
		if (!res.ok) expect(res.message).toContain("169.254.169.254");
		expect(hits).toEqual([`GET good.test:${port} /to-internal-literal`]);
	});

	it("302 到放行的地址:照跟", async () => {
		const res = await makeClient().fetch(url("127.0.0.1", "/to-good"), {
			addressCheck: loopbackAllowed,
		});
		if (!res.ok) throw new Error(res.message);
		expect(res.url).toBe(url("good.test"));
		expect(res.text()).toBe("ok");
	});
});

describe("addressCheck — DNS 重绑定", () => {
	it("同一个名字第一次解析到放行的地址、之后解析到内网:每条连接只解析一次,新连接被拒", async () => {
		const first = makeClient();
		const before = await first.fetch(url("rebind.test"), { addressCheck: loopbackAllowed });
		if (!before.ok) throw new Error(before.message);
		expect(before.status).toBe(200);
		// 检查与连接是同一次解析:这条连接上名字只查过一次。
		expect(lookups).toEqual(["rebind.test"]);
		await first.dispose();

		// 新的连接(新客户端,池是空的):解析已经变成内网,这一次被拒,没连过去。
		const after = await makeClient().fetch(url("rebind.test"), { addressCheck: loopbackAllowed });
		expect(after).toMatchObject({ ok: false, code: "invalid" });
		expect(hits).toHaveLength(1);
	});
});

describe("addressCheck — 这条路上的请求与回应和原来那条一个样", () => {
	it("头按交进来的顺序与大小写上线(头序也是指纹)", async () => {
		const res = await makeClient().fetch(url("good.test"), {
			addressCheck: loopbackAllowed,
			headers: { Zeta: "1", Referer: "https://example.test/", Accept: "image/*" },
		});
		if (!res.ok) throw new Error(res.message);
		const ours = rawHeaderNames.filter((name) =>
			["zeta", "referer", "accept", "user-agent", "sec-ch-ua"].includes(name.toLowerCase()),
		);
		expect(ours).toEqual(["Zeta", "Referer", "Accept", "User-Agent", "sec-ch-ua"]);
	});

	it("回应头是全局的 Headers;Set-Cookie 照样逐条进罐,`send-only` 照样不进", async () => {
		const jar = new CookieJar();
		const client = makeClient({ jar });
		const res = await client.fetch(url("good.test", "/cookie"), { addressCheck: loopbackAllowed });
		if (!res.ok) throw new Error(res.message);
		expect(res.headers).toBeInstanceOf(Headers);
		expect(res.headers.get("x-test")).toBe("yes");
		expect(jar.cookieHeaderFor(new URL(url("good.test")))).toBe("a=1; b=2");

		const readOnly = new CookieJar();
		const again = await makeClient({ jar: readOnly }).fetch(url("good.test", "/cookie"), {
			addressCheck: loopbackAllowed,
			cookies: "send-only",
		});
		expect(again.ok).toBe(true);
		expect(readOnly.cookieHeaderFor(new URL(url("good.test")))).toBe("");
	});

	it("超时回 timeout", async () => {
		const res = await makeClient({ timeoutMs: 80 }).fetch(url("good.test", "/hang"), {
			addressCheck: loopbackAllowed,
		});
		expect(res).toMatchObject({ ok: false, code: "timeout" });
	});
});

describe("dispose", () => {
	it("关掉守卫那条路攒下的连接;没用过守卫的客户端 dispose 也不出错", async () => {
		const client = makeClient();
		const res = await client.fetch(url("good.test"), { addressCheck: loopbackAllowed });
		expect(res.ok).toBe(true);
		const open = () =>
			new Promise<number>((resolve, reject) =>
				server.getConnections((err, count) => (err ? reject(err) : resolve(count))),
			);
		expect(await open()).toBe(1);

		await client.dispose();
		await expect.poll(open).toBe(0);

		await makeClient().dispose();
	});
});

describe.each([
	["走守卫那条路", { addressCheck: loopbackAllowed }],
	["不带守卫(原来那条路)", {}],
])("maxBodyBytes — %s", (_name, options) => {
	it("正好等于上限:收", async () => {
		const res = await makeClient().fetch(url("127.0.0.1", "/sized/1000"), {
			...options,
			maxBodyBytes: 1000,
		});
		if (!res.ok) throw new Error(res.message);
		expect(res.body.byteLength).toBe(1000);
	});

	it("Content-Length 就已经超了:回 invalid,体不读", async () => {
		const res = await makeClient().fetch(url("127.0.0.1", "/sized/1001"), {
			...options,
			maxBodyBytes: 1000,
		});
		expect(res).toMatchObject({ ok: false, code: "invalid" });
		if (!res.ok) expect(res.message).toContain("1000");
	});

	it("没有 Content-Length、不肯停的流:读过上限就掐断连接,回 invalid", async () => {
		const res = await makeClient().fetch(url("127.0.0.1", "/endless"), {
			...options,
			maxBodyBytes: 100_000,
		});
		expect(res).toMatchObject({ ok: false, code: "invalid" });
		await abortedByPeer;
	});

	it("不给上限:照旧整个读完", async () => {
		const res = await makeClient().fetch(url("127.0.0.1", "/sized/5000"), options);
		if (!res.ok) throw new Error(res.message);
		expect(res.body.byteLength).toBe(5000);
	});
});
