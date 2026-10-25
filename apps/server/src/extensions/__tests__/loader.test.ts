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

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EXTENSION_API_RANGE,
	type Issue,
	type Json,
	type Logger,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { fixedLocale, switchableLocale } from "../../__tests__/support/fixed-locale.js";
import { ignoredProblems } from "../../__tests__/support/ignored-problems.js";
import { inertTransitImages } from "../../__tests__/support/integration-io.js";
import { memoryIntegrationStore } from "../../__tests__/support/memory-key-value-store.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import type { LocaleReader } from "../../i18n/locale-reader.js";
import type { IntegrationStoreHandle } from "../../integration-store/store.js";
import { createProblemTable, type ProblemTable } from "../../problems/problem-table.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import { ExtensionConflictError } from "../conflict-error.js";
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
		signal: new AbortController().signal,
		track: () => {},
	};
	// 拓展自己的日志器(按 id 要):行进同一份 `lines`,开头带上 id —— 真宿主里标签就是 id,这里用它代替标签,好断言是谁的行。
	const loggerOf = (id: string): Logger => ({
		info: (m) => lines.push(`info ${id}: ${m}`),
		warn: (m) => lines.push(`warn ${id}: ${m}`),
		error: (m) => lines.push(`error ${id}: ${m}`),
		debug: (m) => lines.push(`debug ${id}: ${m}`),
	});
	return { ctx, lines, loggerOf, pending: () => timers.size };
}

/** 装载器要的两格:宿主上下文,和按 id 要日志器。 */
function hostOpts(host: ReturnType<typeof fakeHost>) {
	return { host: host.ctx, loggerOf: host.loggerOf };
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
			apiVersion: 3,
			contributes: { push: { label: "测试", shortLabel: "测", color: "#000000" } },
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
		integrationStore: memoryIntegrationStore(),
		problems: ignoredProblems,
		adapters: createPlatformAdapterRegistry(),
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
	activateTimeoutMs?: number;
	disposeTimeoutMs?: number;
	/** 不给就用 `hostOpts` 里那个(每个 id 都回假宿主的日志器)。 */
	loggerOf?: (id: string) => Logger;
	/** 不给就一直是简中。 */
	locale?: LocaleReader;
	onStatusChanged?: (id: string) => void;
	/** 问题表的写口;不给就是什么都不记的那份。 */
	problems?: Pick<ProblemTable, "report" | "resolve" | "clearReporter">;
	/** 配置仓报「设置文件读不懂」的那张表:id → 原因。 */
	settingsIssue?: (id: string) => Issue | undefined;
}) {
	return loadExtensions({
		transitImages: inertTransitImages,
		locale: opts.locale ?? fixedLocale(),
		onStatusChanged: opts.onStatusChanged,
		root,
		...hostOpts(opts.host),
		...(opts.loggerOf ? { loggerOf: opts.loggerOf } : {}),
		mounts: opts.mounts,
		isEnabled: opts.enabled ?? (() => true),
		maxFailures: opts.maxFailures ?? 3,
		importModule: opts.importModule,
		activateTimeoutMs: opts.activateTimeoutMs,
		disposeTimeoutMs: opts.disposeTimeoutMs,
		...coreStubs(),
		...(opts.problems ? { problems: opts.problems } : {}),
		...(opts.settingsIssue ? { settingsIssue: opts.settingsIssue } : {}),
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
		const mounts = createExtensionMounts({ logger: silentLogger });
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
			mounts: createExtensionMounts({ logger: silentLogger }),
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
		const mounts = createExtensionMounts({ logger: silentLogger });
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
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([["broken", "failed"]]);
	});

	it("没有 activate 导出 → failed,不是「跑起来了」", async () => {
		await plant("silent", `export const nothing = 1;`);
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});
		const entry = loaded.list()[0];
		expect(entry?.state).toBe("failed");
		expect(entry?.detail).toContain("activate");
	});

	it("一个炸了,别的照样加载", async () => {
		await plant("bad", `throw new Error("炸");`);
		await plant("good", HEALTHY);
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([
			["bad", "failed"],
			["good", "running"],
		]);
	});

	it("连着失败到上限 → 自动停用,再开机直接不 import", async () => {
		await plant("bad", `throw new Error("炸");`);
		for (let i = 0; i < 2; i++) {
			await run({
				host: fakeHost(),
				mounts: createExtensionMounts({ logger: silentLogger }),
				maxFailures: 2,
			});
		}
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			maxFailures: 2,
		});
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
				transitImages: inertTransitImages,
				locale: fixedLocale(),
				root,
				...hostOpts(fakeHost()),
				mounts: createExtensionMounts({ logger: silentLogger }),
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

	/**
	 * 后起来的先收 —— 看的是**起来的次序**,不是 id 的次序:关了又开的那个排到最后,就先收它。
	 * 后建起来的东西通常依赖先建起来的,与单个拓展内部的收摊次序同一条道理。
	 */
	it("宿主收摊时按起来的次序倒着收", async () => {
		await plant("alpha", "export function activate() {}");
		await plant("zeta", "export function activate() {}");
		const order: string[] = [];
		let alphaOn = true;
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			enabled: (id) => id !== "alpha" || alphaOn,
			importModule: async () => ({
				activate(ctx: ExtensionContext) {
					ctx.onDispose(() => {
						order.push(ctx.id);
					});
				},
			}),
		});
		// 关了又开:alpha 现在是后起来的那个。
		alphaOn = false;
		await loaded.sync();
		order.length = 0;
		alphaOn = true;
		await loaded.sync();

		await loaded.dispose();
		expect(order).toEqual(["alpha", "zeta"]);
	});

	it("清单坏了 / 版本不合 → 不 import,原样列出来带原因", async () => {
		await plant("future", HEALTHY, { apiVersion: EXTENSION_API_RANGE.current + 1 });
		await mkdir(join(root, "junk"), { recursive: true });
		await writeFile(join(root, "junk", "extension.json"), "{ 半个");
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([
			["future", "incompatible"],
			["junk", "unreadable"],
		]);
		// 版本不合的那一行说得出是谁、该怎么办。
		const future = loaded.list()[0];
		expect(future?.identity?.name).toBeTruthy();
		expect(future?.detail).toContain("先升级 BN");
	});

	/** 第 1 版的退路已删:盘上还留着的第 1 版拓展不 import,原样列出来,出路是换它的新版(不是升级 BN)。 */
	it("第 1 版的拓展 → 不 import,列出来说「太旧、换它的新版」", async () => {
		await plant("bridge", HEALTHY, { apiVersion: 1, provides: ["push"], contributes: undefined });
		const imported: string[] = [];
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			importModule: async (specifier) => {
				imported.push(specifier);
				return {};
			},
		});
		const [bridge] = loaded.list();
		expect(bridge?.state).toBe("incompatible");
		expect(imported).toEqual([]);
		expect(bridge?.identity?.id).toBe("bridge");
		expect(bridge?.detail).toBe(
			`它是给宿主契约 v1 写的,这一版 BN 只认 v${EXTENSION_API_RANGE.current} —— 换它的新版`,
		);
		await loaded.dispose();
	});

	/** 档位对、要的契约小号比这台 BN 的高(ADR-0019 决策 59):与档位不合同一条路。 */
	it("要更高契约小号的拓展 → 不 import,原因写清要几号、BN 是几号、先升级 BN", async () => {
		const wants = EXTENSION_API_RANGE.revision + 1;
		await plant("douyin", HEALTHY, {
			apiVersion: 3,
			apiRevision: wants,
			provides: undefined,
			contributes: {
				subscription: {
					label: "抖音",
					shortLabel: "抖",
					color: "#fe2c55",
					supportedFeatures: ["post"],
				},
			},
		});
		const imported: string[] = [];
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			importModule: async (specifier) => {
				imported.push(specifier);
				return {};
			},
		});
		const [douyin] = loaded.list();
		expect(douyin?.state).toBe("incompatible");
		expect(imported).toEqual([]);
		expect(douyin?.detail).toContain(`小号 ${wants}`);
		expect(douyin?.detail).toContain(`只到小号 ${EXTENSION_API_RANGE.revision}`);
		expect(douyin?.detail).toContain("先升级 BN");
		await loaded.dispose();
	});
});

