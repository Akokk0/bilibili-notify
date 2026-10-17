/**
 * HttpClient.websocket(用这个客户端的身份与罐子建连)契约 —— 用回环的 ws 服务端收握手。
 *
 * 钉住的不变量:
 *  1. **握手头的集合与顺序和切过来之前逐个一致**:`Cookie`(罐子里有才带)在 `User-Agent` 之前,
 *     后面是 ws 库自己加的那几个;不带 `sec-ch-ua*` / `Origin`,也不带客户端的默认头
 *     (B 站那层交给客户端的 Origin / Referer / sec-fetch-* 是 fetch 的头,不是握手的头)。
 *     头序也是指纹,所以看 `rawHeaders`(原大小写、原顺序),不看 Node 解析后的 headers。
 *  2. cookie 是**这个地址该带的那些**(罐子按域名、路径、过期、secure 筛),不是整罐倒出;
 *     `wss:` 按 `https:` 算(B 站的 SESSDATA 是 Secure,按 `wss:` 直接查会静默掉线)。
 *  3. `headers` 里同名(大小写不敏感)的盖过默认值、留在原位置,别的追加在后面。
 *  4. `signal` 中止 → 连接被关(已经中止的也关)。
 */

import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type WebSocket as ServerSocket, WebSocketServer } from "ws";
import type { BrowserIdentity } from "../browser-identity";
import { CookieJar } from "../cookie-jar";
import { HttpClient } from "../http-client";
import type { WebSocketLike } from "../websocket";

const IDENTITY: BrowserIdentity = {
	userAgent: "identity-ua/1.0",
	secChUa: '"Fixture";v="1"',
	secChUaMobile: "?0",
	secChUaPlatform: '"Fixture"',
};

/** B 站那层构造客户端时交进来的默认头那一类:这些是 fetch 的头,握手里一个都不该出现。 */
const FETCH_DEFAULTS: Record<string, string> = {
	Accept: "application/json, text/plain, */*",
	Origin: "https://www.bilibili.com",
	Referer: "https://www.bilibili.com/",
	priority: "u=1, i",
	"sec-ch-ua": IDENTITY.secChUa,
	"sec-ch-ua-mobile": IDENTITY.secChUaMobile,
	"sec-ch-ua-platform": IDENTITY.secChUaPlatform,
	"sec-fetch-dest": "empty",
	"sec-fetch-mode": "cors",
	"sec-fetch-site": "same-site",
};

/** 切过来之前(裸 `new WebSocket(url, { headers: { Cookie, User-Agent } })`)线上握手头的名字集合。 */
const TODAY_NAMES_WITH_COOKIE = [
	"connection",
	"cookie",
	"host",
	"sec-websocket-extensions",
	"sec-websocket-key",
	"sec-websocket-version",
	"upgrade",
	"user-agent",
];

let wss: WebSocketServer;
let origin: string;
let port: number;
let handshakes: IncomingMessage[];
let serverSockets: ServerSocket[];
let clientSockets: WebSocketLike[];

beforeEach(async () => {
	handshakes = [];
	serverSockets = [];
	clientSockets = [];
	wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	wss.on("connection", (socket, req) => {
		handshakes.push(req);
		serverSockets.push(socket);
	});
	await new Promise<void>((resolve) => wss.once("listening", resolve));
	port = (wss.address() as AddressInfo).port;
	origin = `127.0.0.1:${port}`;
});

afterEach(async () => {
	for (const socket of clientSockets) socket.close();
	for (const socket of wss.clients) socket.terminate();
	await new Promise<void>((resolve) => wss.close(() => resolve()));
});

function makeClient(jar = new CookieJar(), headers?: Record<string, string>) {
	return new HttpClient({ jar, identity: IDENTITY, headers });
}

/** 建连并登记收尾。`error` 挂个空处理:中止发生在握手期时 ws 会报一次 error,没人接会炸进程。 */
function open(client: HttpClient, url: string, options?: Parameters<HttpClient["websocket"]>[1]) {
	const result = client.websocket(url, options);
	if (!result.ok) throw new Error(`建连被拒: ${result.message}`);
	const { socket } = result;
	socket.on("error", () => {});
	clientSockets.push(socket);
	return socket;
}

