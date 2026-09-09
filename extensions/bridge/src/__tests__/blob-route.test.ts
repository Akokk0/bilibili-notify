/**
 * 一次性取图口的 HTTP 那一半。
 *
 * 这个口**不挂鉴权** —— id 就是凭据(128 位随机、取过即焚、短 TTL),而桥手里只有一条
 * URL,没有 dashboard 的会话。所以「取过就 404」与「别让中间层缓存」这两条不是讲究,
 * 是这个设计成立的前提。
 *
 * 路径是**相对挂载点**的:宿主剥掉 `/ext/bridge` 之后才交进来(决策 12)。
 */

import type { Disposable, ExtensionContext } from "@bilibili-notify/extension";
import { describe, expect, it } from "vite-plus/test";
import { createBridgeBlobStore } from "../blob.js";
import { createBridgeFetchHandler } from "../blob-route.js";

function fakeCtx(): ExtensionContext {
	const noop: Disposable = { dispose() {} };
	return {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		setInterval: () => noop,
		setTimeout: () => noop,
		onDispose() {},
	} as unknown as ExtensionContext;
}

function boot() {
	const ctx = fakeCtx();
	const store = createBridgeBlobStore({ ctx });
	const handler = createBridgeFetchHandler({ store, logger: ctx.logger });
	return {
		store,
		get: (path: string) => handler(new Request(`http://bn.local${path}`)),
	};
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);

describe("GET <挂载点>/blob/:id", () => {
	it("取得到 —— 字节一模一样,Content-Type 是存进去时那个", async () => {
		const { store, get } = boot();
		const id = store.put(JPEG, "image/jpeg");
		const res = await get(`/blob/${id}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/jpeg");
		expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
	});

	it("再取一次就 404 —— 一次性,协议里写着别重试同一条 URL", async () => {
		const { store, get } = boot();
		const id = store.put(JPEG, "image/jpeg");
		await get(`/blob/${id}`);
		expect((await get(`/blob/${id}`)).status).toBe(404);
	});

	it("没见过的 id → 404", async () => {
		const { get } = boot();
		expect((await get("/blob/0123456789abcdef0123456789abcdef")).status).toBe(404);
	});

	it("**不许缓存** —— 中间层留一份,取过即焚就等于没焚", async () => {
		const { store, get } = boot();
		const id = store.put(JPEG, "image/jpeg");
		const res = await get(`/blob/${id}`);
		expect(res.headers.get("cache-control")).toContain("no-store");
	});

	/**
	 * `/ext/bridge/*` 整段都是这个拓展的,底下**没有下一层**可以漏 —— 认不出的路径
	 * 一律 404,而不是把请求放过去让宿主的静态资源接住。
	 */
	it("别的路径、别的方法 → 404", async () => {
		const { store, get } = boot();
		const id = store.put(JPEG, "image/jpeg");
		expect((await get("/")).status).toBe(404);
		expect((await get("/blob")).status).toBe(404);
		// 多一段就不是取图 —— id 那一段里不许再有斜杠。
		expect((await get(`/blob/${id}/extra`)).status).toBe(404);
	});
});