describe("拓展声明的密钥字段", () => {
	/**
	 * 密钥声明在**清单**里(ADR-0019 决策 17):没跑起来的也读得到,备份就能只抹那几格,
	 * 而不是整片当密钥 —— 「装好还没启用、先把 cookie 填了」正是最常见的那一刻。
	 */
	it("拓展没在跑也交得出密钥键 —— 照清单读,不等代码注册", async () => {
		await plant("douyin", HEALTHY, {
			apiVersion: 3,
			provides: undefined,
			settings: { fields: [{ key: "cookie", type: "string", label: "Cookie", secret: true }] },
			contributes: {
				subscription: {
					label: "抖音",
					shortLabel: "抖",
					color: "#fe2c55",
					supportedFeatures: ["post"],
				},
			},
		});
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			enabled: () => false,
		});
		expect(loaded.list()[0]?.state).toBe("disabled");
		expect(loaded.secretConfigCodes()).toEqual(new Map([["douyin", ["cookie"]]]));
	});

	/**
	 * 跑着的拓展两边都答得出:代码那份只有连接配置项里的密钥,清单那份还带着设置项里的。
	 * 清单说了算 —— 让代码那份盖过去的话,设置里的 cookie 就原样进备份。
	 */
	it("跑着时照清单那份(连设置项里的也算),不被代码交的那份盖掉", async () => {
		await plant("douyin", "export function activate() {}", {
			apiVersion: 3,
			provides: undefined,
			settings: { fields: [{ key: "cookie", type: "string", label: "Cookie", secret: true }] },
			contributes: {
				push: {
					label: "抖音",
					shortLabel: "抖",
					color: "#fe2c55",
					settingsFields: [
						{ key: "token", type: "string", label: "令牌", secret: true, required: true },
					],
				},
			},
		});
		const loaded = await loadExtensions({
			transitImages: inertTransitImages,
			locale: fixedLocale(),
			root,
			...hostOpts(fakeHost()),
			mounts: createExtensionMounts({ logger: silentLogger }),
			...coreStubs(),
			isEnabled: () => true,
			maxFailures: 3,
			// ⚠️ 换掉 import:种的是一行裸 mjs,拿不到 zod(同本组第一条)。
			importModule: async () => ({
				activate(ctx: ExtensionContext) {
					// 清单声明了设置项,就得交校验它们的 zod(ADR-0019 决策 35),不然按加载失败算。
					ctx.settings(z.object({ cookie: z.string().optional() }));
					ctx.registerPlatformAdapter({
						isAvailable: () => true,
						listConnectionCandidates: async () => [],
						probe: async () => ({ ok: true, latencyMs: 1 }),
						send: async () => ({ ok: true, latencyMs: 1 }),
						settingsSchema: z.object({ token: z.string() }),
						start() {},
						stop() {},
					});
				},
			}),
		});
		expect(loaded.list()[0]?.state).toBe("running");
		expect(loaded.secretConfigCodes()).toEqual(new Map([["douyin", ["cookie", "token"]]]));
	});

	/**
	 * 没有清单可读的(版本不合 / 清单读不了)**不进表** —— 脱敏与下发那边把「不在表里」当「问不出来」,
	 * 它名下连接的设置与它自己的设置整片当密钥。给它们补一个空表就成了「问得出来、确实没声明」,
	 * 那几格从此只走键名黑名单,而门禁一片绿。
	 */
	it("版本不合的与清单读不了的不进表(不是空表)", async () => {
		await plant("old", HEALTHY, { apiVersion: 1, provides: ["push"], contributes: undefined });
		await mkdir(join(root, "junk"), { recursive: true });
		await writeFile(join(root, "junk", "extension.json"), "{ 半个");
		// 第三个是清单读得出、一格密钥都没声明的:它**在**表里,是空表。
		await plant("plain", HEALTHY);
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			enabled: () => false,
		});
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([
			["junk", "unreadable"],
			["old", "incompatible"],
			["plain", "disabled"],
		]);
		expect(loaded.secretConfigCodes()).toEqual(new Map([["plain", []]]));
	});
});

/**
 * 每个拓展一个自己的请求客户端(ADR-0025 决策 6、17):身份存它自己的 `state`、停用时它的 websocket 跟着关。
 * 请求打到本地回环的 HTTP / WebSocket 服务。
 */
