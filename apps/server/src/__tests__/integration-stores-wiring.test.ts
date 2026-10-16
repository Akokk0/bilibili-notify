/**
 * 「真能用,不是空壳」(ADR-0025 决策 9、10):内置适配器、拓展的适配器上下文、拓展的 `activate` 上下文,
 * 三处写进去的东西**盘上真有、重开读得到**,卸载拓展之后两个目录都没了。
 *
 * 🔴 全程看**盘上的文件**,不看 `set` 的返回值:装配处要是漏接、落回某个什么都回成功的默认桩,`set` 照样回
 * `{ ok: true }`,只有盘上空空如也。用的是真的存储宿主、真的 `registerBuiltinAdapters`、真的装载器与卸载路由。
 */

import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bilibili-notify/extension";
import {
	type Connection,
	type Disposable,
	type Logger,
	ok,
	type PlatformAdapter,
	type PlatformAdapterContext,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { createKeyProvider, gcmDecrypt } from "@bilibili-notify/storage";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { settingsSegment } from "../bilibili/settings.js";
import type { ConfigStore } from "../config/store.js";
import { loadExtensions } from "../extensions/loader.js";
import { createExtensionMounts } from "../extensions/mount.js";
import { createExtensionUpgrades } from "../extensions/upgrade.js";
import { createIntegrationStore, type IntegrationStore } from "../integration-store/store.js";
import { createValueRedactor } from "../logs/value-redactor.js";
import { registerBuiltinAdapters } from "../push/builtin-adapters.js";
import { createPlatformAdapterRegistry } from "../push/registry.js";
import { createExtensionsRoute } from "../routes/extensions.js";
import { createAppRuntime } from "../runtime/bootstrap.js";
import { dataPath } from "../runtime/roots.js";
import { ignoredProblems } from "./support/ignored-problems.js";
import { silentLogger } from "./support/silent-logger.js";

const EXT_ID = "wiring-ext";

let dataRoot: string;
let store: IntegrationStore;
let keyProvider: ReturnType<typeof createKeyProvider>;

function logger(): Logger {
	return { info() {}, warn() {}, error() {}, debug() {} };
}

function quietHost(): ServiceContext {
	return {
		logger: logger(),
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose() {},
		signal: new AbortController().signal,
		track: () => {},
	};
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

async function stateOnDisk(...segments: string[]): Promise<Record<string, unknown>> {
	const raw = await readFile(join(dataRoot, "runtime", ...segments, "state.json"), "utf8");
	return JSON.parse(raw).entries;
}

async function secretsOnDisk(...segments: string[]): Promise<Record<string, unknown>> {
	const raw = await readFile(join(dataRoot, "secrets", ...segments, "secrets.enc"), "utf8");
	return JSON.parse(gcmDecrypt(await keyProvider.getKey(), JSON.parse(raw))).entries;
}

beforeEach(async () => {
	dataRoot = await mkdtemp(join(tmpdir(), "bn-integration-wiring-"));
	keyProvider = createKeyProvider({
		keyPath: dataPath(dataRoot, "secrets", "master.key"),
		saltPath: dataPath(dataRoot, "secrets", "kdf.salt"),
		logger: logger(),
	});
	store = createIntegrationStore({
		dataRoot,
		keyProvider,
		logger: logger(),
		redactor: createValueRedactor(),
	});
});

afterEach(async () => {
	await store.close();
	await rm(dataRoot, { recursive: true, force: true });
});

describe("内置适配器", () => {
	interface Probe extends PlatformAdapter {
		ctx?: PlatformAdapterContext;
	}
	function probeAdapter(adapterKey: string): Probe {
		const probe = {
			adapterKey,
			settingsSchema: z.unknown(),
			isAvailable: () => true,
			send: async () => ({ ok: true, latencyMs: 1 }),
			start(ctx: PlatformAdapterContext) {
				probe.ctx = ctx;
			},
			stop() {},
		} as unknown as Probe;
		return probe;
	}
	async function register(adapters: Probe[]) {
		return registerBuiltinAdapters({
			registry: createPlatformAdapterRegistry(),
			adapters,
			loggerOf: () => logger(),
			stores: store,
			problems: ignoredProblems,
			connections: (): readonly Connection[] => [],
			inbound: {},
			onConnectionsChanged: (): Disposable => ({ dispose() {} }),
		});
	}

	it("start(ctx) 里写的 state / secrets,盘上真有;重新登记一遍读得到", async () => {
		const onebot = probeAdapter("onebot");
		const first = await register([onebot]);
		expect(await onebot.ctx?.secrets.set("token", "s3cret")).toEqual({ ok: true });
		expect(await onebot.ctx?.state.set("cursor", { page: 2 })).toEqual({ ok: true });

		// 盘上:密钥加密在 secrets/onebot/secrets.enc,状态明文在 runtime/onebot/state.json。
		expect(await secretsOnDisk("onebot")).toEqual({ token: "s3cret" });
		expect(await stateOnDisk("onebot")).toEqual({ cursor: { page: 2 } });
		expect(
			await readFile(join(dataRoot, "secrets", "onebot", "secrets.enc"), "utf8"),
		).not.toContain("s3cret");

		await first.dispose();
		const again = probeAdapter("onebot");
		await register([again]);
		expect(again.ctx?.state.get("cursor")).toEqual({ page: 2 });
		expect(again.ctx?.secrets.get("token")).toBe("s3cret");
	});

	it("两个内置适配器写同名的键互不相干", async () => {
		const onebot = probeAdapter("onebot");
		const webhook = probeAdapter("webhook");
		await register([onebot, webhook]);
		await onebot.ctx?.state.set("k", "a");
		await webhook.ctx?.state.set("k", "b");
		expect(await stateOnDisk("onebot")).toEqual({ k: "a" });
		expect(await stateOnDisk("webhook")).toEqual({ k: "b" });
	});
});

describe("关停:flush 段关门之后数据目录不再变", () => {
	async function treeOf(dir: string, prefix = ""): Promise<Record<string, string>> {
		const out: Record<string, string> = {};
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const rel = `${prefix}${entry.name}`;
			if (entry.isDirectory()) Object.assign(out, await treeOf(join(dir, entry.name), `${rel}/`));
			else out[rel] = (await readFile(join(dir, entry.name))).toString("base64");
		}
		return out;
	}

	it("真运行时:关停前在路上的写落盘,关停返回之后的写被拒、runtime/ 与 secrets/ 不再变", async () => {
		const runtime = createAppRuntime(
			{ server: { host: "127.0.0.1", port: 8787 }, dataDir: dataRoot, logLevel: "silent" },
			{ dataRoot },
			{ integrationSettings: [settingsSegment] },
		);
		const handle = await runtime.integrationStore.open("onebot");
		await handle.state.set("seed", 0);
		const inFlight = handle.secrets.set("token", "in-flight");

		await runtime.dispose();

		expect(await inFlight).toEqual({ ok: true });
		expect(await secretsOnDisk("onebot")).toEqual({ token: "in-flight" });
		const settled = {
			runtime: await treeOf(join(dataRoot, "runtime")),
			secrets: await treeOf(join(dataRoot, "secrets")),
		};
		expect(await handle.state.set("late", 1)).toMatchObject({ ok: false, code: "unavailable" });
		expect(await handle.secrets.set("late", 1)).toMatchObject({ ok: false, code: "unavailable" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect({
			runtime: await treeOf(join(dataRoot, "runtime")),
			secrets: await treeOf(join(dataRoot, "secrets")),
		}).toEqual(settled);
	});
});

describe("拓展", () => {
	const extRoot = () => join(dataRoot, "extensions");

	async function plantExtension() {
		const dir = join(extRoot(), EXT_ID);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "extension.json"),
			JSON.stringify({
				id: EXT_ID,
				name: EXT_ID,
				description: "测试用",
				version: "1.0.0",
				apiVersion: 2,
				contributes: { push: { display: { label: "测试", shortLabel: "测", color: "#000000" } } },
			}),
		);
		await writeFile(join(dir, "index.mjs"), "export function activate() {}");
	}

	/** 每次 activate / start 记下:写的结果、读到的旧值、两处拿到的是不是同一对对象。 */
	interface Seen {
		activations: number;
		activateWrites: unknown[];
		startWrites: unknown[];
		readOnActivate: unknown[];
		sameObjects: boolean[];
	}

	async function boot(isEnabled: () => boolean) {
		await plantExtension();
		const seen: Seen = {
			activations: 0,
			activateWrites: [],
			startWrites: [],
			readOnActivate: [],
			sameObjects: [],
		};
		let activateCtx: ExtensionContext | undefined;
		const startWrites: Promise<unknown>[] = [];
		async function activate(ctx: ExtensionContext) {
			activateCtx = ctx;
			seen.activations += 1;
			seen.readOnActivate.push([ctx.state.get("fromActivate"), ctx.secrets.get("tokenA")]);
			seen.activateWrites.push(
				await ctx.state.set("fromActivate", seen.activations),
				await ctx.secrets.set("tokenA", `a${seen.activations}`),
			);
			ctx.registerPushSource({
				adapter: {
					adapterKey: "ignored",
					isAvailable: () => true,
					send: async () => ({ ok: true, latencyMs: 1 }),
					probe: async () => ({ ok: true, latencyMs: 1 }),
					listConnectionCandidates: async () => [],
					start(adapterCtx) {
						seen.sameObjects.push(
							adapterCtx.state === activateCtx?.state &&
								adapterCtx.secrets === activateCtx?.secrets,
						);
						startWrites.push(
							adapterCtx.state.set("fromStart", true),
							adapterCtx.secrets.set("tokenB", "b"),
						);
					},
					stop() {},
				},
				configSchema: z.object({}),
			});
		}
		const loaded = await loadExtensions({
			root: extRoot(),
			host: quietHost(),
			loggerOf: () => logger(),
			integrationStore: store,
			problems: ignoredProblems,
			mounts: createExtensionMounts({ logger: silentLogger }),
			adapters: createPlatformAdapterRegistry(),
			connections: () => [],
			onConnectionsChanged: () => ({ dispose() {} }),
			subscriptions: () => [],
			onSubscriptionsChanged: () => ({ dispose() {} }),
			settings: () => undefined,
			onSettingsChanged: () => ({ dispose() {} }),
			inbound: {},
			upgrades: createExtensionUpgrades(),
			isEnabled,
			maxFailures: 3,
			importModule: async () => ({ activate }),
		});
		return { loaded, seen, startWrites };
	}

	it("activate(ctx) 与适配器 start(ctx) 里写的,盘上真有,而且两处是同一对对象", async () => {
		const { loaded, seen, startWrites } = await boot(() => true);
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([[EXT_ID, "running"]]);
		await Promise.all(startWrites);
		expect(seen.activateWrites).toEqual([{ ok: true }, { ok: true }]);
		expect(seen.sameObjects).toEqual([true]);

		expect(await stateOnDisk("extensions", EXT_ID)).toEqual({ fromActivate: 1, fromStart: true });
		expect(await secretsOnDisk("extensions", EXT_ID)).toEqual({ tokenA: "a1", tokenB: "b" });
		await loaded.dispose();
	});

	it("停用再启用:把手关了又开成功(不是「已经开着」),读得到停用前写的", async () => {
		let on = true;
		const { loaded, seen } = await boot(() => on);
		expect(store.isOpen(EXT_ID)).toBe(true);

		on = false;
		await loaded.sync();
		expect(loaded.list().map((e) => e.state)).toEqual(["disabled"]);
		expect(store.isOpen(EXT_ID)).toBe(false);

		on = true;
		await loaded.sync();
		expect(loaded.list().map((e) => e.state)).toEqual(["running"]);
		expect(store.isOpen(EXT_ID)).toBe(true);
		expect(seen.activations).toBe(2);
		// 第二次 activate 一进门就读到了第一次写的。
		expect(seen.readOnActivate[1]).toEqual([1, "a1"]);
		await loaded.dispose();
		expect(store.isOpen(EXT_ID)).toBe(false);
	});

	it("卸载路由之后,两个目录都没了", async () => {
		const { loaded, startWrites } = await boot(() => true);
		await Promise.all(startWrites);
		const stateDir = join(dataRoot, "runtime", "extensions", EXT_ID);
		const secretsDir = join(dataRoot, "secrets", "extensions", EXT_ID);
		expect(await exists(stateDir)).toBe(true);
		expect(await exists(secretsDir)).toBe(true);

		const configStore = {
			getGlobals: () => ({ extensions: {} }),
			getConnections: () => [],
			removeExtension: async () => {},
		} as unknown as ConfigStore;
		const route = createExtensionsRoute({
			store: configStore,
			extensions: () => loaded.list(),
			status: () => undefined,
			install: {
				root: extRoot(),
				integrationStore: store,
				changeDisk: (write) => loaded.changeDisk(write),
				restartAbility: { can: true, how: "container" },
			},
		});
		const app = new Hono();
		app.route("/", route);
		const res = await app.request(`/${EXT_ID}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(ok());

		expect(await exists(stateDir)).toBe(false);
		expect(await exists(secretsDir)).toBe(false);
		await loaded.dispose();
	});

	it("拓展与内置适配器写同名的键互不相干", async () => {
		const { loaded, startWrites } = await boot(() => true);
		await Promise.all(startWrites);
		const onebot = (await store.open("onebot")).state;
		await onebot.set("fromActivate", "not-the-extensions");
		expect(await stateOnDisk("extensions", EXT_ID)).toMatchObject({ fromActivate: 1 });
		expect(await stateOnDisk("onebot")).toEqual({ fromActivate: "not-the-extensions" });
		await loaded.dispose();
	});
});
