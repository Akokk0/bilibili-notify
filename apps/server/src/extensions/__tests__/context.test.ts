/**
 * 交给拓展的那面 ctx —— **第一版刻意很窄**(ADR-0012 决策 13:窄面加宽容易,反过来不行)。
 *
 * 这个文件钉的是它承重的那一条:**一切副作用都经由 ctx 注册,所以卸载才能干净**
 * (决策 11)。只要留一条旁路,卸载就不干净,而**不干净的卸载比要求重启更难 debug** ——
 * 定时器还在跑、端点还挂着,而面板上写着「已停用」。
 */

import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { createAdapterRegistry } from "../../platforms/registry.js";
import { createExtensionContext } from "../context.js";
import { createExtensionMounts, EXTENSION_MOUNT_PREFIX } from "../mount.js";
import { createExtensionUpgrades } from "../upgrade.js";

/** 一个手动跑的假宿主 ctx:定时器不真的走时钟,由测试自己 `tick()`。 */
function fakeHost() {
	const lines: string[] = [];
	const timers = new Set<() => void>();
	const logger: Logger = {
		info: (m) => lines.push(`info ${m}`),
		warn: (m) => lines.push(`warn ${m}`),
		error: (m) => lines.push(`error ${m}`),
		debug: (m) => lines.push(`debug ${m}`),
	};
	const ctx: ServiceContext = {
		logger,
		setInterval(fn) {
			timers.add(fn);
			return { dispose: () => timers.delete(fn) };
		},
		setTimeout(fn) {
			timers.add(fn);
			return { dispose: () => timers.delete(fn) };
		},
		onDispose() {},
	};
	return {
		ctx,
		lines,
		tick: () => {
			for (const fn of [...timers]) fn();
		},
		pending: () => timers.size,
	};
}

/** 这个文件钉的是**生命周期**,与核心打交道那几格由 `context-grants.test.ts` 管。 */
function coreStubs() {
	return {
		adapters: createAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		inbound: {},
		upgrades: createExtensionUpgrades(),
	};
}

function makeRuntime(id = "bridge") {
	const host = fakeHost();
	const mounts = createExtensionMounts();
	const app = new Hono();
	app.route(EXTENSION_MOUNT_PREFIX, mounts.route);
	const runtime = createExtensionContext({ id, host: host.ctx, mounts, ...coreStubs() });
	return { host, mounts, app, runtime, ctx: runtime.ctx };
}

describe("拓展 ctx", () => {
	it("日志认得出是谁写的 —— 拓展的每一行都带自己的 id", () => {
		const { host, ctx } = makeRuntime();
		ctx.logger.info("连上了");
		expect(host.lines).toEqual(["info [ext:bridge] 连上了"]);
	});

	it("宿主版本号交给拓展 —— 它自己也可能要按版本分叉", () => {
		expect(makeRuntime().ctx.hostApiVersion).toBeGreaterThanOrEqual(1);
	});

	it("卸载之后定时器不再跑 —— 哪怕拓展自己一个都没 dispose", async () => {
		const { host, ctx, runtime } = makeRuntime();
		let ticks = 0;
		ctx.setInterval(() => ticks++, 1000);
		ctx.setTimeout(() => ticks++, 1000);
		host.tick();
		expect(ticks).toBe(2);

		await runtime.dispose();
		expect(host.pending()).toBe(0);
		host.tick();
		expect(ticks).toBe(2);
	});

	it("卸载之后它那条路由就没了", async () => {
		const { ctx, app, runtime } = makeRuntime();
		const prefix = ctx.mount(async () => new Response("ok"));
		expect(prefix).toBe("/ext/bridge");
		expect((await app.request("/ext/bridge/x")).status).toBe(200);

		await runtime.dispose();
		expect((await app.request("/ext/bridge/x")).status).toBe(404);
	});

	it("卸载会跑拓展自己的收摊钩子,后注册的先跑", async () => {
		const { ctx, runtime } = makeRuntime();
		const order: string[] = [];
		ctx.onDispose(() => {
			order.push("一");
		});
		ctx.onDispose(() => {
			order.push("二");
		});
		await runtime.dispose();
		expect(order).toEqual(["二", "一"]);
	});

	it("某个收摊钩子抛了,剩下的照样收 —— 收一半是最难查的那种", async () => {
		const { host, ctx, runtime } = makeRuntime();
		ctx.setInterval(() => {}, 1000);
		ctx.onDispose(() => {
			throw new Error("boom");
		});
		let ran = false;
		ctx.onDispose(() => {
			ran = true;
		});
		await runtime.dispose();
		expect(ran).toBe(true);
		expect(host.pending()).toBe(0);
		expect(host.lines.some((l) => l.startsWith("error") && l.includes("bridge"))).toBe(true);
	});

	it("卸载是幂等的 —— 停用按两次不该炸", async () => {
		const { runtime } = makeRuntime();
		await runtime.dispose();
		await expect(runtime.dispose()).resolves.toBeUndefined();
	});

	it("卸载之后再注册东西 → 不生效,而且留一行 —— 别让幽灵定时器活过卸载", async () => {
		const { host, ctx, runtime } = makeRuntime();
		await runtime.dispose();
		let ticked = false;
		ctx.setInterval(() => {
			ticked = true;
		}, 1000);
		host.tick();
		expect(ticked).toBe(false);
		expect(host.pending()).toBe(0);
		expect(host.lines.some((l) => l.startsWith("warn"))).toBe(true);
	});

	it("一个拓展收摊不碰另一个", async () => {
		const host = fakeHost();
		const mounts = createExtensionMounts();
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);
		const a = createExtensionContext({ id: "a", host: host.ctx, mounts, ...coreStubs() });
		const b = createExtensionContext({ id: "b", host: host.ctx, mounts, ...coreStubs() });
		a.ctx.mount(async () => new Response("a"));
		b.ctx.mount(async () => new Response("b"));
		let bTicks = 0;
		b.ctx.setInterval(() => bTicks++, 1000);

		await a.dispose();
		expect((await app.request("/ext/a")).status).toBe(404);
		expect(await (await app.request("/ext/b")).text()).toBe("b");
		host.tick();
		expect(bTicks).toBe(1);
	});
});
