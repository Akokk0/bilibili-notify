/**
 * 一次性取图口的 HTTP 那一半。
 *
 * 这个口**不挂鉴权** —— id 就是凭据(128 位随机、取过即焚、短 TTL),而桥手里只有一条
 * URL,没有 dashboard 的会话。所以「取过就 404」与「别让中间层缓存」这两条不是讲究,
 * 是这个设计成立的前提。
 */

import type { Disposable, ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { createBridgeBlobStore } from "../../bridge/blob.js";
import { createBridgeBlobRoute } from "../bridge-blob.js";

function fakeCtx(): ServiceContext {
	const noop: Disposable = { dispose() {} };
	return {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		setInterval: () => noop,
		setTimeout: () => noop,
		onDispose() {},
	} as unknown as ServiceContext;
}

function boot() {
	const store = createBridgeBlobStore({ serviceCtx: fakeCtx() });
	return { store, app: createBridgeBlobRoute({ store, logger: fakeCtx().logger }) };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);

describe("GET /bridge/blob/:id", () => {
	it("取得到 —— 字节一模一样,Content-Type 是存进去时那个", async () => {
		const { store, app } = boot();
		const id = store.put(JPEG, "image/jpeg");
		const res = await app.request(`/${id}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/jpeg");
		expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
	});

	it("再取一次就 404 —— 一次性,协议里写着别重试同一条 URL", async () => {
		const { store, app } = boot();
		const id = store.put(JPEG, "image/jpeg");
		await app.request(`/${id}`);
		expect((await app.request(`/${id}`)).status).toBe(404);
	});

	it("没见过的 id → 404", async () => {
		const { app } = boot();
		expect((await app.request("/0123456789abcdef0123456789abcdef")).status).toBe(404);
	});

	it("**不许缓存** —— 中间层留一份,取过即焚就等于没焚", async () => {
		const { store, app } = boot();
		const id = store.put(JPEG, "image/jpeg");
		const res = await app.request(`/${id}`);
		expect(res.headers.get("cache-control")).toContain("no-store");
	});
});
