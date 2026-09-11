/**
 * 加载器 —— 把「扫出来的目录」「主人按的开关」「失败记账」「窄面 ctx」串成一条。
 *
 * 钉的几条:
 * - **没启用就不 import**(清单存在的三条理由之一:没启用的拓展不该有一行代码跑起来)
 * - **半个拓展不许留在那**:`activate` 中途抛了,它此前注册的定时器 / 端点当场回收
 * - **一个炸了不牵连另一个**
 * - 连着失败到上限 → 自动停用,不再 import
 * - **记账落在装载目录**,绝不写进某个拓展自己的目录(开发版那份是仓库工作树的软链)
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_API_VERSION, type Logger, type ServiceContext } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createAdapterRegistry } from "../../platforms/registry.js";
import type { ExtensionContext } from "../context.js";
import { readLoadLedger } from "../load-ledger.js";
import { loadExtensions } from "../loader.js";
import { createExtensionMounts, EXTENSION_MOUNT_PREFIX } from "../mount.js";
import { createExtensionUpgrades } from "../upgrade.js";

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
		settings: () => undefined,
		onSettingsChanged: () => ({ dispose() {} }),
		inbound: {},
		upgrades: createExtensionUpgrades(),
	};
}

function run(opts: {
	host: ReturnType<typeof fakeHost>;
	mounts: ReturnType<typeof createExtensionMounts>;
	enabled?: (id: string) => boolean;
	maxFailures?: number;
	importModule?: (specifier: string) => Promise<unknown>;
}) {
	return loadExtensions({
		root,
		host: opts.host.ctx,
		mounts: opts.mounts,
		isEnabled: opts.enabled ?? (() => true),
		maxFailures: opts.maxFailures ?? 3,
		importModule: opts.importModule,
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

describe("拓展声明的密钥字段", () => {
	it("跑起来的拓展把它的 secret 键交出来 —— 备份脱敏照这份抹", async () => {
		await plant("bridge", "export function activate() {}");
		const registry = createAdapterRegistry();
		const loaded = await loadExtensions({
			root,
			host: fakeHost().ctx,
			mounts: createExtensionMounts(),
			upgrades: createExtensionUpgrades(),
			adapters: registry,
			connections: () => [],
			onConnectionsChanged: () => ({ dispose() {} }),
			settings: () => undefined,
			onSettingsChanged: () => ({ dispose() {} }),
			inbound: {},
			isEnabled: () => true,
			maxFailures: 3,
			// ⚠️ 换掉 import:真拓展包会把 zod 内联进自己的产物,而这里种的是一行裸 mjs。
			importModule: async () => ({
				activate(ctx: ExtensionContext) {
					ctx.registerPushSource({
						adapter: { platforms: [], isAvailable: () => true } as never,
						descriptor: {} as never,
						configSchema: z.object({ botKey: z.string(), note: z.string().optional() }),
						configFields: [
							{ kind: "text", code: "botKey", label: "密钥", secret: true },
							{ kind: "text", code: "note", label: "备注" },
						],
					});
				},
			}),
		});

		expect(loaded.list()[0]?.state).toBe("running");
		// 只有声明过的那一格 —— `note` 不该被抹。按 id 分格:声明的键只对它自己那两格生效。
		expect(loaded.secretConfigCodes()).toEqual({ bridge: ["botKey"] });

		// 收摊之后它**不在表里** —— 在脱敏那边这不是「什么都不抹」而是「整片当密钥」,
		// 见 `../backup/sanitize.ts` 的 ExtensionSecretCodes。
		await loaded.dispose();
		expect(loaded.secretConfigCodes()).toEqual({});
	});
});

/**
 * 装载目录那一层的规矩钉在 `discover.test.ts`,这里钉的是**加载器怎么用它** ——
 * 每条记录带着自己的位置,以及账记在哪。
 */