const opened = (socket: WebSocketLike) =>
	new Promise<void>((resolve) => socket.on("open", () => resolve()));
const closed = (socket: WebSocketLike) =>
	new Promise<void>((resolve) => socket.on("close", () => resolve()));

/** 服务端收到的握手头的名字,原大小写、原顺序。 */
const namesOnWire = (req: IncomingMessage | undefined) =>
	(req?.rawHeaders ?? []).filter((_, index) => index % 2 === 0);

const lowered = (names: string[]) => names.map((name) => name.toLowerCase()).sort();

describe("HttpClient.websocket — 握手头的集合与顺序", () => {
	it("有 cookie:Cookie 在 User-Agent 之前,集合与切过来之前一致,不带 sec-ch-ua / Origin 与客户端的默认头", async () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("SESSDATA=s; Path=/", `http://${origin}/`);
		const socket = open(makeClient(jar, FETCH_DEFAULTS), `ws://${origin}/sub`);
		await opened(socket);

		const names = namesOnWire(handshakes[0]);
		expect(names.slice(0, 2)).toEqual(["Cookie", "User-Agent"]);
		expect(lowered(names)).toEqual(TODAY_NAMES_WITH_COOKIE);
		expect(handshakes[0]?.headers.cookie).toBe("SESSDATA=s");
		expect(handshakes[0]?.headers["user-agent"]).toBe(IDENTITY.userAgent);
	});

	it("罐子里没有这个地址的 cookie:不带 Cookie 头,User-Agent 打头", async () => {
		const socket = open(makeClient(new CookieJar(), FETCH_DEFAULTS), `ws://${origin}/sub`);
		await opened(socket);

		const names = namesOnWire(handshakes[0]);
		expect(names[0]).toBe("User-Agent");
		expect(lowered(names)).toEqual(TODAY_NAMES_WITH_COOKIE.filter((name) => name !== "cookie"));
		expect(handshakes[0]?.headers.cookie).toBeUndefined();
	});

	it("headers 里同名(大小写不敏感)的盖过默认值、留在原位置,别的追加在后面", async () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("SESSDATA=s; Path=/", `http://${origin}/`);
		const socket = open(makeClient(jar), `ws://${origin}/sub`, {
			headers: { "X-Extra": "1", "user-agent": "custom-ua/2.0" },
		});
		await opened(socket);

		expect(namesOnWire(handshakes[0]).slice(0, 3)).toEqual(["Cookie", "user-agent", "X-Extra"]);
		expect(handshakes[0]?.headers["user-agent"]).toBe("custom-ua/2.0");
		expect(handshakes[0]?.headers["x-extra"]).toBe("1");
	});
});

describe("HttpClient.websocket — cookie 是这个地址该带的那些", () => {
	it("按域名筛:别的域的 cookie 不带", async () => {
		const jar = new CookieJar();
		jar.load([
			{ key: "mine", value: "1", domain: "127.0.0.1", path: "/" },
			{ key: "other_site", value: "2", domain: "api.bilibili.com", path: "/" },
			{ key: "wide", value: "3", domain: ".bilibili.com", path: "/" },
		]);
		const socket = open(makeClient(jar), `ws://${origin}/sub`);
		await opened(socket);

		expect(handshakes[0]?.headers.cookie).toBe("mine=1");
	});

	it("按路径、过期、secure 筛:路径对不上的、过期的、Secure 的(ws: 不是安全连接)都不带", async () => {
		const jar = new CookieJar();
		jar.load([
			{ key: "mine", value: "1", domain: "127.0.0.1", path: "/" },
			{ key: "elsewhere", value: "2", domain: "127.0.0.1", path: "/elsewhere" },
			{
				key: "stale",
				value: "3",
				domain: "127.0.0.1",
				path: "/",
				expires: "2000-01-01T00:00:00.000Z",
			},
			{ key: "secure_only", value: "4", domain: "127.0.0.1", path: "/", secure: true },
		]);
		const socket = open(makeClient(jar), `ws://${origin}/sub`);
		await opened(socket);

		expect(handshakes[0]?.headers.cookie).toBe("mine=1");
	});

	it("wss: 按 https: 查罐子 —— Secure 的 cookie 带上(握手发不到 TLS,只看罐子被问了什么)", () => {
		const jar = new CookieJar();
		jar.load([{ key: "SESSDATA", value: "s", domain: "127.0.0.1", path: "/", secure: true }]);
		const lookup = vi.spyOn(jar, "cookieHeaderFor");
		// 端口 1 连不上;这里只关心建连那一刻客户端怎么问罐子。
		open(makeClient(jar), "wss://127.0.0.1:1/sub");

		expect(lookup).toHaveBeenCalledTimes(1);
		expect(lookup.mock.results[0]?.value).toBe("SESSDATA=s");
	});
});

