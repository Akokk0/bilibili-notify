/**
 * 官机适配器的入站出口:网关收到的群 / 私聊消息,经适配器 `start(ctx)` 拿到的 `ctx.inbound` 交出,
 * meta 只带 `connectionId`(平台由宿主按连接补,适配器不自报,ADR-0024 决策 12)。
 *
 * 内层网关连接的归一化在 `qq-official-conn.test.ts`;这里证的是适配器把它**接到 `ctx.inbound`** 上。
 * 全程不联网:全局 `fetch`(token、取网关地址)换成桩,网关是本机假的 WS 服务。
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Connection, Disposable, Logger, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type WebSocket, WebSocketServer } from "ws";
import { reconcileAdapter } from "../../__tests__/support/adapter-ctx.js";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "../qq-official";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (cond()) return;
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: 超时");
		await sleep(10);
	}
}

function makeLogger(): Logger {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** 真实定时器的 ServiceContext(WS 是真异步)。 */
function makeServiceCtx(): ServiceContext {
	return {
		logger: makeLogger(),
		setTimeout(fn, ms): Disposable {
			const h = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(h) };
		},
		setInterval(fn, ms): Disposable {
			const h = setInterval(fn, ms);
			return { dispose: () => clearInterval(h) };
		},
		onDispose() {},
		signal: new AbortController().signal,
		track: () => {},
	};
}

function qqConnection(): Connection {
	return {
		id: "a1",
		name: "qq",
		adapterKey: "qq-official",
		platform: "qq-official",
		platformSnapshot: snapshotFor("qq-official"),
		enabled: true,
		settings: { appId: "APPID", appSecret: "SECRET", sandbox: false, botType: "public" },
	} as unknown as Connection;
}

const cleanups: Array<() => void | Promise<void>> = [];
let realFetch: typeof fetch;

beforeEach(() => {
	realFetch = globalThis.fetch;
});

afterEach(async () => {
	globalThis.fetch = realFetch;
	for (const c of cleanups.splice(0)) {
		try {
			await c();
		} catch {
			/* ignore */
		}
	}
});

/** 本机假网关:一上来下发 HELLO,`dispatch` 向最近一条连接推事件。 */
async function startFakeGateway() {
	const wss = new WebSocketServer({ port: 0 });
	await once(wss, "listening");
	const conns: WebSocket[] = [];
	wss.on("connection", (ws) => {
		conns.push(ws);
		ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
	});
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				for (const c of conns) c.terminate();
				wss.close(() => resolve());
			}),
	);
	let seq = 0;
	return {
		url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
		conns,
		dispatch(t: string, d: unknown) {
			seq += 1;
			conns.at(-1)?.send(JSON.stringify({ op: 0, s: seq, t, d }));
		},
	};
}

/** 全局 fetch 桩:token 给个假的,取网关地址指向本机假网关;别的一律不该来。 */
function stubFetch(gatewayUrl: string) {
	globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("getAppAccessToken")) {
			return new Response(JSON.stringify({ access_token: "ACCESS", expires_in: 7200 }));
		}
		if (url.endsWith("/gateway")) return new Response(JSON.stringify({ url: gatewayUrl }));
		throw new Error(`不该联网:${url}`);
	}) as typeof fetch;
}

describe("官机适配器 · 入站经 ctx.inbound", () => {
	// 验红:把官机里交群消息的那一行(`inbound.group(m, { connectionId })`)改成别的(例如调私聊那一路),这条红。
	it("网关来一条群消息 → 经 ctx.inbound.group 交出,meta 只带 connectionId", async () => {
		const gw = await startFakeGateway();
		stubFetch(gw.url);
		const priv = vi.fn();
		const group = vi.fn();
		const ad = createQQOfficialAdapter({
			logger: makeLogger(),
			serviceCtx: makeServiceCtx(),
			registry: createQQSessionRegistry(),
			locale: fixedLocale(),
		});
		reconcileAdapter(ad, [qqConnection()], { private: priv, group });
		cleanups.push(() => ad.stop());
		await waitFor(() => gw.conns.length > 0);
		gw.dispatch("READY", { session_id: "SID" });
		gw.dispatch("GROUP_MESSAGE_CREATE", {
			group_openid: "G1",
			content: "看看 https://www.bilibili.com/video/BV1xx",
			author: { member_openid: "M1" },
		});
		await waitFor(() => group.mock.calls.length > 0);
		expect(group).toHaveBeenCalledWith(
			{
				address: "G1",
				senderId: "M1",
				text: "看看 https://www.bilibili.com/video/BV1xx",
				sharedLinks: [],
			},
			{ connectionId: "a1" },
		);
		expect(priv).not.toHaveBeenCalled();
	});

	it("网关来一条私聊 → 经 ctx.inbound.private 交出,meta 只带 connectionId", async () => {
		const gw = await startFakeGateway();
		stubFetch(gw.url);
		const priv = vi.fn();
		const group = vi.fn();
		const ad = createQQOfficialAdapter({
			logger: makeLogger(),
			serviceCtx: makeServiceCtx(),
			registry: createQQSessionRegistry(),
			locale: fixedLocale(),
		});
		reconcileAdapter(ad, [qqConnection()], { private: priv, group });
		cleanups.push(() => ad.stop());
		await waitFor(() => gw.conns.length > 0);
		gw.dispatch("READY", { session_id: "SID" });
		gw.dispatch("C2C_MESSAGE_CREATE", { author: { user_openid: "U1" }, content: "y" });
		await waitFor(() => priv.mock.calls.length > 0);
		expect(priv).toHaveBeenCalledWith({ address: "U1", text: "y" }, { connectionId: "a1" });
		expect(group).not.toHaveBeenCalled();
	});
});