describe("装载目录", () => {
	/** 两份同名的摆在盘上时,「我改的是不是跑着的那个」只有全路径答得了。 */
	it("每条都带着自己的目录", async () => {
		await plant("bridge", HEALTHY);
		const loaded = await run({ host: fakeHost(), mounts: createExtensionMounts() });
		expect(loaded.list().map((e) => e.dir)).toEqual([join(root, "bridge")]);
	});

	/**
	 * 🔴 **账记在装载目录里,绝不写进某个拓展自己的目录。**
	 *
	 * 「这个拓展连炸了几次」是**这一台机器**的状态,与拓展本体同寿是错的:装的那份随时
	 * 会被换掉(升级 / 重装),记录跟着没。而开发版装进来的那份**是仓库工作树的软链** ——
	 * 往里写等于往 `git status` 里拉屎。
	 */
	it("失败记账落在装载目录,拓展自己那个目录一个文件都不多", async () => {
		await plant("boom", HEALTHY);
		await loadExtensions({
			root,
			host: fakeHost().ctx,
			mounts: createExtensionMounts(),
			isEnabled: () => true,
			maxFailures: 3,
			importModule: async () => {
				throw new Error("炸");
			},
			...coreStubs(),
		});

		expect((await readdir(root)).sort()).toEqual(["boom", "load-state.json"]);
		expect((await readdir(join(root, "boom"))).sort()).toEqual(["extension.json", "index.mjs"]);
	});
});

/**
 * 🔴 **显式重载:开发版才有的「换掉代码」。**
 *
 * ESM 的模块缓存删不掉 —— 这正是决策 10 写「开关热、代码不热」的原因。但**换个 URL 就是
 * 一份新模块**(`?v=<mtime>`),所以「换代码」这件事在开发版里做得到,代价是旧模块回收
 * 不掉(每重载一次漏一份)。
 *
 * ⚠️ **刻意不挂在开关上**:拨开关要保持**生产语义**(复用模块缓存),否则开发版比生产
 * 宽容 —— 拓展模块顶层存了状态,生产里第二次启用会残留,开发里却次次干净,那种 bug
 * 只在真机上露面。要新代码就显式说一声。
 */
describe("重载(开发版换代码)", () => {
	it("重载换一个 URL 再 import —— 拨开关不换", async () => {
		await plant("bridge", HEALTHY);
		const seen: string[] = [];
		let on = true;
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts(),
			enabled: () => on,
			importModule: async (specifier) => {
				seen.push(specifier);
				return { activate() {} };
			},
		});

		// 关再开:走的还是生产那条路,同一个 URL(于是拿到的是模块缓存里那份)。
		on = false;
		await loaded.sync();
		on = true;
		await loaded.sync();
		expect(new Set(seen).size).toBe(1);

		await loaded.reload("bridge");
		expect(seen).toHaveLength(3);
		expect(seen[2]).not.toBe(seen[0]);
		expect(seen[2]).toContain("?v=");
	});

	it("重载先收摊 —— 旧那份注册的东西不会留下", async () => {
		await plant("bridge", HEALTHY);
		const host = fakeHost();
		const mounts = createExtensionMounts();
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);

		const loaded = await run({ host, mounts });
		expect(host.pending()).toBe(1);

		await loaded.reload("bridge");
		// 定时器还是一个:旧那份收了,新那份又注册了一个。漏收的话这里是 2。
		expect(host.pending()).toBe(1);
		expect(await (await app.request("/ext/bridge/x")).text()).toBe("hi from bridge");
		expect(loaded.list().map((e) => e.state)).toEqual(["running"]);
	});

	/**
	 * 🔴 **重载不记账。** 记账防的是「开机反复炸」,而重载是主人**手按的**:改一行、崩一次、
	 * 再改一行,三次就被自动停用的话,开发循环当场卡死,还得去删记账文件。
	 */
	it("连着重载失败也不会被自动停用,改好了下一发就起来", async () => {
		await plant("bridge", HEALTHY);
		let boom = true;
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts(),
			maxFailures: 3,
			importModule: async () => {
				if (boom) throw new Error("炸");
				return { activate() {} };
			},
		});

		boom = true;
		for (let i = 0; i < 4; i++) await loaded.reload("bridge");
		expect(loaded.list().map((e) => e.state)).toEqual(["failed"]);

		boom = false;
		await loaded.reload("bridge");
		expect(loaded.list().map((e) => e.state)).toEqual(["running"]);
	});

	it("关着的拓展不给重载 —— 那是开关的活", async () => {
		await plant("bridge", HEALTHY);
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts(),
			enabled: () => false,
		});
		await expect(loaded.reload("bridge")).rejects.toThrow(/关着/);
	});

	/**
	 * 🔴 **一次重载失败,不许把后面的队列毒死。** 队列是 `queue = queue.then(...)`:
	 * 让一发拒绝留在队尾的话,之后**每一次 `sync()` 都会被那条 rejected promise 跳过** ——
	 * 症状是「重载报了个错之后,开关就再也拨不动了」,而且不报错。
	 */
	it("重载抛过之后,开关照样拨得动", async () => {
		await plant("bridge", HEALTHY);
		const loaded = await run({ host: fakeHost(), mounts: createExtensionMounts() });
		await expect(loaded.reload("nobody")).rejects.toThrow();

		let on = true;
		const again = await run({ host: fakeHost(), mounts: createExtensionMounts() });
		await expect(again.reload("nobody")).rejects.toThrow();
		on = false;
		void on;
		await loaded.sync();
		expect(loaded.list().map((e) => e.state)).toEqual(["running"]);
	});

	it("没这个拓展 → 抛,别装作重载过了", async () => {
		const loaded = await run({ host: fakeHost(), mounts: createExtensionMounts() });
		await expect(loaded.reload("nobody")).rejects.toThrow(/nobody/);
	});
});