describe("拓展自己的请求客户端", () => {
	it("两个拓展各发一个请求:线上的 UA 各是各自存进自己 state 的身份;停用后它的 websocket 关", async () => {
		await plant("alpha", "export function activate() {}");
		await plant("beta", "export function activate() {}");
		const userAgents: string[] = [];
		const server = createHttpServer((req, res) => {
			userAgents.push(String(req.headers["user-agent"]));
			res.end("ok");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await new Promise<void>((resolve) => wss.once("listening", resolve));
		const wsUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/sub`;

		const store = memoryIntegrationStore();
		const handles = new Map<string, IntegrationStoreHandle>();
		const captured = new Map<string, ExtensionContext>();
		const loaded = await loadExtensions({
			transitImages: inertTransitImages,
			locale: fixedLocale(),
			root,
			...hostOpts(fakeHost()),
			mounts: createExtensionMounts({ logger: silentLogger }),
			...coreStubs(),
			integrationStore: {
				async open(key) {
					const handle = await store.open(key);
					handles.set(key, handle);
					return handle;
				},
			},
			isEnabled: () => true,
			maxFailures: 3,
			importModule: async (specifier) => ({
				activate(ctx: ExtensionContext) {
					captured.set(specifier.includes("alpha") ? "alpha" : "beta", ctx);
				},
			}),
		});
		try {
			const alpha = captured.get("alpha");
			const beta = captured.get("beta");
			if (!alpha || !beta) throw new Error("拓展没跑起来");
			await alpha.http.fetch(`${base}/a`);
			await beta.http.fetch(`${base}/b`);
			const identityOf = (id: string) =>
				handles.get(id)?.hostState.get<Json>("http.identity") as { userAgent: string };
			expect(userAgents).toEqual([identityOf("alpha").userAgent, identityOf("beta").userAgent]);

			const socket = alpha.http.websocket(wsUrl);
			if (!socket.ok) throw new Error("建连被拒");
			socket.socket.on("error", () => {});
			await new Promise<void>((resolve) => socket.socket.on("open", () => resolve()));
			const closed = new Promise<void>((resolve) => socket.socket.on("close", () => resolve()));

			await loaded.dispose();
			await closed;
		} finally {
			await loaded.dispose();
			for (const client of wss.clients) client.terminate();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
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
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});
		expect(loaded.list().map((e) => e.dir)).toEqual([join(root, "bridge")]);
	});

	/**
	 * 🔴 **账记在装载目录里,绝不写进某个拓展自己的目录。**
	 *
	 * 「这个拓展连炸了几次」是**这一台机器**的状态,与拓展本体同寿是错的:装的那份随时
	 * 会被换掉(升级 / 重装),记录跟着没。而开发版装进来的那份**是仓库工作树的软链** ——
	 * 往里写等于往 `git status` 里拉屎。
	 */
	/**
	 * 🔴 记账是启发,坏了不该让拓展起不来,更不该把开机带走 —— 但也不能一声不吭:写不进去的时候
	 * 「连着失败就自动停用」这道保护是**失效**的,一个真炸的拓展会每次开机都炸一遍。同一个错只记一行。
	 */
	it("失败记账写不进去 → 拓展照常加载,记一行说保护此刻不起作用", async () => {
		await plant("alpha", HEALTHY);
		await plant("zeta", HEALTHY);
		// 记账文件的位置被一个目录占着:读得到(当没记过),写不进去(rename 撞上目录)。
		await mkdir(join(root, "load-state.json"));
		const host = fakeHost();

		const loaded = await run({ host, mounts: createExtensionMounts({ logger: silentLogger }) });

		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([
			["alpha", "running"],
			["zeta", "running"],
		]);
		const warned = host.lines.filter((line) => /^warn .*失败记账写不进去/.test(line));
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("自动停用");
	});

	it("失败记账落在装载目录,拓展自己那个目录一个文件都不多", async () => {
		await plant("boom", HEALTHY);
		await loadExtensions({
			transitImages: inertTransitImages,
			locale: fixedLocale(),
			root,
			...hostOpts(fakeHost()),
			mounts: createExtensionMounts({ logger: silentLogger }),
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
	/**
	 * URL 按**入口指纹**定(ADR-0012 决策 47):代码没变,重载也不换 URL —— 换了就是白漏一份
	 * 旧模块;代码变了才换。
	 */
	it("代码变了,重载才换一个 URL 再 import —— 拨开关、代码没变的重载都不换", async () => {
		await plant("bridge", HEALTHY);
		const seen: string[] = [];
		let on = true;
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
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
		await loaded.reload("bridge");
		expect(seen).toHaveLength(3);
		expect(new Set(seen).size).toBe(1);

		await plant("bridge", `${HEALTHY}\n// 改了一行`);
		await loaded.reload("bridge");
		expect(seen).toHaveLength(4);
		expect(seen[3]).not.toBe(seen[0]);
		expect(seen[3]).toContain("?v=");
	});

	it("重载先收摊 —— 旧那份注册的东西不会留下", async () => {
		await plant("bridge", HEALTHY);
		const host = fakeHost();
		const mounts = createExtensionMounts({ logger: silentLogger });
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
			mounts: createExtensionMounts({ logger: silentLogger }),
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
			mounts: createExtensionMounts({ logger: silentLogger }),
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
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});
		await expect(loaded.reload("nobody")).rejects.toThrow();

		let on = true;
		const again = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});
		await expect(again.reload("nobody")).rejects.toThrow();
		on = false;
		void on;
		await loaded.sync();
		expect(loaded.list().map((e) => e.state)).toEqual(["running"]);
	});

	it("没这个拓展 → 抛,别装作重载过了", async () => {
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});
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
		const mounts = createExtensionMounts({ logger: silentLogger });
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
		const mounts = createExtensionMounts({ logger: silentLogger });
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

	// 验红:`loader.ts` 里 `createExtensionContext` 不收 `loggerOf: opts.loggerOf`、改回给宿主日志器拼 `[ext:<id>]`,这条红。
	it("每起一次都按拓展 id 向宿主要日志器,拓展的 ctx.logger 就是要来的那一个;停了再起,要到的还是同一个", async () => {
		await plant("bridge", `export function activate(ctx) { ctx.logger.info("起来了"); }`);
		const host = fakeHost();
		const mounts = createExtensionMounts({ logger: silentLogger });
		// 与真的 `forSubsystem(id, id)` 一样:同一个 id 交回同一个日志器。
		const byId = new Map<string, Logger>();
		const said: string[] = [];
		const loggerOf = vi.fn((id: string): Logger => {
			let made = byId.get(id);
			if (!made) {
				made = {
					info: (m) => said.push(`info ${id}: ${m}`),
					warn: (m) => said.push(`warn ${id}: ${m}`),
					error: (m) => said.push(`error ${id}: ${m}`),
					debug: (m) => said.push(`debug ${id}: ${m}`),
				};
				byId.set(id, made);
			}
			return made;
		});
		let on = true;

		const loaded = await run({ host, mounts, enabled: () => on, loggerOf });
		expect(loggerOf.mock.calls).toEqual([["bridge"]]);
		expect(said).toEqual(["info bridge: 起来了"]);

		on = false;
		await loaded.sync();
		on = true;
		await loaded.sync();

		expect(loggerOf.mock.calls).toEqual([["bridge"], ["bridge"]]);
		expect(loggerOf.mock.results[1]?.value).toBe(loggerOf.mock.results[0]?.value);
		expect(said).toEqual(["info bridge: 起来了", "info bridge: 起来了"]);
		// 宿主日志器(核心的)一行都没给拓展的话:`[ext]` 开头的是装载器自己的行,不在这里。
		expect(host.lines.filter((line) => line.includes("起来了"))).toEqual([]);
	});

	it("开关没动过 → sync 一行代码都不重新 import", async () => {
		await plant("bridge", HEALTHY);
		const imported: string[] = [];
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
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
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});
		expect(loaded.list().map((e) => e.state)).toEqual(["failed"]);

		await loaded.sync();
		await loaded.sync();

		// 记账里只该有开机那一次 —— 再来两次就到上限、把一个只是暂时炸了的拓展判死。
		expect(readLoadLedger(root).blocked).toEqual([]);
		expect(loaded.list().map((e) => e.state)).toEqual(["failed"]);
	});

	/**
	 * 存储打不开是环境的事,不是拓展崩了:不记到拓展头上、不触发自动停用(同「设置读不了不累进记账」)。
	 * 上限给 1:只要记过一笔,下一次就会被判死 —— 连着打不开三次、blocked 仍空,才说明真没记账。
	 */
	it("存储打不开 → 没起来(failed + 原因进日志),不进失败记账、不会被自动停用;环境好了照样起得来", async () => {
		await plant("bridge", HEALTHY);
		const host = fakeHost();
		const real = memoryIntegrationStore();
		let broken = true;
		let opens = 0;
		let on = true;
		const loaded = await loadExtensions({
			transitImages: inertTransitImages,
			locale: fixedLocale(),
			root,
			...hostOpts(host),
			mounts: createExtensionMounts({ logger: silentLogger }),
			...coreStubs(),
			integrationStore: {
				open: async (key) => {
					opens += 1;
					if (broken) throw new Error("磁盘炸了");
					return real.open(key);
				},
			},
			isEnabled: () => on,
			maxFailures: 1,
		});
		expect(loaded.list().map((e) => [e.state, e.detail])).toEqual([
			["failed", "存储打不开:磁盘炸了"],
		]);
		expect(host.lines.some((l) => l.startsWith("warn") && l.includes("磁盘炸了"))).toBe(true);

		// 再开关两轮:每轮都真去试了(没被自动停用挡在门外),记账里始终是空的。
		for (let i = 0; i < 2; i++) {
			on = false;
			await loaded.sync();
			on = true;
			await loaded.sync();
		}
		expect(opens).toBe(3);
		expect(readLoadLedger(root).blocked).toEqual([]);
		expect(loaded.list().map((e) => e.state)).toEqual(["failed"]);

		broken = false;
		on = false;
		await loaded.sync();
		on = true;
		await loaded.sync();
		expect(loaded.list().map((e) => e.state)).toEqual(["running"]);
		await loaded.dispose();
	});

	it("关了又开、每次都炸 → 记账照样累加,到上限自动停用", async () => {
		await plant("bad", `export function activate() { throw new Error("炸"); }`);
		const host = fakeHost();
		let on = true;
		// 开机那次算第 1 笔,底下每拨一轮再来一笔。第 3 笔**当场**还是 failed(报的是真
		// 原因,比「已停用」有用),自动停用从第 4 次尝试起生效 —— 开机那条路也是这个次序。
		const loaded = await run({
			host,
			mounts: createExtensionMounts({ logger: silentLogger }),
			enabled: () => on,
		});
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
			mounts: createExtensionMounts({ logger: silentLogger }),
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
		const mounts = createExtensionMounts({ logger: silentLogger });
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
		const mounts = createExtensionMounts({ logger: silentLogger });
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
			mounts: createExtensionMounts({ logger: silentLogger }),
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
			mounts: createExtensionMounts({ logger: silentLogger }),
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
		const loaded = await run({
			host,
			mounts: createExtensionMounts({ logger: silentLogger }),
			enabled: () => on,
		});

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
		const loaded = await run({
			host,
			mounts: createExtensionMounts({ logger: silentLogger }),
			enabled: () => on,
		});

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
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});
		expect(loaded.list().map((e) => e.state)).toEqual(["unreadable"]);

		await plant("bridge", HEALTHY);
		await loaded.rescan();

		expect(loaded.list().map((e) => e.state)).toEqual(["running"]);
	});

	/** 盘上没换过就不碰 —— 加载失败的那个也不借重扫重试(同 `sync()` 那条:开关不动就不重试)。 */
	it("加载失败的那个,盘上没换过 → 重扫不重试,也不多记一笔账", async () => {
		await plant("bad", `export function activate() { throw new Error("炸"); }`);
		const imported: string[] = [];
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			maxFailures: 2,
			importModule: (specifier) => {
				imported.push(specifier);
				return import(specifier);
			},
		});
		expect(loaded.list().map((e) => e.state)).toEqual(["failed"]);

		await loaded.rescan();
		await loaded.rescan();

		expect(imported).toHaveLength(1);
		// 上限是 2:重扫要是借机重试了,这里早就被判死了。
		expect(readLoadLedger(root).blocked).toEqual([]);
		expect(loaded.list().map((e) => e.state)).toEqual(["failed"]);
	});

	/**
	 * 🔴 **改盘是队里的一件事**(ADR-0019 决策 45):装包写到一半(清单落了、入口还没落)时,并发的
	 * 重扫要是插进来,看见的是一个「少了入口」的拓展 —— 面板上闪一张 unreadable,开关拨过的话还会
	 * 真去起它。写完、紧跟着那一遍重扫,两步之间谁都插不进来。
	 */
	it("改盘那一步在队里:写到一半时,排在后面的重扫看不见半个目录", async () => {
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let halfWritten!: () => void;
		const half = new Promise<void>((resolve) => {
			halfWritten = resolve;
		});

		const writing = loaded.changeDisk(async () => {
			await mkdir(join(root, "bridge"), { recursive: true });
			await writeFile(
				join(root, "bridge", "extension.json"),
				JSON.stringify({
					id: "bridge",
					name: "bridge",
					description: "测试用",
					version: "1.0.0",
					apiVersion: 3,
					contributes: { push: { label: "测试", shortLabel: "测", color: "#000000" } },
				}),
			);
			halfWritten();
			await gate;
			await writeFile(join(root, "bridge", "index.mjs"), HEALTHY);
		});
		await half;
		const seen = loaded.rescan().then(() => loaded.list().map((e) => e.state));
		// 给没排队的那种写法一个机会先跑完 —— 排了队的话它还在等。
		await new Promise((resolve) => setTimeout(resolve, 30));
		release();

		expect(await seen).toEqual(["running"]);
		await writing;
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([["bridge", "running"]]);
	});

	/** 写完不必自己再叫重扫:装进来的当场跑起来。写那一步抛了,原话交回调用方。 */
	it("改完盘紧跟着重扫;写那一步抛了,原话交回去", async () => {
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});

		await loaded.changeDisk(() => plant("bridge", HEALTHY));
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([["bridge", "running"]]);

		await expect(
			loaded.changeDisk(async () => {
				throw new Error("软链,不写");
			}),
		).rejects.toThrow("软链,不写");
		// 抛过之后队没被毒死。
		await loaded.changeDisk(() => rm(join(root, "bridge"), { recursive: true, force: true }));
		expect(loaded.list()).toEqual([]);
	});

	/**
	 * 🔴 **收摊先等在途的装卸落定**(切片 ③)。在途的那一项可能正起一个拓展:不等的话收摊时它还没登记进
	 * 格子,收不到它;它随后才起完,成了没人收的运行体(定时器、端点都还在),而关停已经往下走、
	 * 各写道也要关门了。
	 */
	it("收摊先等在途的装卸:刚起来的拓展一并收掉,不留下没人收的运行体", async () => {
		await plant("bridge", HEALTHY);
		let enabled = false;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let importing!: () => void;
		const reached = new Promise<void>((resolve) => {
			importing = resolve;
		});
		const host = fakeHost();
		const mounts = createExtensionMounts({ logger: silentLogger });
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);
		const loaded = await run({
			host,
			mounts,
			enabled: () => enabled,
			importModule: async (specifier) => {
				importing();
				await gate; // 装载队里在途的这一项停在 import 上
				return import(/* @vite-ignore */ specifier);
			},
		});
		expect(loaded.list().map((e) => e.state)).toEqual(["disabled"]);

		enabled = true;
		const syncing = loaded.sync();
		await reached;
		let disposed = false;
		const disposing = loaded.dispose().then(() => {
			disposed = true;
		});
		// 给不等在途那一项的写法一个机会先跑完 —— 等了的话它还在等。
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(disposed).toBe(false);

		release();
		await syncing;
		await disposing;

		expect(host.pending()).toBe(0); // 刚起来的那个也收了,它的定时器没留下
		expect((await app.request("/ext/bridge/x")).status).toBe(404);
	});

	it("新装的按 id 归位 —— 现在这个次序就是重启之后的次序", async () => {
		await plant("zeta", HEALTHY);
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});

		await plant("alpha", HEALTHY);
		await loaded.rescan();

		expect(loaded.list().map((e) => e.id)).toEqual(["alpha", "zeta"]);
	});

	it("新装进来的清单坏了 → 照样列出来说清楚,不是一声不响地没有", async () => {
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});

		await mkdir(join(root, "junk"), { recursive: true });
		await writeFile(join(root, "junk", "extension.json"), "{ 不是 JSON");
		await loaded.rescan();

		const entry = loaded.list()[0];
		expect(entry?.state).toBe("unreadable");
		expect(entry?.detail).toContain("JSON");
	});
});

