/**
 * 弹幕连接的建连口 `BilibiliAPI.openDanmakuSocket`:blive 的 `createSocket` 接的就是它,
 * 握手头由长期有效的那个客户端(身份 + cookie 罐)装配,B 站这层不另给头。
 *
 * 用回环的 ws 服务端收握手,看的是 `rawHeaders`(原大小写、原顺序)—— 头序是指纹的一部分。
 * 钉住:
 *  - `Cookie` 在 `User-Agent` 前(与切到 packages/http 之前 blive 自己拼的一致),
 *    cookie 是罐子按这个地址筛出来的,不是整罐倒出;
 *  - 不带 `sec-ch-ua*` / `Origin` / `Referer`,也不带 fetch 那套默认头(B 站那层交给 HttpClient 的);
 *  - 握手的 UA 就是本实例身份的那一个(没有自定义 UA 了,ADR-0025 决策 7),每条连接都一样。
 */

import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { WebSocketServer } from "ws";
import { BilibiliAPI } from "../bilibili-api";

/** 握手里一个都不该出现的 fetch 头(B 站那层交给 HttpClient 的默认头,加上身份的 sec-ch-ua 三件)。 */
const FETCH_ONLY = [
	"accept",
	"origin",
	"referer",
	"priority",
	"sec-ch-ua",
	"sec-ch-ua-mobile",
	"sec-ch-ua-platform",
	"sec-fetch-dest",
	"sec-fetch-mode",
	"sec-fetch-site",
];

let wss: WebSocketServer;
let url: string;
let handshakes: IncomingMessage[];
let sockets: { close(): void }[];

beforeEach(async () => {
	handshakes = [];
	sockets = [];
	wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	wss.on("connection", (_socket, req) => handshakes.push(req));
	await new Promise<void>((resolve) => wss.once("listening", resolve));
	url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/sub`;
});

afterEach(async () => {
	for (const socket of sockets) socket.close();
	for (const socket of wss.clients) socket.terminate();
	await new Promise<void>((resolve) => wss.close(() => resolve()));
});

function makeApi() {
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	return new BilibiliAPI({ serviceCtx: { logger } as never, callbacks: {} });
}

/** 本实例的生成身份(私有字段;握手与 HTTP 请求的 UA 都从它来)。 */
const identityOf = (api: BilibiliAPI) =>
	(api as unknown as { browserIdentity: { userAgent: string } }).browserIdentity;

/** 建一条弹幕连接,等握手走完;握手期被关会报 error,挂个空处理免得炸进程。 */
async function connect(api: BilibiliAPI): Promise<IncomingMessage> {
	const socket = api.openDanmakuSocket(url);
	socket.on("error", () => {});
	sockets.push(socket);
	await new Promise<void>((resolve) => socket.on("open", () => resolve()));
	return handshakes[handshakes.length - 1] as IncomingMessage;
}

const namesOf = (req: IncomingMessage) => req.rawHeaders.filter((_, index) => index % 2 === 0);

describe("BilibiliAPI.openDanmakuSocket", () => {
	it("握手头:Cookie 在 User-Agent 之前,cookie 只带这个地址该带的,不带 fetch 那套头与 sec-ch-ua", async () => {
		const api = makeApi();
		await api.loadCookies({
			cookiesJson: JSON.stringify([
				{ key: "SESSDATA", value: "s", domain: "127.0.0.1", path: "/" },
				{ key: "other_site", value: "x", domain: "example.test", path: "/" },
			]),
		});

		const req = await connect(api);

		expect(namesOf(req).slice(0, 2)).toEqual(["Cookie", "User-Agent"]);
		expect(req.headers.cookie).toBe("SESSDATA=s");
		expect(req.headers["user-agent"]).toBe(identityOf(api).userAgent);
		const names = namesOf(req).map((name) => name.toLowerCase());
		for (const forbidden of FETCH_ONLY) expect(names).not.toContain(forbidden);
	});

	it("没有登录态:不带 Cookie 头", async () => {
		const req = await connect(makeApi());

		expect(namesOf(req)[0]).toBe("User-Agent");
		expect(req.headers.cookie).toBeUndefined();
	});

	it("握手的 UA 是身份的那一个:每条连接都一样,头序不变", async () => {
		const api = makeApi();
		await api.loadCookies({
			cookiesJson: JSON.stringify([
				{ key: "SESSDATA", value: "s", domain: "127.0.0.1", path: "/" },
			]),
		});

		const first = await connect(api);
		const second = await connect(api);

		for (const req of [first, second]) {
			expect(req.headers["user-agent"]).toBe(identityOf(api).userAgent);
			expect(namesOf(req).slice(0, 2)).toEqual(["Cookie", "User-Agent"]);
		}
	});
});
