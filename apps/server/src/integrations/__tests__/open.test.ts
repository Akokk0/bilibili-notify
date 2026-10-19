/**
 * 开一个集成(`integrations/open.ts`):请求客户端、上下文、收尾挂在一起。每个集成(B 站、内置适配器、对拍的假来源)
 * 经它开出自己的 `ctx.http` / `ctx.fetchImage` / `ctx.storeImage`。
 *
 * 请求打到本地回环的 HTTP / WebSocket 服务;存储用内存版(`memoryStoreHandle`),图库的「在途」写口用记账的假的
 * (`integrationIo`)。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fail, type Json } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { WebSocketServer } from "ws";
import { inertSettings } from "../../__tests__/support/inert-settings.js";
import { integrationIo } from "../../__tests__/support/integration-io.js";
import { memoryStoreHandle } from "../../__tests__/support/memory-key-value-store.js";
import { png } from "../../__tests__/support/report-images.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createImageFetcher } from "../../images/image-fetcher.js";
import { imageRefOf } from "../../images/image-store.js";
import { createProblemTable } from "../../problems/problem-table.js";
import { HTTP_IDENTITY_KEY } from "../http.js";
import { type OpenedIntegration, openIntegration } from "../open.js";

let server: Server;
let baseURL: string;
let seen: IncomingMessage["headers"][];
let releaseSlow: () => void;
let slowGate: Promise<void>;
let wss: WebSocketServer;
let wsURL: string;
let wsConnections: number;
const opened: OpenedIntegration[] = [];

beforeEach(async () => {
	seen = [];
	wsConnections = 0;
	slowGate = new Promise<void>((resolve) => {
		releaseSlow = resolve;
	});
	server = createServer((req, res) => {
		seen.push(req.headers);
		if (req.url === "/slow") {
			void slowGate.then(() => res.end("slow-done"));
			return;
		}
		res.end("hello");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	wss.on("connection", () => {
		wsConnections += 1;
	});
	await new Promise<void>((resolve) => wss.once("listening", resolve));
	wsURL = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/sub`;
});

afterEach(async () => {
	releaseSlow();
	for (const one of opened.splice(0)) {
		await one.handle.dispose();
		await one.http.client.dispose();
	}
	for (const socket of wss.clients) socket.terminate();
	await new Promise<void>((resolve) => wss.close(() => resolve()));
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 开一个集成:存储、问题表、设置都是内存里的假的。 */
async function open(key: string, io = integrationIo()) {
	const store = memoryStoreHandle();
	const one = await openIntegration({
		stores: store.handle,
		logger: silentLogger,
		stopReason: "测试",
		problems: createProblemTable({ logger: silentLogger }),
		reporter: key,
		rejectedProblemLevel: "error",
		settings: inertSettings(),
		transitImages: io.transitImages,
		httpOptions: {
			setTimeout: (fn, ms) => {
				const timer = setTimeout(fn, ms);
				return { dispose: () => clearTimeout(timer) };
			},
		},
	});
	opened.push(one);
	return { ...one, store, io };
}

const nextSocketOpen = (ws: { on(event: string, fn: () => void): void }) =>
	new Promise<void>((resolve) => ws.on("open", resolve));
const nextSocketClose = (ws: { on(event: string, fn: () => void): void }) =>
	new Promise<void>((resolve) => ws.on("close", resolve));

describe("openIntegration — 每个集成一个自己的请求客户端", () => {
	it("两个集成各发一个请求:线上的 UA 各是各自存进 state 的 http.identity,互不借用", async () => {
		const a = await open("alpha");
		const b = await open("beta");

		await a.handle.ctx.http.fetch(`${baseURL}/a`);
		await b.handle.ctx.http.fetch(`${baseURL}/b`);

		const identityOf = (store: typeof a.store) =>
			store.handle.hostState.get<Json>(HTTP_IDENTITY_KEY) as { userAgent: string };
		expect(seen).toHaveLength(2);
		expect(seen[0]?.["user-agent"]).toBe(identityOf(a.store).userAgent);
		expect(seen[1]?.["user-agent"]).toBe(identityOf(b.store).userAgent);
		// 各自把身份写进了各自的 state(不是共用一个客户端)。
		expect(identityOf(a.store)).toBeDefined();
		expect(identityOf(b.store)).toBeDefined();
		expect(a.http.client).not.toBe(b.http.client);
	});

	it("ctx.http 就是这个集成自己的客户端:打码、默认头之类的宿主设置照用", async () => {
		const one = await open("alpha");

		const res = await one.handle.ctx.http.fetch(`${baseURL}/x`, { bare: true });

		expect(res.ok).toBe(true);
		// bare 一档不带身份:线上 UA 不是这个集成的身份。
		const identity = one.store.handle.hostState.get<Json>(HTTP_IDENTITY_KEY) as {
			userAgent: string;
		};
		expect(seen[0]?.["user-agent"]).not.toBe(identity.userAgent);
	});
});