/**
 * 同一个路径换了代码(ADR-0012 决策 47)。ESM 的模块缓存按 URL 认,同一个 URL 永远交回第一次
 * 那份 —— 所以删了再装、覆盖安装,`import()` 拿到的都可能是旧代码,而清单是现读的新的。
 * 装载器按**入口文件的指纹**认代码:这个进程里干净换不上的,不跑,等主人选重启或只重载。
 *
 * 这几条用**真的** `import()`:要钉的正是真模块缓存的行为,注入一个假的就把它抹平了。
 */
describe("换了代码(等着换上)", () => {
	/** 挂一条路由,回一句话 —— 哪一份代码在跑,请求一下就知道。 */
	const says = (word: string) =>
		`export function activate(ctx) { ctx.mount(async () => new Response(${JSON.stringify(word)})); }`;

	function serve(mounts: ReturnType<typeof createExtensionMounts>) {
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);
		return async () => {
			const res = await app.request("/ext/bridge/x");
			return res.status === 200 ? res.text() : res.status;
		};
	}

	it("删了再装、代码变了 → 不拿缓存里的旧代码跑,等着换上;只重载之后跑的是新的", async () => {
		await plant("bridge", says("旧的"));
		const mounts = createExtensionMounts({ logger: silentLogger });
		const body = serve(mounts);
		const loaded = await run({ host: fakeHost(), mounts });
		expect(await body()).toBe("旧的");

		await rm(join(root, "bridge"), { recursive: true, force: true });
		await loaded.rescan();
		await plant("bridge", says("新的"), { version: "2.0.0" });
		await loaded.rescan();

		// 旧代码配新清单,正是 devtools 装桥时炸的那一下。
		expect(await body()).not.toBe("旧的");
		const staged = loaded.list()[0];
		expect(staged?.state).toBe("staged");
		expect(staged?.staged).toEqual({ version: "2.0.0" });

		await loaded.swap("bridge");
		expect(await body()).toBe("新的");
		const swapped = loaded.list()[0];
		expect(swapped?.state).toBe("running");
		expect(swapped?.manifest?.version).toBe("2.0.0");
		expect(swapped?.staged).toBeUndefined();
	});

	it("删了再装、代码没变 → 直接跑起来,不问(模块缓存里那份就是它)", async () => {
		await plant("bridge", says("同一份"));
		const mounts = createExtensionMounts({ logger: silentLogger });
		const body = serve(mounts);
		const loaded = await run({ host: fakeHost(), mounts });

		await rm(join(root, "bridge"), { recursive: true, force: true });
		await loaded.rescan();
		await plant("bridge", says("同一份"));
		await loaded.rescan();

		expect(loaded.list().map((e) => [e.state, e.staged])).toEqual([["running", undefined]]);
		expect(await body()).toBe("同一份");
	});

	it("跑着的时候被覆盖 → 旧的照跑、标上新版本号;只重载之后换成新的", async () => {
		await plant("bridge", says("旧的"));
		const mounts = createExtensionMounts({ logger: silentLogger });
		const body = serve(mounts);
		const loaded = await run({ host: fakeHost(), mounts });

		await plant("bridge", says("新的"), { version: "2.0.0" });
		await loaded.rescan();

		const entry = loaded.list()[0];
		expect(entry?.state).toBe("running");
		expect(entry?.manifest?.version).toBe("1.0.0");
		expect(entry?.staged).toEqual({ version: "2.0.0" });
		expect(await body()).toBe("旧的");

		await loaded.swap("bridge");
		expect(await body()).toBe("新的");
		expect(loaded.list()[0]?.manifest?.version).toBe("2.0.0");
	});

	/**
	 * 跑着的那一份是「代码 + 清单」一起认的:只换了清单,跑着的照样配着旧清单,也得等着换上。
	 * 只重载时代码没变,URL 也不换 —— 模块缓存里那份就是它,不白漏。
	 */
	it("跑着时只换了清单、代码没变 → 也等着换上;只重载不换 URL", async () => {
		await plant("bridge", says("同一份"));
		const seen: string[] = [];
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			importModule: (specifier) => {
				seen.push(specifier);
				return import(specifier);
			},
		});

		await plant("bridge", says("同一份"), { version: "1.0.1" });
		await loaded.rescan();
		expect(loaded.list()[0]).toMatchObject({ state: "running", staged: { version: "1.0.1" } });

		await loaded.swap("bridge");
		expect(loaded.list()[0]).toMatchObject({ state: "running", manifest: { version: "1.0.1" } });
		expect(loaded.list()[0]?.staged).toBeUndefined();
		expect(seen).toHaveLength(2);
		expect(seen[1]).toBe(seen[0]);
	});

	it("盘上又换回跑着的那一份 → 「等着换上」撤掉", async () => {
		await plant("bridge", says("旧的"));
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});

		await plant("bridge", says("新的"), { version: "2.0.0" });
		await loaded.rescan();
		await plant("bridge", says("旧的"));
		await loaded.rescan();

		expect(loaded.list().map((e) => [e.state, e.staged])).toEqual([["running", undefined]]);
	});

	/** 名单里那条记录是关着时读的;不重读的话,打开时是新代码配旧清单 —— 这次的 bug 反过来。 */
	it("关着时被覆盖、从没跑过 → 打开时跑的是新代码、配新清单", async () => {
		await plant("bridge", says("旧的"));
		let on = false;
		const mounts = createExtensionMounts({ logger: silentLogger });
		const body = serve(mounts);
		const loaded = await run({ host: fakeHost(), mounts, enabled: () => on });

		await plant("bridge", says("新的"), { version: "2.0.0" });
		await loaded.rescan();
		on = true;
		await loaded.sync();

		expect(await body()).toBe("新的");
		expect(loaded.list()[0]?.manifest?.version).toBe("2.0.0");
	});

	/** 原路径的模块缓存里是**第一次**那份;按路径取的话,热换上去的那份一拨开关就丢了。 */
	it("只重载之后再拨一次开关 → 跑的还是换上去的那份", async () => {
		await plant("bridge", says("旧的"));
		let on = true;
		const mounts = createExtensionMounts({ logger: silentLogger });
		const body = serve(mounts);
		const loaded = await run({ host: fakeHost(), mounts, enabled: () => on });

		await plant("bridge", says("新的"), { version: "2.0.0" });
		await loaded.rescan();
		await loaded.swap("bridge");
		on = false;
		await loaded.sync();
		on = true;
		await loaded.sync();

		expect(await body()).toBe("新的");
	});

	/**
	 * 🔴 「新版等着换上」只有一种写法:凡是盘上那份这个进程干净地换不上的行都带 `staged`,**关着的
	 * 也带** —— 不然装完那一刻、详情页、市场三处得各自现判一遍「它关着但换不上」。状态照旧是
	 * 「已停用」:它确实关着。
	 */
	it("关着、这个进程跑过它别的代码、盘上换了 → 那一行也带着等着换上,状态仍是已停用", async () => {
		await plant("bridge", says("旧的"));
		let on = true;
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			enabled: () => on,
		});
		on = false;
		await loaded.sync();

		await plant("bridge", says("新的"), { version: "2.0.0" });
		await loaded.rescan();

		expect(loaded.list()[0]).toMatchObject({
			state: "disabled",
			manifest: { version: "2.0.0" },
			staged: { version: "2.0.0" },
		});
	});

	/** 只重载 = 「开着 && 带 staged」:关着的按下去会把它跑起来,那是开关的活。 */
	it("关着的带着等着换上也不给只重载 —— 按下去等于替主人把它跑起来", async () => {
		await plant("bridge", says("旧的"));
		let on = true;
		const mounts = createExtensionMounts({ logger: silentLogger });
		const body = serve(mounts);
		const loaded = await run({ host: fakeHost(), mounts, enabled: () => on });
		on = false;
		await loaded.sync();
		await plant("bridge", says("新的"), { version: "2.0.0" });
		await loaded.rescan();

		// 可预期的拒绝,自带 conflict 码 —— 路由只接这一种,换代码时的 bug 不会被当成 409。
		const refused = await loaded.swap("bridge").catch((err: unknown) => err);
		expect(refused).toBeInstanceOf(ExtensionConflictError);
		expect((refused as ExtensionConflictError).message).toMatch(/关着/);
		expect(loaded.list()[0]?.state).toBe("disabled");
		expect(await body()).toBe(404);
	});

	it("没有等着换上的新代码 → 不给只重载(每换一次漏一份旧模块,不白漏)", async () => {
		await plant("bridge", says("旧的"));
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
		});

		const refused = await loaded.swap("bridge").catch((err: unknown) => err);
		expect(refused).toBeInstanceOf(ExtensionConflictError);
		expect((refused as ExtensionConflictError).message).toMatch(/没有等着换上/);
		await expect(loaded.swap("nobody")).rejects.toBeInstanceOf(ExtensionConflictError);
		expect(loaded.list().map((e) => e.state)).toEqual(["running"]);
	});

	/**
	 * 🔴 **跑着的那一行标上「等着换上」之后,下一次起它用的是盘上那份清单。** 名单里留着旧记录的
	 * 话,拨一下开关就是「盘上的代码配旧清单」—— 正是决策 47 要防的那一下,只是换了个方向。
	 */
	it("跑着时盘上换了、再拨关拨开 → 那一行说的是盘上那一版", async () => {
		await plant("bridge", says("旧的"));
		let on = true;
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			enabled: () => on,
		});
		await plant("bridge", says("新的"), { version: "1.1.0" });
		await loaded.rescan();

		on = false;
		await loaded.sync();
		expect(loaded.list()[0]?.manifest?.version).toBe("1.1.0");

		on = true;
		await loaded.sync();
		expect(loaded.list()[0]).toMatchObject({ state: "staged", staged: { version: "1.1.0" } });
	});

	it("换上新的之后又装回旧的、再拨关拨开 → 旧代码配旧清单,不配刚才那份新清单", async () => {
		await plant("bridge", says("旧的"));
		const mounts = createExtensionMounts({ logger: silentLogger });
		const body = serve(mounts);
		let on = true;
		const loaded = await run({ host: fakeHost(), mounts, enabled: () => on });
		await plant("bridge", says("新的"), { version: "2.0.0" });
		await loaded.rescan();
		await loaded.swap("bridge");
		await plant("bridge", says("旧的"));
		await loaded.rescan();

		on = false;
		await loaded.sync();
		on = true;
		await loaded.sync();

		expect(await body()).toBe("旧的");
		expect(loaded.list()[0]).toMatchObject({ state: "running", manifest: { version: "1.0.0" } });
		expect(loaded.list()[0]?.staged).toBeUndefined();
	});
});

