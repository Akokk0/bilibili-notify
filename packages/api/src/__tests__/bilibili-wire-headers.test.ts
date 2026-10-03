/**
 * B 站线上请求头:集合、**大小写与顺序**和请求客户端搬进 packages/http 之前逐字节一致。
 *
 * 为什么钉头序:风控的第一嫌疑本来就是指纹,头序是指纹的一部分,「看起来一样」不算一样。
 * 搬家后身份的四个头由 `HttpClient` 管,它默认把没写的身份头补在最后;所以 B 站这里要把
 * 它们按老位置写全 —— 谁手滑把它们删了(让 HttpClient 补)或挪了位置,别的测试都还绿,只有
 * 线上的头序变了。这里用裸 TCP 收原始请求行,看的是真正发出去的字节,不是 Node 解析后的 headers。
 *
 * 期望清单取自改造前 `initClient` 里那张头表的顺序(它是独立的来源,不是现算的)。
 */

import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ApiClient } from "../api-client";
import { BilibiliAPI } from "../bilibili-api";

/** 我们自己掌控的头,按改造前线上的顺序(含大小写)。其余的是 undici 自己加的,不管。 */
const OUR_HEADERS_BEFORE = [
	"Accept",
	"User-Agent",
	"Origin",
	"Referer",
	"priority",
	"sec-ch-ua",
	"sec-ch-ua-mobile",
	"sec-ch-ua-platform",
	"sec-fetch-dest",
	"sec-fetch-mode",
	"sec-fetch-site",
];
const OUR_NAMES = new Set(
	[...OUR_HEADERS_BEFORE, "Content-Type", "Cookie"].map((n) => n.toLowerCase()),
);

let server: net.Server;
let baseURL: string;
let rawHeads: string[][];
let sockets: Set<net.Socket>;

beforeEach(async () => {
	rawHeads = [];
	sockets = new Set();
	server = net.createServer((sock) => {
		sockets.add(sock);
		let buf = "";
		sock.on("data", (d) => {
			buf += d.toString("latin1");
			const end = buf.indexOf("\r\n\r\n");
			if (end < 0) return;
			const length = /content-length: (\d+)/i.exec(buf.slice(0, end));
			if (buf.length < end + 4 + (length ? Number(length[1]) : 0)) return;
			rawHeads.push(buf.slice(0, end).split("\r\n").slice(1));
			sock.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
			buf = "";
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseURL = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});

afterEach(async () => {
	for (const sock of sockets) sock.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 原始请求头里属于我们的那些名字,原样大小写、原样顺序。 */
const ourNamesOnWire = (head: string[]) =>
	head
		.map((line) => line.slice(0, line.indexOf(":")))
		.filter((n) => OUR_NAMES.has(n.toLowerCase()));

function makeClient(userAgent?: string) {
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	const api = new BilibiliAPI({
		serviceCtx: { logger } as never,
		config: { userAgent },
		callbacks: {},
	});
	return { api, client: (api as unknown as { client: ApiClient }).client };
}

describe("B 站线上请求头的顺序与大小写", () => {
	it("GET:与改造前一致(Accept 打头,UA 第二,sec-ch-ua 三件在 priority 之后)", async () => {
		const { client } = makeClient();
		await client.get(`${baseURL}/x`);
		expect(ourNamesOnWire(rawHeads[0] as string[])).toEqual(OUR_HEADERS_BEFORE);
	});

	it("带 cookie 的表单 POST:Content-Type 在默认头之后、Cookie 在最后(与改造前一致)", async () => {
		const { api, client } = makeClient();
		await api.loadCookies({
			cookiesJson: JSON.stringify([
				{ key: "SESSDATA", value: "s", domain: "127.0.0.1", path: "/" },
			]),
		});
		await client.postForm(`${baseURL}/x`, { a: 1 });
		expect(ourNamesOnWire(rawHeads[0] as string[])).toEqual([
			...OUR_HEADERS_BEFORE,
			"Content-Type",
			"Cookie",
		]);
	});

	it("自定义 UA 初始就写进配置:位置不变,值是自定义的", async () => {
		const { client } = makeClient("my-ua/1.0");
		await client.get(`${baseURL}/x`);
		expect(ourNamesOnWire(rawHeads[0] as string[])).toEqual(OUR_HEADERS_BEFORE);
		expect(rawHeads[0]).toContain("User-Agent: my-ua/1.0");
	});

	it("身份的四个头没有重复:线上每个名字只有一行", async () => {
		const { client } = makeClient();
		await client.get(`${baseURL}/x`);
		const names = (rawHeads[0] as string[]).map((l) => l.slice(0, l.indexOf(":")).toLowerCase());
		expect(new Set(names).size).toBe(names.length);
	});
});
