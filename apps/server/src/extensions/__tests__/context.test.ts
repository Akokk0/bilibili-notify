/**
 * 交给拓展的那面 ctx —— **第一版刻意很窄**(ADR-0012 决策 13:窄面加宽容易,反过来不行)。
 *
 * 这个文件钉的是它承重的那一条:**一切副作用都经由 ctx 注册,所以卸载才能干净**
 * (决策 11)。只要留一条旁路,卸载就不干净,而**不干净的卸载比要求重启更难 debug** ——
 * 定时器还在跑、端点还挂着,而面板上写着「已停用」。
 */

import type { ExtensionManifest, Logger, ServiceContext } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { noExtensionI18n } from "../../__tests__/support/extension-locales.js";
import { integrationIo } from "../../__tests__/support/integration-io.js";
import { memoryStores } from "../../__tests__/support/memory-key-value-store.js";
import { png } from "../../__tests__/support/report-images.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { imageRefOf } from "../../images/image-store.js";
import { createValueRedactor } from "../../logs/value-redactor.js";
import { createProblemTable } from "../../problems/problem-table.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
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
		// 同真宿主:一次性的,触发时自己从表里走。
		setTimeout(fn) {
			const run = () => {
				timers.delete(run);
				fn();
			};
			timers.add(run);
			return { dispose: () => timers.delete(run) };
		},
		onDispose() {},
		signal: new AbortController().signal,
		track: () => {},
	};
	/** 按 id 要日志器:每次要都记下是谁要的;行带上要它时的 id,好看出是哪一个日志器写的。 */
	const asked: string[] = [];
	const loggerOf = (id: string): Logger => {
		asked.push(id);
		return {
			info: (m) => lines.push(`info ${id}: ${m}`),
			warn: (m) => lines.push(`warn ${id}: ${m}`),
			error: (m) => lines.push(`error ${id}: ${m}`),
			debug: (m) => lines.push(`debug ${id}: ${m}`),
		};
	};
	return {
		ctx,
		lines,
		asked,
		loggerOf,
		tick: () => {
			for (const fn of [...timers]) fn();
		},
		pending: () => timers.size,
	};
}

/** 这个文件钉的是**生命周期**,与核心打交道那几格由 `context-grants.test.ts` 管。 */
function coreStubs() {
	return {
		stores: { ...memoryStores(), redact() {} },
		manifest: {
			id: "bridge",
			name: "机器人框架桥接",
			description: "测试用",
			version: "1.0.0",
			apiVersion: 3,
			contributes: { push: { label: "测试", shortLabel: "测", color: "#000000" } },
		} as const satisfies ExtensionManifest,
		adapters: createPlatformAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		settings: () => undefined,
		onSettingsChanged: () => ({ dispose() {} }),
		inbound: {},
		upgrades: createExtensionUpgrades(),
		problems: createProblemTable({ logger: silentLogger }),
	};
}

function makeRuntime(id = "bridge") {
	const host = fakeHost();
	const mounts = createExtensionMounts({ logger: silentLogger });
	const app = new Hono();
	app.route(EXTENSION_MOUNT_PREFIX, mounts.route);
	const stubs = coreStubs();
	const io = integrationIo();
	const runtime = createExtensionContext({
		...io,
		...noExtensionI18n(),
		id,
		host: host.ctx,
		loggerOf: host.loggerOf,
		mounts,
		...stubs,
	});
	return { host, mounts, app, runtime, io, ctx: runtime.ctx, problems: stubs.problems };
}

