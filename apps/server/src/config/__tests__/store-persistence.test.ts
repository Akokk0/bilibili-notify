/**
 * ConfigStore 落盘方式:config/*.json(含 config/settings/core.json)怎么写、写坏了怎么退。
 *
 * 这些钉的是**写盘那一步**(内容对不对由 `__tests__/config-store.test.ts` 管):
 *   - config 文件是 2 空格缩进 + 末尾换行的 JSON
 *   - `replaceSections` 写到一半失败:已写好的分区**逐字节**退回原样,回滚副本不留
 *   - 写失败(目标被占成目录)不留临时文件
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { BusEvents, Disposable, MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../schema.js";
import { CONFIG_DIR, CORE_SETTINGS_FILE, type ConfigStore, createConfigStore } from "../store.js";

function makeBus(): MessageBus {
	const listeners = new Map<keyof BusEvents, Set<(...a: unknown[]) => void>>();
	return {
		emit(event, ...args) {
			for (const h of [...(listeners.get(event) ?? [])]) (h as (...a: unknown[]) => void)(...args);
		},
		on(event, handler): Disposable {
			let s = listeners.get(event);
			if (!s) {
				s = new Set();
				listeners.set(event, s);
			}
			const w = (...a: unknown[]) => (handler as (...x: unknown[]) => void)(...a);
			s.add(w);
			return { dispose: () => listeners.get(event)?.delete(w) };
		},
	};
}

function makeCtx(): ServiceContext {
	return {
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: vi.fn(),
		signal: new AbortController().signal,
		track: vi.fn(),
	};
}

function bootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "info" };
}

function mkStore(dataDir: string): ConfigStore {
	return createConfigStore({
		bootstrap: bootstrap(dataDir),
		dataRoot: dataDir,
		bus: makeBus(),
		serviceCtx: makeCtx(),
	});
}

const ID_A = "11111111-1111-4111-8111-111111111111";

/** 新形状的 onebot 连接。 */
function onebotConnection(name = "NapCat") {
	return {
		id: ID_A,
		name,
		platform: "onebot" as const,
		enabled: true,
		kind: "direct" as const,
		connector: "http" as const,
		config: {
			transport: "http" as const,
			baseUrl: "http://127.0.0.1:3000",
			protocolVersion: "v11" as const,
			headers: {},
			timeoutMs: 15_000,
			imageMinTimeoutMs: 30_000,
			mergeForwardMinTimeoutMs: 60_000,
			retryTimes: 0,
			retryIntervalMs: 1_000,
		},
	};
}

let dataDir: string;
let stateDir: string;
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-store-persist-"));
	stateDir = join(dataDir, ...CONFIG_DIR);
	await mkdir(stateDir, { recursive: true });
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

/** 名字里带 tmp 的:新旧两种临时文件命名(`.tmp.` / `.bn-tmp.`)都算。 */
const tempLeftovers = async (dir: string) => (await readdir(dir)).filter((n) => n.includes("tmp"));

describe("ConfigStore 落盘:config 文件格式", () => {
	it("首次 load 播种与之后的写入都是 2 空格缩进 + 末尾换行", async () => {
		const store = mkStore(dataDir);
		await store.load();
		await store.upsertConnection(onebotConnection());

		const files = [
			join(dataDir, ...CORE_SETTINGS_FILE),
			join(stateDir, "connections.json"),
			join(stateDir, "targets.json"),
		];
		for (const file of files) {
			const name = relative(stateDir, file);
			const raw = await readFile(file, "utf8");
			expect(raw.endsWith("\n"), `${name} 末尾换行`).toBe(true);
			expect(raw, `${name} 缩进`).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
		}
		expect(await tempLeftovers(stateDir)).toEqual([]);
		expect(await tempLeftovers(dirname(join(dataDir, ...CORE_SETTINGS_FILE)))).toEqual([]);
	});
});

describe("ConfigStore 落盘:replaceSections 写到一半失败", () => {
	it("已写好的分区逐字节退回原样,回滚副本不留,内存不动", async () => {
		// 原件刻意写成紧凑一行:退回去的必须是拷回来的原字节,而不是读出来重新序列化的。
		const path = join(stateDir, "connections.json");
		const original = JSON.stringify([onebotConnection()]);
		await writeFile(path, original, "utf8");
		const store = mkStore(dataDir);
		await store.load();
		expect(await readFile(path, "utf8")).toBe(original); // 前提:load 没动它

		// 数组分区先写、globals 最后写:把 settings/core.json 占成目录,让最后一步失败。
		const globalsPath = join(dataDir, ...CORE_SETTINGS_FILE);
		await rm(globalsPath);
		await mkdir(globalsPath);
		const globals = store.getGlobals();

		await expect(
			store.replaceSections({
				connections: [onebotConnection("改了名")],
				globals: { ...globals, app: { ...globals.app, fansCron: "*/9 * * * *" } },
			}),
		).rejects.toThrow();

		expect(await readFile(path, "utf8")).toBe(original);
		expect((await readdir(stateDir)).filter((n) => n.endsWith(".restore.bak"))).toEqual([]);
		expect(store.getConnections()[0]?.name).toBe("NapCat");
	});
});

describe("ConfigStore 落盘:写失败不留临时文件", () => {
	it("目标被占成目录 → 写抛错,config 目录里没有遗留的临时文件", async () => {
		const store = mkStore(dataDir);
		await store.load();
		const globalsPath = join(dataDir, ...CORE_SETTINGS_FILE);
		await rm(globalsPath);
		await mkdir(globalsPath);

		await expect(store.patchGlobals({ app: { fansCron: "*/9 * * * *" } })).rejects.toThrow();

		// 临时文件落在目标旁边:设置文件在 config/settings/ 里,两个目录都得干净。
		expect(await tempLeftovers(stateDir)).toEqual([]);
		expect(await tempLeftovers(dirname(globalsPath))).toEqual([]);
	});
});