/**
 * 🔴 **挂住的拓展不许卡死整条队**(ADR-0019 决策 45):开机时 `activate` 不回,HTTP 都起不来;
 * 热装卸时它不回,之后的开关、装包、只重载全排在它后面。`activate` 与收摊钩子各有一个时限,
 * 过了就按失败 / 按已收摊处理,队接着走。
 */
describe("挂住了的拓展", () => {
	/** 一个按 id 分派的假 import:`hang` 的 activate 按给的写法挂住,别的正常起来。 */
	function modules(hang: (ctx: ExtensionContext) => Promise<void>) {
		return async (specifier: string) => ({
			activate: specifier.includes("/hang/") ? hang : () => {},
		});
	}

	it("activate 迟迟不回 → 按这一次加载失败记账、说清是超时;别的照样起来", async () => {
		await plant("hang", "export function activate() {}");
		await plant("good", "export function activate() {}");
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			// 上限 1:记了一笔、没销账 = 当场在停用名单里。
			maxFailures: 1,
			activateTimeoutMs: 20,
			importModule: modules(() => new Promise(() => {})),
		});

		const [good, hang] = loaded.list();
		expect(good?.state).toBe("running");
		expect(hang?.state).toBe("failed");
		expect(hang?.detail).toMatch(/activate/);
		expect(hang?.detail).toMatch(/超过/);
		expect(readLoadLedger(root).blocked).toEqual(["hang@1.0.0"]);
	});

	/**
	 * 超时之后它又回来了:那时已经按失败收过摊,不许把它登记成在跑 —— 它在超时之后才注册的东西
	 * 一样不收(ctx 已经收摊,来了就拒),先前注册的收摊钩子当场跑过。
	 */
	it("超时之后 activate 才回来 → 不登记成在跑;它的收摊已经跑过,后注册的一律不收", async () => {
		await plant("hang", "export function activate() {}");
		const host = fakeHost();
		const mounts = createExtensionMounts({ logger: silentLogger });
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let hooks = 0;
		let returned!: () => void;
		const back = new Promise<void>((resolve) => {
			returned = resolve;
		});

		const loaded = await run({
			host,
			mounts,
			activateTimeoutMs: 20,
			importModule: modules(async (ctx) => {
				ctx.mount(async () => new Response("半个"));
				ctx.onDispose(() => {
					hooks += 1;
				});
				await gate;
				ctx.setInterval(() => {}, 1000);
				returned();
			}),
		});
		expect(loaded.list()[0]?.state).toBe("failed");
		expect(hooks).toBe(1);
		expect((await app.request("/ext/hang/x")).status).toBe(404);

		release();
		await back;
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(loaded.list()[0]?.state).toBe("failed");
		expect(host.pending()).toBe(0);
		expect(loaded.status("hang")).toBeUndefined();
		expect((await app.request("/ext/hang/x")).status).toBe(404);
		expect(host.lines.some((line) => /^warn .*hang.*超时之后/.test(line))).toBe(true);
	});

	it("收摊钩子迟迟不回 → 记一行,按已收摊处理;机件照样拆掉,队接着走", async () => {
		await plant("bridge", "export function activate() {}");
		const host = fakeHost();
		const mounts = createExtensionMounts({ logger: silentLogger });
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);
		let on = true;
		const loaded = await run({
			host,
			mounts,
			enabled: () => on,
			disposeTimeoutMs: 20,
			importModule: async () => ({
				activate(ctx: ExtensionContext) {
					ctx.setInterval(() => {}, 1000);
					ctx.mount(async () => new Response("hi"));
					ctx.onDispose(() => new Promise(() => {}));
				},
			}),
		});
		expect(host.pending()).toBe(1);

		on = false;
		await loaded.sync();
		expect(loaded.list()[0]?.state).toBe("disabled");
		expect(host.pending()).toBe(0);
		expect((await app.request("/ext/bridge/x")).status).toBe(404);
		expect(host.lines.some((line) => /^warn .*bridge.*收摊钩子.*没跑完/.test(line))).toBe(true);

		on = true;
		await loaded.sync();
		expect(loaded.list()[0]?.state).toBe("running");
	});
});