describe("openIntegration — 停下时", () => {
	it("经 ctx.http 建的 websocket 自动关;在途的 fetch 不跟着断", async () => {
		const one = await open("alpha");
		const built = one.handle.ctx.http.websocket(wsURL);
		if (!built.ok) throw new Error("建连被拒");
		built.socket.on("error", () => {});
		await nextSocketOpen(built.socket);
		const socketClosed = nextSocketClose(built.socket);
		const pending = one.handle.ctx.http.fetch(`${baseURL}/slow`);
		await new Promise((resolve) => setTimeout(resolve, 50));

		await one.handle.dispose();
		await socketClosed;
		releaseSlow();

		const res = await pending;
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.text()).toBe("slow-done");
		expect(wsConnections).toBe(1);
	});

	it("调用方自己传的 signal 照样管用:传来的和集成的停下信号任一中止都关", async () => {
		const one = await open("alpha");
		const controller = new AbortController();
		const built = one.handle.ctx.http.websocket(wsURL, { signal: controller.signal });
		if (!built.ok) throw new Error("建连被拒");
		built.socket.on("error", () => {});
		await nextSocketOpen(built.socket);
		const socketClosed = nextSocketClose(built.socket);

		controller.abort();

		await socketClosed;
	});

	it("停下之后建的 websocket 立刻就关(建连时信号已中止)", async () => {
		const one = await open("alpha");
		await one.handle.dispose();

		const built = one.handle.ctx.http.websocket(wsURL);
		if (!built.ok) throw new Error("建连被拒");
		built.socket.on("error", () => {});
		await nextSocketClose(built.socket);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(wsConnections).toBe(0);
	});
});

describe("openIntegration — ctx.fetchImage / ctx.storeImage", () => {
	it("fetchImage 拦内网:抓回环地址回 invalid,一个请求都没发出去", async () => {
		const one = await open("alpha");

		const res = await one.handle.ctx.fetchImage(`${baseURL}/pic.png`);

		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("invalid");
		expect(seen).toHaveLength(0);
	});

	it("storeImage 存不是图的字节回 invalid;存图回的引用对得上字节,写口收到的就是这份字节", async () => {
		const one = await open("alpha");
		const bytes = png(10, 10, 7);

		const refused = await one.handle.ctx.storeImage(new Uint8Array([1, 2, 3]));
		const stored = await one.handle.ctx.storeImage(bytes);

		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.code).toBe("invalid");
		expect(stored).toEqual({ ok: true, ref: imageRefOf(bytes) });
		expect(one.io.stored).toEqual([bytes]);
	});

	it("storeImage 的 signal 已中止:回 indeterminate,写口什么都没收到", async () => {
		const one = await open("alpha");
		const controller = new AbortController();
		controller.abort();

		const res = await one.handle.ctx.storeImage(png(4, 4), { signal: controller.signal });

		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("indeterminate");
		expect(one.io.stored).toEqual([]);
	});

	it("经 ctx.http 交出去的 fetch 照样认 addressCheck(窄面没把选项抄丢)", async () => {
		const one = await open("alpha");
		const fetcher = createImageFetcher({
			http: one.handle.ctx.http,
			images: one.io.transitImages,
			addressCheck: () => fail("invalid", "测试里一律不放行"),
		});

		const res = await fetcher.fetchImage(`${baseURL}/pic.png`);

		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.message).toContain("测试里一律不放行");
		expect(seen).toHaveLength(0);
	});

	it("ctx.http 整体不拦内网:本地回环照通", async () => {
		const one = await open("alpha");

		const res = await one.handle.ctx.http.fetch(`${baseURL}/lan`);

		expect(res.ok).toBe(true);
		expect(seen).toHaveLength(1);
	});
});