describe("HttpClient.websocket — 文本帧与连接状态", () => {
	it("send 收字符串:对端收到的是文本帧,内容逐字", async () => {
		const socket = open(makeClient(), `ws://${origin}/sub`);
		await opened(socket);
		const received = new Promise<{ data: string; isBinary: boolean }>((resolve) =>
			serverSockets[0]?.once("message", (data, isBinary) =>
				resolve({ data: data.toString(), isBinary }),
			),
		);

		socket.send('{"op":"ping"}');

		expect(await received).toEqual({ data: '{"op":"ping"}', isBinary: false });
	});

	it("send 收字节:对端收到的仍是二进制帧", async () => {
		const socket = open(makeClient(), `ws://${origin}/sub`);
		await opened(socket);
		const received = new Promise<boolean>((resolve) =>
			serverSockets[0]?.once("message", (_data, isBinary) => resolve(isBinary)),
		);

		socket.send(new Uint8Array([1, 2, 3]));

		expect(await received).toBe(true);
	});

	it("连接状态:建连中、连上、关掉三个时刻各读一次(0 / 1 / 3)", async () => {
		const socket = open(makeClient(), `ws://${origin}/sub`);
		expect(socket.readyState).toBe(0);

		await opened(socket);
		expect(socket.readyState).toBe(1);

		const done = closed(socket);
		socket.close();
		await done;
		expect(socket.readyState).toBe(3);
	});
});

describe("HttpClient.websocket — 给错地址回 invalid", () => {
	it.each([
		["不合法的地址", "not a url"],
		["ws 不收的协议", "ftp://127.0.0.1/sub"],
	])("%s:不抛、回 invalid,话里不带 query,对端一次握手都没收到", async (_label, url) => {
		const result = makeClient().websocket(`${url}?token=secret`);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid");
		expect(result.message).not.toContain("secret");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(handshakes).toHaveLength(0);
	});
});

describe("HttpClient.websocket — bare 一档", () => {
	it("握手没有身份的 UA 与 Cookie,调用方写的头照发", async () => {
		const jar = new CookieJar();
		jar.setFromSetCookie("SESSDATA=s; Path=/", `http://${origin}/`);
		const socket = open(makeClient(jar, FETCH_DEFAULTS), `ws://${origin}/sub`, {
			bare: true,
			headers: { Authorization: "Bearer t" },
		});
		await opened(socket);

		const names = lowered(namesOnWire(handshakes[0]));
		expect(names).not.toContain("cookie");
		expect(names).not.toContain("user-agent");
		expect(names).toContain("authorization");
		expect(handshakes[0]?.headers.authorization).toBe("Bearer t");
	});
});

describe("HttpClient.websocket — signal", () => {
	it("中止 → 连接被关(两头都收到 close)", async () => {
		const controller = new AbortController();
		const socket = open(makeClient(), `ws://${origin}/sub`, { signal: controller.signal });
		await opened(socket);
		const clientClosed = closed(socket);
		const serverClosed = new Promise<void>((resolve) => serverSockets[0]?.once("close", resolve));

		controller.abort();

		await Promise.all([clientClosed, serverClosed]);
	});

	it("建连时 signal 已经中止 → 连接立刻关掉,握手不会完成", async () => {
		const controller = new AbortController();
		controller.abort();
		const socket = open(makeClient(), `ws://${origin}/sub`, { signal: controller.signal });

		await closed(socket);
		// 给服务端一点时间:要是握手照常完成了,这里会看到一条。
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(handshakes).toHaveLength(0);
	});
});