describe("拓展 ctx", () => {
	// 验红:`context.ts` 的 `ExtensionContext` 字面量里剪掉 `http` / `fetchImage` / `storeImage` 任一格,这条红(类型检查也过不去)。
	it("ctx.http / fetchImage / storeImage 是这个拓展自己集成的那三个:存的图进它的在途写口,抓图拦内网", async () => {
		const { ctx, io } = makeRuntime();
		const bytes = png(8, 8, 2);

		const stored = await ctx.storeImage(bytes);
		const fetched = await ctx.fetchImage("http://127.0.0.1:8080/x.png");

		expect(stored).toEqual({ ok: true, ref: imageRefOf(bytes) });
		expect(io.stored).toEqual([bytes]);
		expect(fetched.ok).toBe(false);
		if (!fetched.ok) expect(fetched.code).toBe("invalid");
		expect(typeof ctx.http.fetch).toBe("function");
		expect(typeof ctx.http.websocket).toBe("function");
	});

	// 验红:`context.ts` 里 `logger: opts.loggerOf(id)` 改回给宿主日志器的每行正文拼 `[ext:<id>]`,这条红。
	it("日志器是按拓展 id 向宿主要的那一个 —— 行的标签靠它,正文里不再拼 [ext:<id>]", () => {
		const { host, ctx } = makeRuntime();
		ctx.logger.info("连上了");
		expect(host.asked).toEqual(["bridge"]);
		expect(host.lines).toEqual(["info bridge: 连上了"]);
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

	it("一次性定时器触发之后自己从登记里放掉 —— 卸载时不再去摘它,手动 dispose 也不出错", async () => {
		const host = fakeHost();
		const fires: Array<() => void> = [];
		const disposed: number[] = [];
		let seq = 0;
		// 宿主那面的 setTimeout:把回调留给测试手动触发,并记下谁的 dispose 被叫过。
		host.ctx.setTimeout = (fn) => {
			const n = seq++;
			fires.push(fn);
			return { dispose: () => void disposed.push(n) };
		};
		const mounts = createExtensionMounts({ logger: silentLogger });
		const runtime = createExtensionContext({
			...integrationIo(),
			...noExtensionI18n(),
			id: "bridge",
			host: host.ctx,
			loggerOf: host.loggerOf,
			mounts,
			...coreStubs(),
		});
		let ran = 0;
		const fired = runtime.ctx.setTimeout(() => ran++, 1000);
		const pendingOne = runtime.ctx.setTimeout(() => ran++, 1000);
		const cancelled = runtime.ctx.setTimeout(() => ran++, 1000);

		cancelled.dispose();
		expect(disposed).toEqual([2]);
		fires[0]?.();
		expect(ran).toBe(1);
		// 触发之后再 dispose:不出错,也不再去叫宿主那只已经跑完的定时器。
		expect(() => fired.dispose()).not.toThrow();
		expect(disposed).toEqual([2]);

		// 卸载只收还没触发的那一只(#1);跑完的 #0 早已放掉。
		await runtime.dispose();
		expect(disposed).toEqual([2, 1]);
		pendingOne.dispose();
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
		const mounts = createExtensionMounts({ logger: silentLogger });
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);
		const a = createExtensionContext({
			...integrationIo(),
			...noExtensionI18n(),
			id: "a",
			host: host.ctx,
			loggerOf: host.loggerOf,
			mounts,
			...coreStubs(),
		});
		const b = createExtensionContext({
			...integrationIo(),
			...noExtensionI18n(),
			id: "b",
			host: host.ctx,
			loggerOf: host.loggerOf,
			mounts,
			...coreStubs(),
		});
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

/** 问题上报与 `signal`:拓展的上下文继承集成的上下文,报的人是拓展 id,停用时清,被拒的只记 warn。 */
describe("拓展 ctx · reportProblem / resolveProblem / signal", () => {
	it("activate 拿到的 reportProblem 进问题表,报的人是拓展 id;停用后清掉", async () => {
		const { ctx, runtime, problems } = makeRuntime("fake-source");
		ctx.reportProblem({ code: "upstream_down", message: "对面连不上" });
		expect(problems.list()).toEqual([
			{
				reporter: "fake-source",
				code: "upstream_down",
				message: "对面连不上",
				since: expect.any(String),
			},
		]);
		ctx.resolveProblem({ code: "upstream_down" });
		expect(problems.list()).toEqual([]);

		ctx.reportProblem({ code: "upstream_down", message: "又连不上了" });
		await runtime.dispose();
		expect(problems.list()).toEqual([]);
	});

	it("ctx.signal 在停用时中止,原因是 AbortError", async () => {
		const { ctx, runtime } = makeRuntime();
		expect(ctx.signal.aborted).toBe(false);
		await runtime.dispose();
		expect(ctx.signal.aborted).toBe(true);
		expect((ctx.signal.reason as DOMException).name).toBe("AbortError");
	});

	it("ctx.redact 经存储把手登记在这个拓展名下,连续登记不互相冲掉;停用后撤掉", async () => {
		const host = fakeHost();
		const mounts = createExtensionMounts({ logger: silentLogger });
		const redactor = createValueRedactor();
		const runtime = createExtensionContext({
			...integrationIo(),
			...noExtensionI18n(),
			id: "bridge",
			host: host.ctx,
			loggerOf: host.loggerOf,
			mounts,
			...coreStubs(),
			stores: {
				...memoryStores(),
				// 与真把手同形状:归属是把手的集成,同一种整批换。
				redact: (kind, values) => redactor.replace("bridge", kind, values),
			},
		});
		runtime.ctx.redact("FAKE-EXT-TOKEN-0001");
		runtime.ctx.redact("FAKE-EXT-TOKEN-0002");
		expect(redactor.scrub("FAKE-EXT-TOKEN-0001 FAKE-EXT-TOKEN-0002")).toBe("*** ***");
		await runtime.dispose();
		expect(redactor.scrub("FAKE-EXT-TOKEN-0001 FAKE-EXT-TOKEN-0002")).toBe(
			"FAKE-EXT-TOKEN-0001 FAKE-EXT-TOKEN-0002",
		);
	});

	it("报坏 code:不进问题表,问题上报与上报出入各记一行 warn(不是 error)", () => {
		const { host, ctx, problems } = makeRuntime();
		ctx.reportProblem({ code: "Bad Code", message: "x" });
		expect(problems.list()).toEqual([]);
		expect(host.lines.filter((l) => l.startsWith("warn bridge:"))).toHaveLength(2);
		expect(host.lines.filter((l) => l.startsWith("error "))).toEqual([]);
	});
});