/**
 * 宿主自己的日志。拓展起来、停下、换代码,此前只有开机那一趟记一行「已加载」—— 热装、拨开关、
 * 只重载一声不吭,「现在跑的是哪一份代码」只能去翻拓展自己的日志,而拓展未必打。
 */
describe("宿主日志:跑的是哪一份代码看得见", () => {
	const says = (word: string) => `export function activate() { return ${JSON.stringify(word)}; }`;
	/** 盘上那份入口的指纹前 8 位 —— 日志里认代码就认它。 */
	const printOnDisk = async () =>
		createHash("sha256")
			.update(await readFile(join(root, "bridge", "index.mjs")))
			.digest("hex")
			.slice(0, 8);

	it("起来、停下、盘上换了、只重载 —— 每一步各记一行,带着版本与代码指纹", async () => {
		await plant("bridge", says("旧的"));
		const host = fakeHost();
		const said = (re: RegExp) => host.lines.some((line) => re.test(line));
		let on = true;
		const loaded = await run({
			host,
			mounts: createExtensionMounts({ logger: silentLogger }),
			enabled: () => on,
		});
		const oldPrint = await printOnDisk();
		expect(said(new RegExp(`^info .*bridge v1\\.0\\.0 已加载.*${oldPrint}`))).toBe(true);

		on = false;
		await loaded.sync();
		expect(said(/^info .*bridge 已停下/)).toBe(true);

		host.lines.length = 0;
		on = true;
		await loaded.sync();
		expect(said(new RegExp(`^info .*bridge v1\\.0\\.0 已加载.*${oldPrint}`))).toBe(true);

		await plant("bridge", says("新的"), { version: "2.0.0" });
		await loaded.rescan();
		expect(said(/^info .*bridge 盘上换成了 v2\.0\.0,跑的还是 v1\.0\.0/)).toBe(true);

		const newPrint = await printOnDisk();
		await loaded.swap("bridge");
		expect(said(new RegExp(`^info .*bridge v2\\.0\\.0 已重载.*${newPrint}`))).toBe(true);
	});

	it("关着装进去、拨开也换不上 → 记一句警告,说清为什么、怎么办", async () => {
		await plant("bridge", says("旧的"));
		const host = fakeHost();
		let on = true;
		const loaded = await run({
			host,
			mounts: createExtensionMounts({ logger: silentLogger }),
			enabled: () => on,
		});
		on = false;
		await loaded.sync();
		await plant("bridge", says("新的"), { version: "2.0.0" });
		await loaded.rescan();

		on = true;
		await loaded.sync();

		expect(loaded.list()[0]?.state).toBe("staged");
		expect(host.lines.some((line) => /^warn .*bridge v2\.0\.0 换不上.*重启 BN/.test(line))).toBe(
			true,
		);
	});
});

