/**
 * 一次性取图口的存储那一半。
 *
 * 它承着协议里两句写死的话:**「这个 id 本身就是凭据」**(所以取过必须立刻作废,不然
 * 一条日志泄出去的 URL 就永远有效)、**「一次性,别重试同一个 URL」**。剩下的是内存:
 * 桥不来取的图必须自己消失 —— BN 常跑在 NAS 上,几百 KB 一张的卡攒起来是真占地方。
 */

import type { Disposable, ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { createBridgeBlobStore } from "../blob.js";

/** 攒下扫地的那个回调,好让测试自己决定什么时候扫。 */
function fakeCtx(): { ctx: ServiceContext; sweeps: (() => void)[] } {
	const sweeps: (() => void)[] = [];
	const noop: Disposable = { dispose() {} };
	const ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		setInterval(fn: () => void) {
			sweeps.push(fn);
			return noop;
		},
		setTimeout() {
			return noop;
		},
		onDispose() {},
	} as unknown as ServiceContext;
	return { ctx, sweeps };
}

function boot(over: { ttlMs?: number; maxBytes?: number } = {}) {
	const { ctx, sweeps } = fakeCtx();
	let clock = 1_000;
	const store = createBridgeBlobStore({
		serviceCtx: ctx,
		now: () => clock,
		...over,
	});
	return {
		store,
		sweep: () => {
			for (const fn of sweeps) fn();
		},
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("createBridgeBlobStore", () => {
	it("存进去什么取出来还是什么", () => {
		const { store } = boot();
		const id = store.put(PNG, "image/png");
		expect(store.take(id)).toEqual({ buffer: PNG, mime: "image/png" });
	});

	it("**取过就没了** —— id 即凭据,泄出去的 URL 不能还有效", () => {
		const { store } = boot();
		const id = store.put(PNG, "image/png");
		store.take(id);
		expect(store.take(id)).toBeUndefined();
		expect(store.size).toBe(0);
	});

	it("没见过的 id 就是没有", () => {
		const { store } = boot();
		expect(store.take("deadbeef")).toBeUndefined();
	});

	it("过了 TTL 取不到", () => {
		const { store, advance } = boot({ ttlMs: 1_000 });
		const id = store.put(PNG, "image/png");
		advance(1_001);
		expect(store.take(id)).toBeUndefined();
	});

	it("**扫地是主动的**,不是等谁来取才判过期 —— 没人来取的图也得自己消失", () => {
		const { store, sweep, advance } = boot({ ttlMs: 1_000 });
		store.put(PNG, "image/png");
		sweep();
		expect(store.size).toBe(1);
		advance(1_001);
		sweep();
		expect(store.size).toBe(0);
	});

	it("超出字节上限时淘汰最老的 —— 桥一直不来取也不能把内存吃光", () => {
		const { store } = boot({ maxBytes: 10 });
		const first = store.put(Buffer.alloc(6), "image/jpeg");
		const second = store.put(Buffer.alloc(6), "image/jpeg");
		expect(store.take(first)).toBeUndefined();
		expect(store.take(second)).toBeDefined();
	});

	it("id 是 128 位十六进制,每次都不一样", () => {
		const { store } = boot();
		const ids = new Set(Array.from({ length: 50 }, () => store.put(PNG, "image/png")));
		expect(ids.size).toBe(50);
		for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
	});

	it("dispose 之后一张都不剩", () => {
		const { store } = boot();
		const id = store.put(PNG, "image/png");
		store.dispose();
		expect(store.take(id)).toBeUndefined();
		expect(store.size).toBe(0);
	});
});