/**
 * 🔴 **拨开关即热装卸**(ADR-0012 决策 10)。
 *
 * 热的是**副作用**,不是代码:`sync()` 收回 / 重新登记拓展注册过的那些东西,而那份
 * 模块本身在进程里换不掉。所以下面第二条才是真正要钉的 —— 第二次启用时 `import()` 拿到
 * 的是**缓存里那份**,只有 `activate` 会再跑一遍。拓展的模块顶层因此不许存状态。
 *
 * 第三条钉的是**判据**:`sync()` 只认「开关变了」,不认「现在跑没跑」。按后者写的话,
 * 一个加载失败的拓展会在主人每存一次全局设置时重试一次,几下就把失败记账烧到自动停用。
 */
describe("拨开关即热装卸", () => {
	it("关掉 → 它注册的东西当场没了,身份还列得出来", async () => {
		await plant("bridge", HEALTHY);
		const host = fakeHost();
		const mounts = createExtensionMounts();
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);
		let on = true;

		const loaded = await run({ host, mounts, enabled: () => on });
		expect(host.pending()).toBe(1);

		on = false;
		await loaded.sync();

		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([["bridge", "disabled"]]);
		expect(host.pending()).toBe(0);
		expect((await app.request("/ext/bridge/x")).status).toBe(404);
	});

	it("再打开 → activate 又跑了一遍(ESM 模块缓存不挡二次启用)", async () => {
		await plant("bridge", HEALTHY);
		const host = fakeHost();
		const mounts = createExtensionMounts();
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);
		let on = true;

		const loaded = await run({ host, mounts, enabled: () => on });
		on = false;
		await loaded.sync();
		on = true;
		await loaded.sync();

		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([["bridge", "running"]]);
		// 定时器与端点都是 `activate` 现场注册的 —— 它们回来了就等于 activate 又跑了一遍。
		expect(host.pending()).toBe(1);
		expect(await (await app.request("/ext/bridge/x")).text()).toBe("hi from bridge");
	});

	it("开关没动过 → sync 一行代码都不重新 import", async () => {
		await plant("bridge", HEALTHY);
		const imported: string[] = [];
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts(),
			importModule: (specifier) => {
				imported.push(specifier);
				return import(specifier);
			},
		});
		expect(imported).toHaveLength(1);

		await loaded.sync();
		await loaded.sync();

		expect(imported).toHaveLength(1);
	});

	it("加载失败的那个,开关不动就不重试 —— 否则每存一次全局设置就烧一次失败记账", async () => {
		await plant("bad", `export function activate() { throw new Error("炸"); }`);
		const loaded = await run({ host: fakeHost(), mounts: createExtensionMounts() });
		expect(loaded.list().map((e) => e.state)).toEqual(["failed"]);

		await loaded.sync();
		await loaded.sync();

		// 记账里只该有开机那一次 —— 再来两次就到上限、把一个只是暂时炸了的拓展判死。
		expect(readLoadLedger(root).blocked).toEqual([]);
		expect(loaded.list().map((e) => e.state)).toEqual(["failed"]);
	});

	it("关了又开、每次都炸 → 记账照样累加,到上限自动停用", async () => {
		await plant("bad", `export function activate() { throw new Error("炸"); }`);
		const host = fakeHost();
		let on = true;
		// 开机那次算第 1 笔,底下每拨一轮再来一笔。第 3 笔**当场**还是 failed(报的是真
		// 原因,比「已停用」有用),自动停用从第 4 次尝试起生效 —— 开机那条路也是这个次序。
		const loaded = await run({ host, mounts: createExtensionMounts(), enabled: () => on });
		for (let i = 0; i < 3; i++) {
			on = false;
			await loaded.sync();
			on = true;
			await loaded.sync();
		}
		expect(loaded.list().map((e) => e.state)).toEqual(["blocked"]);
		expect(loaded.list()[0]?.detail).toContain("连续加载失败");
	});

	/**
	 * 🔴 **队列里一发拒绝,不许把后面的都毒死。** 三条把手(`sync` / `rescan` / `reload`)
	 * 串在**同一条队**上,而队尾是 `queue = queue.then(...)`:让一个 rejected promise 留在
	 * 队尾的话,之后**每一次** `sync()` 的回调都不会跑 —— 症状是「开关再也拨不动了」,而且
	 * 没有任何人报错。`reload()` 那条钉在上面,这条钉 `sync()` 自己。
	 */
	it("sync() 抛过之后,下一次 sync() 照样跑得动", async () => {
		await plant("bridge", HEALTHY);
		let boom = false;
		let on = true;
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts(),
			// 开关是**现读**配置的:读那一下抛了(盘上那份正被换掉),整趟 sync 就是一发拒绝。
			enabled: () => {
				if (boom) throw new Error("读开关炸了");
				return on;
			},
		});
		expect(loaded.list().map((e) => e.state)).toEqual(["running"]);

		boom = true;
		await expect(loaded.sync()).rejects.toThrow(/读开关/);

		boom = false;
		on = false;
		await loaded.sync();
		expect(loaded.list().map((e) => e.state)).toEqual(["disabled"]);
	});
});

