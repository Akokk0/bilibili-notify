/**
 * 加载器 —— 把「扫出来的目录」「主人按的开关」「失败记账」「窄面 ctx」串成一条。
 *
 * 钉的几条:
 * - **没启用就不 import**(清单存在的三条理由之一:没启用的拓展不该有一行代码跑起来)
 * - **半个拓展不许留在那**:`activate` 中途抛了,它此前注册的定时器 / 端点当场回收
 * - **一个炸了不牵连另一个**
 * - 连着失败到上限 → 自动停用,不再 import
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_API_VERSION, type Logger, type ServiceContext } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createAdapterRegistry } from "../../platforms/registry.js";
import { loadExtensions } from "../loader.js";
import { createExtensionMounts, EXTENSION_MOUNT_PREFIX } from "../mount.js";

let root: string;

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
	return { ctx, lines, pending: () => timers.size };
}

async function plant(id: string, code: string, over: Record<string, unknown> = {}): Promise<void> {
	const dir = join(root, id);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "extension.json"),
		JSON.stringify({
			id,
			name: id,
			description: "测试用",
			version: "1.0.0",
			apiVersion: EXTENSION_API_VERSION,
			provides: ["push"],
			...over,
		}),
	);
	await writeFile(join(dir, "index.mjs"), code);
}

/** 一个正常的拓展:挂一条路由 + 起一个定时器,好让「有没有真跑起来」看得见。 */
const HEALTHY = `export function activate(ctx) {
	ctx.setInterval(() => {}, 1000);
	ctx.mount(async () => new Response("hi from " + ctx.id));
}`;

/** 与核心打交道那几格在 `context-grants.test.ts` 里钉;这里只关心装载。 */
function coreStubs() {
	return {
		adapters: createAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		inbound: {},
	};
}

function run(opts: {
	host: ReturnType<typeof fakeHost>;
	mounts: ReturnType<typeof createExtensionMounts>;
	enabled?: (id: string) => boolean;
	maxFailures?: number;
}) {
	return loadExtensions({
		root,
		host: opts.host.ctx,
		mounts: opts.mounts,
		isEnabled: opts.enabled ?? (() => true),
		maxFailures: opts.maxFailures ?? 3,
		...coreStubs(),
	});
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bn-ext-loader-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("加载拓展", () => {
	it("启用着的正常拓展 → 跑起来,它注册的东西真的在", async () => {
		await plant("bridge", HEALTHY);
		const host = fakeHost();
		const mounts = createExtensionMounts();
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);

		const loaded = await run({ host, mounts });
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([["bridge", "running"]]);
		expect(await (await app.request("/ext/bridge/x")).text()).toBe("hi from bridge");
		expect(host.pending()).toBe(1);

		await loaded.dispose();
		expect(host.pending()).toBe(0);
		expect((await app.request("/ext/bridge/x")).status).toBe(404);
	});

	it("开关关着 → **一行代码都不 import**,但照样列得出来", async () => {
		// import 一下就会抛的代码:只要它没被 import,这条就绿。
		await plant("bridge", `throw new Error("不该被 import");`);
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts(),
			enabled: () => false,
		});
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([["bridge", "disabled"]]);
	});

	it("activate 抛了 → 记一笔失败,而且它此前注册的东西当场回收", async () => {
		await plant(
			"bad",
			`export function activate(ctx) {
				ctx.setInterval(() => {}, 1000);
				ctx.mount(async () => new Response("半个"));
				throw new Error("activate 炸了");
			}`,
		);
		const host = fakeHost();
		const mounts = createExtensionMounts();
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);

		const loaded = await run({ host, mounts });
		const entry = loaded.list()[0];
		expect(entry?.state).toBe("failed");
		expect(entry?.detail).toContain("activate 炸了");
		// 半个拓展不许留在那 —— 定时器和端点都得跟着走。
		expect(host.pending()).toBe(0);
		expect((await app.request("/ext/bad/x")).status).toBe(404);
	});

	it("代码 import 不进来(语法错)→ 也是 failed,身份还在", async () => {
		await plant("broken", `export function activate( {`);
		const loaded = await run({ host: fakeHost(), mounts: createExtensionMounts() });
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([["broken", "failed"]]);
	});

	it("没有 activate 导出 → failed,不是「跑起来了」", async () => {
		await plant("silent", `export const nothing = 1;`);
		const loaded = await run({ host: fakeHost(), mounts: createExtensionMounts() });
		const entry = loaded.list()[0];
		expect(entry?.state).toBe("failed");
		expect(entry?.detail).toContain("activate");
	});

	it("一个炸了,别的照样加载", async () => {
		await plant("bad", `throw new Error("炸");`);
		await plant("good", HEALTHY);
		const loaded = await run({ host: fakeHost(), mounts: createExtensionMounts() });
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([
			["bad", "failed"],
			["good", "running"],
		]);
	});

	it("连着失败到上限 → 自动停用,再开机直接不 import", async () => {
		await plant("bad", `throw new Error("炸");`);
		for (let i = 0; i < 2; i++) {
			await run({ host: fakeHost(), mounts: createExtensionMounts(), maxFailures: 2 });
		}
		const loaded = await run({ host: fakeHost(), mounts: createExtensionMounts(), maxFailures: 2 });
		const entry = loaded.list()[0];
		expect(entry?.state).toBe("blocked");
		expect(entry?.detail).toContain("连续");
	});

	it("跑起来了就销账 —— 偶发一次失败不会一路累加把好拓展判死", async () => {
		// ⚠️ 这一条**必须**换掉 import:同一个进程里 ESM 模块换不掉(决策 10 认下的那笔代价),
		// 同一个路径 import 第二次拿回的是第一次那份(连它抛的错都是同一个)。而这里要钉的是
		// 记账那条线,不是 ESM 的缓存语义 —— 真实世界里三次「开机」本来就是三个进程。
		await plant("flaky", "export function activate() {}");
		const attempts = ["炸", null, "再炸"];
		let round = 0;
		const importModule = async () => {
			const boom = attempts[round++];
			if (boom) throw new Error(boom);
			return { activate() {} };
		};

		const runOnce = () =>
			loadExtensions({
				root,
				host: fakeHost().ctx,
				mounts: createExtensionMounts(),
				isEnabled: () => true,
				maxFailures: 2,
				importModule,
				...coreStubs(),
			});

		expect((await runOnce()).list()[0]?.state).toBe("failed");
		expect((await runOnce()).list()[0]?.state).toBe("running");
		// 销过账了,所以这次失败又是从头数,而不是当场判死。
		expect((await runOnce()).list()[0]?.state).toBe("failed");
	});

	it("清单坏了 / 版本不合 → 不 import,原样列出来带原因", async () => {
		await plant("future", HEALTHY, { apiVersion: EXTENSION_API_VERSION + 1 });
		await mkdir(join(root, "junk"), { recursive: true });
		await writeFile(join(root, "junk", "extension.json"), "{ 半个");
		const loaded = await run({ host: fakeHost(), mounts: createExtensionMounts() });
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([
			["future", "incompatible"],
			["junk", "unreadable"],
		]);
	});
});
