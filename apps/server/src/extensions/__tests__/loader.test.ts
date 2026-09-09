/**
 * 加载器 —— 把「扫出来的目录」「主人按的开关」「失败记账」「窄面 ctx」串成一条。
 *
 * 钉的几条:
 * - **没启用就不 import**(清单存在的三条理由之一:没启用的拓展不该有一行代码跑起来)
 * - **半个拓展不许留在那**:`activate` 中途抛了,它此前注册的定时器 / 端点当场回收
 * - **一个炸了不牵连另一个**
 * - 连着失败到上限 → 自动停用,不再 import
 * - **入口按根算**:源码根那份 import 的是 `src/index.ts`
 * - **记账固定落在 `<dataDir>`**,不跟着拓展自己那个根走
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EXTENSION_API_VERSION, type Logger, type ServiceContext } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createAdapterRegistry } from "../../platforms/registry.js";
import type { ExtensionContext } from "../context.js";
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
		inbound: {},
		upgrades: createExtensionUpgrades(),
	};
}

function run(opts: {
	host: ReturnType<typeof fakeHost>;
	mounts: ReturnType<typeof createExtensionMounts>;
	enabled?: (id: string) => boolean;
	maxFailures?: number;
}) {
	return loadExtensions({
		roots: [{ kind: "data", dir: root }],
		ledgerRoot: root,
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
				roots: [{ kind: "data", dir: root }],
				ledgerRoot: root,
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
			roots: [{ kind: "data", dir: root }],
			ledgerRoot: root,
			host: fakeHost().ctx,
			mounts: createExtensionMounts(),
			upgrades: createExtensionUpgrades(),
			adapters: registry,
			connections: () => [],
			onConnectionsChanged: () => ({ dispose() {} }),
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
		// 只有声明过的那一格 —— `note` 不该被抹。
		expect(loaded.secretConfigCodes()).toEqual(["botKey"]);

		await loaded.dispose();
		expect(loaded.secretConfigCodes()).toEqual([]);
	});
});

/**
 * 多根(ADR-0012 决策 34/35)。扫目录那一层的规矩钉在 `discover.test.ts`,这里钉的是
 * **加载器怎么用它** —— 入口 import 哪个文件、账记在哪、被盖住时谁出声。
 */
describe("多根", () => {
	let repoDir: string;

	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpdir(), "bn-ext-loader-source-"));
	});

	afterEach(async () => {
		await rm(repoDir, { recursive: true, force: true });
	});

	/** 摆一份**源码形态**的拓展:入口在 `src/index.ts`,而不是平级的 `index.mjs`。 */
	async function plantSource(id: string, into: string): Promise<string> {
		const dir = join(into, id);
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(
			join(dir, "extension.json"),
			JSON.stringify({
				id,
				name: id,
				description: "测试用",
				version: "1.0.0",
				apiVersion: EXTENSION_API_VERSION,
				provides: ["push"],
			}),
		);
		await writeFile(join(dir, "src", "index.ts"), "export function activate() {}");
		return dir;
	}

	/**
	 * 源码根那份 import 的是 `src/index.ts`。
	 *
	 * ⚠️ 这里换掉 import:真跑起来靠的是 tsx 那层 loader(dev 才有),而要钉的是
	 * **宿主算出来交给 import 的是哪个文件**,不是 TypeScript 能不能被 import。
	 */
	it("源码根:import 的是 src/index.ts,不是 index.mjs", async () => {
		const dir = await plantSource("dev-ext", repoDir);
		const seen: string[] = [];
		const loaded = await loadExtensions({
			roots: [{ kind: "source", dir: repoDir }],
			ledgerRoot: root,
			host: fakeHost().ctx,
			mounts: createExtensionMounts(),
			isEnabled: () => true,
			maxFailures: 3,
			importModule: async (specifier) => {
				seen.push(specifier);
				return { activate() {} };
			},
			...coreStubs(),
		});

		expect(loaded.list().map((e) => [e.id, e.state, e.origin])).toEqual([
			["dev-ext", "running", "source"],
		]);
		expect(seen).toEqual([pathToFileURL(join(dir, "src", "index.ts")).href]);
	});

	/**
	 * 🔴 **账记在 `<dataDir>`,不记在拓展自己那个根里。**
	 *
	 * 记在载荷根 = 升级换掉整个目录,连着失败的记录跟着没;记在源码根 = 往仓库工作树里
	 * 拉屎。而「这个拓展连炸了几次」本来就是**这一台机器**的状态,与拓展本体同寿是错的。
	 */
	it("失败记账落在 ledgerRoot,拓展所在的那个根一个文件都不多", async () => {
		const dir = await plantSource("boom", repoDir);
		await loadExtensions({
			roots: [{ kind: "source", dir: repoDir }],
			ledgerRoot: root,
			host: fakeHost().ctx,
			mounts: createExtensionMounts(),
			isEnabled: () => true,
			maxFailures: 3,
			importModule: async () => {
				throw new Error("炸");
			},
			...coreStubs(),
		});

		expect(await readdir(root)).toEqual(["load-state.json"]);
		// 拓展那个根里只有它自己那个目录 —— 没被写进任何东西。
		expect(await readdir(repoDir)).toEqual(["boom"]);
		expect((await readdir(dir)).sort()).toEqual(["extension.json", "src"]);
	});

	/**
	 * 🔴 **被盖住要出声。**
	 *
	 * 剪掉加载器接给 `discoverExtensions` 的那个 `onShadowed`,扫目录那一层照样对(它自己
	 * 的测试全绿)、拓展照样跑 —— 只是主人再也不知道跑的是哪一份。这条就是那根线的守卫。
	 */
	it("同一个 id 两个根都有 → 用高优先级那份,并且**日志里说得出**盖住了谁", async () => {
		// 仓里改着一份,`<dataDir>` 里还装着一份 —— 开发时最容易撞上的正是这一幕。
		await plantSource("bridge", repoDir);
		await plant("bridge", HEALTHY);

		const host = fakeHost();
		const loaded = await loadExtensions({
			roots: [
				{ kind: "source", dir: repoDir },
				{ kind: "data", dir: root },
			],
			ledgerRoot: root,
			host: host.ctx,
			mounts: createExtensionMounts(),
			isEnabled: () => true,
			maxFailures: 3,
			...coreStubs(),
		});

		expect(loaded.list().map((e) => [e.id, e.state, e.origin])).toEqual([
			["bridge", "running", "source"],
		]);
		const warned = host.lines.filter((line) => line.startsWith("warn "));
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("bridge");
		expect(warned[0]).toContain(root);
		expect(warned[0]).toContain(repoDir);
	});
});