/**
 * 🔴 **装 / 卸也是热的**(2026-09-10 补;原先要重启一次才进出拓展页)。
 *
 * 决策 10 否掉的只有「**换掉已加载的代码**」—— ESM 模块缓存删不掉。而一个**新出现的 id**
 * 从来没被 import 过,它第一次 import 与「拨开关第一次启用」是同一档事实,没有缓存这回事。
 * 之所以曾经要重启,纯粹是因为开机扫一次就把名单定死了。
 *
 * 🔴 **两边都有的一律不碰**:重扫顺手把跑着的那份换掉的话,「装」就把「重载」的语义
 * 偷偷做了 —— 而那是开发版专用、每次漏一份模块的路(决策 39)。
 */
describe("重扫(装 / 卸不必重启)", () => {
	it("新装进来的当场跑起来 —— 不用重启", async () => {
		const host = fakeHost();
		const mounts = createExtensionMounts();
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);

		const loaded = await run({ host, mounts });
		expect(loaded.list()).toEqual([]);

		await plant("bridge", HEALTHY);
		await loaded.rescan();

		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([["bridge", "running"]]);
		expect(await (await app.request("/ext/bridge/x")).text()).toBe("hi from bridge");
		expect(host.pending()).toBe(1);
	});

	it("卸掉的当场收摊 —— 定时器与端点跟着走,列表里也没了", async () => {
		await plant("bridge", HEALTHY);
		const host = fakeHost();
		const mounts = createExtensionMounts();
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);

		const loaded = await run({ host, mounts });
		expect(host.pending()).toBe(1);

		await rm(join(root, "bridge"), { recursive: true, force: true });
		await loaded.rescan();

		expect(loaded.list()).toEqual([]);
		expect(host.pending()).toBe(0);
		expect((await app.request("/ext/bridge/x")).status).toBe(404);
	});

	/**
	 * 🔴 目录内容变了也**不换** —— 那是 `reload()` 的活(开发版专用)。这里换掉的话,
	 * 生产会悄悄多出一条「换代码不重启」的路,而它每走一次漏一份模块。
	 */
	it("已经跑着的那份一行代码都不重新 import —— 换代码是「重载」的活", async () => {
		await plant("bridge", HEALTHY);
		const imported: string[] = [];
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts(),
			importModule: (specifier) => {
				imported.push(specifier);
				return import(specifier);
			},
		});
		expect(imported).toHaveLength(1);

		await plant(
			"bridge",
			`export function activate(ctx) { ctx.mount(async () => new Response("新的")); }`,
		);
		await loaded.rescan();

		expect(imported).toHaveLength(1);
	});

	it("新装进来但开关关着 → 列得出来,一行代码都不 import", async () => {
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts(),
			enabled: () => false,
		});
		// import 一下就会抛的代码:只要它没被 import,这条就绿。
		await plant("bridge", `throw new Error("不该被 import");`);
		await loaded.rescan();

		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([["bridge", "disabled"]]);
	});

	/**
	 * 🔴 **进的是热装卸那份名单,不只是面板上那一行。** 只往列表里画一行的话,症状是
	 * 「装完看得见,拨开关没反应」—— 而两头都不报错。
	 */
	it("新装进来的进得了热装卸名单 —— 拨开关当场装上", async () => {
		let on = false;
		const host = fakeHost();
		const loaded = await run({ host, mounts: createExtensionMounts(), enabled: () => on });

		await plant("bridge", HEALTHY);
		await loaded.rescan();
		expect(loaded.list().map((e) => e.state)).toEqual(["disabled"]);

		on = true;
		await loaded.sync();
		expect(loaded.list().map((e) => e.state)).toEqual(["running"]);
		expect(host.pending()).toBe(1);
	});

	it("卸掉的从热装卸名单里也删干净 —— 之后拨开关不会把它招回来", async () => {
		await plant("bridge", HEALTHY);
		let on = true;
		const host = fakeHost();
		const loaded = await run({ host, mounts: createExtensionMounts(), enabled: () => on });

		on = false;
		await loaded.sync();
		await rm(join(root, "bridge"), { recursive: true, force: true });
		await loaded.rescan();
		on = true;
		await loaded.sync();

		expect(loaded.list()).toEqual([]);
		expect(host.pending()).toBe(0);
	});

	/**
	 * 🔴 判据是「**进没进装载名单**」,不是「面板上有没有这一行」。按后者写的话,一份
	 * 清单写坏了的拓展会被永远钉死在 unreadable 上 —— 主人改好那一行,重扫说没变化,
	 * 而唯一的出路是重启,正是这一整片要去掉的东西。
	 */
	it("清单坏了的那条重扫会重读 —— 主人修好了当场就装得上", async () => {
		await mkdir(join(root, "bridge"), { recursive: true });
		await writeFile(join(root, "bridge", "extension.json"), "{ 不是 JSON");
		const loaded = await run({ host: fakeHost(), mounts: createExtensionMounts() });
		expect(loaded.list().map((e) => e.state)).toEqual(["unreadable"]);

		await plant("bridge", HEALTHY);
		await loaded.rescan();

		expect(loaded.list().map((e) => e.state)).toEqual(["running"]);
	});

	it("新装的按 id 归位 —— 现在这个次序就是重启之后的次序", async () => {
		await plant("zeta", HEALTHY);
		const loaded = await run({ host: fakeHost(), mounts: createExtensionMounts() });

		await plant("alpha", HEALTHY);
		await loaded.rescan();

		expect(loaded.list().map((e) => e.id)).toEqual(["alpha", "zeta"]);
	});

	it("新装进来的清单坏了 → 照样列出来说清楚,不是一声不响地没有", async () => {
		const loaded = await run({ host: fakeHost(), mounts: createExtensionMounts() });

		await mkdir(join(root, "junk"), { recursive: true });
		await writeFile(join(root, "junk", "extension.json"), "{ 不是 JSON");
		await loaded.rescan();

		const entry = loaded.list()[0];
		expect(entry?.state).toBe("unreadable");
		expect(entry?.detail).toContain("JSON");
	});
});