/** 往 `<root>/<id>/locales/` 里写一份译文。 */
async function plantLocale(id: string, locale: string, content: unknown): Promise<void> {
	await mkdir(join(root, id, "locales"), { recursive: true });
	await writeFile(
		join(root, id, "locales", `${locale}.json`),
		typeof content === "string" ? content : JSON.stringify(content),
	);
}

describe("拓展的译文(ADR-0037 决策 14)", () => {
	it("列表按当前语言出名字与说明;切语言后跟着换,读口不变时两次一样", async () => {
		await plant("bridge", HEALTHY, { name: "原名", description: "原说明" });
		await plantLocale("bridge", "en", {
			$manifest: { name: "Bridge", description: "Lends bots." },
		});
		await plantLocale("bridge", "zh-CN", { $manifest: { name: "桥" } });
		const reader = switchableLocale("zh-CN");
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			locale: reader,
		});

		// 简中只译了名字:说明缺 → 落英文(回落链:本语言 → 简中 → 英文 → 原字)
		expect(loaded.list()[0]?.manifest).toMatchObject({ name: "桥", description: "Lends bots." });
		// 读口不变时两次一样
		expect(loaded.list()).toEqual(loaded.list());

		reader.set("en");
		expect(loaded.list()[0]?.manifest).toMatchObject({ name: "Bridge" });
		reader.set("ja");
		// 日文没有、简中有 → 简中
		expect(loaded.list()[0]?.manifest?.name).toBe("桥");
	});

	it("替拓展报的「设置读不懂」:表里那条的名字是此刻语言下的名字,切语言后跟着换", async () => {
		await plant("bridge", HEALTHY, { name: "原名" });
		await plantLocale("bridge", "en", { $manifest: { name: "Bridge" } });
		await plantLocale("bridge", "zh-CN", { $manifest: { name: "桥" } });
		const reader = switchableLocale("zh-CN");
		const problems = createProblemTable({
			logger: silentLogger,
			texts: { locale: () => reader.current(), onChange: (fn) => reader.onChange(fn) },
		});
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			locale: reader,
			problems,
			settingsIssue: (id) => (id === "bridge" ? { message: "坏了" } : undefined),
		});

		expect(problems.list().map((p) => p.message)).toEqual([
			"拓展「桥」没起来：它的设置文件不是合法的 JSON：坏了",
		]);

		reader.set("en");

		expect(problems.list().map((p) => p.message)).toEqual([
			"拓展「Bridge」没起来：它的设置文件不是合法的 JSON：坏了",
		]);
		await loaded.dispose();
		problems.dispose();
	});

	it("没带译文的拓展:清单原字,不受语言影响", async () => {
		await plant("bridge", HEALTHY, { name: "原名" });
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			locale: switchableLocale("en"),
		});
		expect(loaded.list()[0]?.manifest?.name).toBe("原名");
		expect(loaded.list()[0]?.localeIssues).toBeUndefined();
	});

	it("版本不合的那一行:身份照清单原字,不读译文", async () => {
		await plant("old", HEALTHY, { apiVersion: 1, provides: ["push"], contributes: undefined });
		await plantLocale("old", "en", { $manifest: { name: "Should not show" } });
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			locale: fixedLocale("en"),
		});
		const entry = loaded.list()[0];
		expect(entry?.state).toBe("incompatible");
		expect(entry?.identity?.name).toBe("old");
	});

	it("译文有问题:那一行带问题,warn 只在读目录时记一次(不是每次 list)", async () => {
		await plant("bridge", HEALTHY);
		await plantLocale("bridge", "en", { "bad key": "x", $manifest: { name: "Bridge" } });
		await plantLocale("bridge", "zh-TW", "{ 坏的");
		const host = fakeHost();
		const loaded = await run({
			host,
			mounts: createExtensionMounts({ logger: silentLogger }),
			locale: fixedLocale("en"),
		});
		expect(loaded.list()[0]?.localeIssues).toEqual([
			{ locale: "zh-TW", code: "invalid-json", path: [] },
			{ locale: "en", code: "invalid-key", path: ["bad key"] },
		]);
		loaded.list();
		loaded.list();
		const warns = () => host.lines.filter((line) => /^warn \[ext\] bridge.*译文/.test(line));
		expect(warns()).toHaveLength(1);
		// 重扫一遍、盘上没变:不再记
		await loaded.rescan();
		expect(warns()).toHaveLength(1);
	});

	it("盘上只换了译文、跑着的那份 → 标 staged(译文算进「这是哪一份」)", async () => {
		await plant("bridge", HEALTHY);
		await plantLocale("bridge", "en", { $manifest: { name: "Bridge" } });
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			locale: fixedLocale("en"),
		});
		expect(loaded.list()[0]?.staged).toBeUndefined();

		await plantLocale("bridge", "en", { $manifest: { name: "Bridge 2" } });
		await loaded.rescan();
		const entry = loaded.list()[0];
		expect(entry?.state).toBe("running");
		expect(entry?.staged).toEqual({ version: "1.0.0" });
		// 跑着的照旧是旧的那份
		expect(entry?.manifest?.name).toBe("Bridge");
	});

	it("语言变了:每个在跑的拓展各收到一次 onStatusChanged;停着的、起不来的不收", async () => {
		await plant("alpha", HEALTHY);
		await plant("beta", HEALTHY);
		await plant("off", HEALTHY);
		await plant("broken", `throw new Error("起不来");`);
		const reader = switchableLocale("zh-CN");
		const heard: string[] = [];
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			enabled: (id) => id !== "off",
			locale: reader,
			onStatusChanged: (id) => heard.push(id),
		});

		reader.set("en");

		expect([...heard].sort()).toEqual(["alpha", "beta"]);
		await loaded.dispose();
	});

	it("读口没变不叫;装载器收摊之后换语言也不叫", async () => {
		await plant("alpha", HEALTHY);
		const reader = switchableLocale("zh-CN");
		const heard: string[] = [];
		const loaded = await run({
			host: fakeHost(),
			mounts: createExtensionMounts({ logger: silentLogger }),
			locale: reader,
			onStatusChanged: (id) => heard.push(id),
		});

		reader.set("zh-CN");
		expect(heard).toEqual([]);

		await loaded.dispose();
		reader.set("en");
		expect(heard).toEqual([]);
	});

	it("拓展拿到的 ctx.i18n 用的是包里的译文与装载器的读口", async () => {
		await plant(
			"bridge",
			`export function activate(ctx) {
				ctx.mount(async () => new Response(ctx.i18n.locale() + ":" + ctx.i18n.t("hi")));
			}`,
		);
		await plantLocale("bridge", "en", { hi: "Hello" });
		await plantLocale("bridge", "zh-CN", { hi: "你好" });
		const mounts = createExtensionMounts({ logger: silentLogger });
		const app = new Hono();
		app.route(EXTENSION_MOUNT_PREFIX, mounts.route);
		const reader = switchableLocale("zh-CN");
		await run({ host: fakeHost(), mounts, locale: reader });

		expect(await (await app.request("/ext/bridge/x")).text()).toBe("zh-CN:你好");
		reader.set("en");
		expect(await (await app.request("/ext/bridge/x")).text()).toBe("en:Hello");
	});
});
