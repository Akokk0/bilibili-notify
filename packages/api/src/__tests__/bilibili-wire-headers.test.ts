/**
 * B 站线上请求头:集合、**大小写与顺序**和请求客户端搬进 packages/http 之前逐字节一致。
 *
 * 为什么钉头序:风控的第一嫌疑本来就是指纹,头序是指纹的一部分,「看起来一样」不算一样。
 * 搬家后身份的四个头由 `HttpClient` 管,它默认把没写的身份头补在最后;所以 B 站这里要把
 * 它们按老位置写全 —— 谁手滑把它们删了(让 HttpClient 补)或挪了位置,别的测试都还绿,只有
 * 线上的头序变了。这里用裸 TCP 收原始请求行,看的是真正发出去的字节,不是 Node 解析后的 headers。
 *
 * 期望清单是**改造前生产上开机之后真正发出去的顺序**(独立的来源,不是现算的):`initClient` 那张头表上
 * UA 排第二,可开机总会调一次 `setUserAgent`(没填自定义 UA 也调),旧的 `setHeader` 先删同名再从末尾加回,
 * 于是线上的 UA 一直排在默认头最后。⑭a 起一度照表上的顺序发(UA 第二),10-03 查 ⑭ 之前的代码发现以后,
 * 主人定恢复生产上跑了几个月的这个顺序:改造期间不引入没在真机上验过的指纹变化。
 */

import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ApiClient } from "../api-client";
import { BilibiliAPI } from "../bilibili-api";

/** 我们自己掌控的头,按改造前线上的顺序(含大小写)。其余的是 undici 自己加的,不管。 */
const OUR_HEADERS_BEFORE = [
	"Accept",
	"Origin",
	"Referer",
	"priority",
	"sec-ch-ua",
	"sec-ch-ua-mobile",
	"sec-ch-ua-platform",
	"sec-fetch-dest",
	"sec-fetch-mode",
	"sec-fetch-site",
	"User-Agent",
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

function makeClient() {
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	const api = new BilibiliAPI({ serviceCtx: { logger } as never, callbacks: {} });
	return { api, client: (api as unknown as { client: ApiClient }).client };
}

describe("B 站线上请求头的顺序与大小写", () => {
	it("GET:与改造前一致(Accept 打头,sec-ch-ua 三件在 priority 之后,UA 在默认头最后)", async () => {
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

	// UA 与 sec-ch-ua 永远来自同一份身份(没有自定义 UA 这个设置了,ADR-0025 决策 7):线上的 UA 行就是
	// 身份的 UA,sec-ch-ua 行就是身份的 sec-ch-ua。
	it("线上的 UA 与 sec-ch-ua 是同一份生成身份的", async () => {
		const { api, client } = makeClient();
		await client.get(`${baseURL}/x`);
		const identity = (api as unknown as { browserIdentity: { userAgent: string; secChUa: string } })
			.browserIdentity;
		expect(rawHeads[0]).toContain(`User-Agent: ${identity.userAgent}`);
		expect(rawHeads[0]).toContain(`sec-ch-ua: ${identity.secChUa}`);
	});

	it("身份的四个头没有重复:线上每个名字只有一行", async () => {
		const { client } = makeClient();
		await client.get(`${baseURL}/x`);
		const names = (rawHeads[0] as string[]).map((l) => l.slice(0, l.indexOf(":")).toLowerCase());
		expect(new Set(names).size).toBe(names.length);
	});
});
