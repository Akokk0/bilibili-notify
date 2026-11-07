/**
 * **`stats.enabled` 经配置仓读写、不走迁移**(ADR-0027 决策 9、16;㉙a)。
 *
 * 新键靠 schema 的默认值补:老设置文件(开机读)、老备份里的核心设置(恢复写)都没有 `stats` 这一节,
 * 读进来要照常、并补成开着。不抬迁移修订号、不抬备份版本。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { type Disposable, makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../config/schema.js";
import { CORE_SETTINGS_FILE, createConfigStore } from "../config/store.js";

function makeBus(): MessageBus & { emitted: Array<[string, unknown]> } {
	const emitted: Array<[string, unknown]> = [];
	return {
		emitted,
		emit(event: string, payload?: unknown) {
			emitted.push([event, payload]);
		},
		on(): Disposable {
			return { dispose() {} };
		},
	} as never;
}

const serviceCtx = {
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	setInterval: () => ({ dispose: vi.fn() }),
	setTimeout: () => ({ dispose: vi.fn() }),
	onDispose: vi.fn(),
	signal: new AbortController().signal,
	track: vi.fn(),
} as unknown as ServiceContext;

describe("stats.enabled × 配置仓", () => {
	let dataDir: string;
	let bus: ReturnType<typeof makeBus>;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-stats-switch-settings-"));
		bus = makeBus();
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	function open() {
		const bootstrap: BootstrapConfig = {
			server: { host: "127.0.0.1", port: 8787 },
			dataDir,
			logLevel: "info",
		};
		return createConfigStore({ bootstrap, dataRoot: dataDir, bus, serviceCtx });
	}

	it("老的设置文件(盘上没有 stats 这一节)开机读得进来,补成开着", async () => {
		const { stats: _dropped, ...old } = makeDefaultGlobalSettings();
		const file = join(dataDir, ...CORE_SETTINGS_FILE);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify(old));
		expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("stats");

		const store = open();
		await store.load();
		expect(store.getGlobals().stats).toEqual({ enabled: true });
	});

	it("老备份里的核心设置(没有 stats)恢复进来:读得进来,补成开着", async () => {
		const store = open();
		await store.load();
		await store.setGlobals({ ...store.getGlobals(), stats: { enabled: false } });
		const { stats: _dropped, ...fromOldBackup } = makeDefaultGlobalSettings();

		await store.replaceSections({ globals: fromOldBackup as never });

		expect(store.getGlobals().stats).toEqual({ enabled: true });
	});

	it("setGlobals 收到没有 stats 的整份设置也一样补成开着", async () => {
		const store = open();
		await store.load();
		const { stats: _dropped, ...old } = makeDefaultGlobalSettings();
		await store.setGlobals(old as never);
		expect(store.getGlobals().stats).toEqual({ enabled: true });
	});

	it("关掉:patchGlobals 落盘、重开读回仍是关着,并发一条 config-changed(globals)让缓存作废", async () => {
		const store = open();
		await store.load();
		await store.patchGlobals({ stats: { enabled: false } });
		expect(bus.emitted).toContainEqual(["config-changed", { scope: "globals" }]);

		const reopened = open();
		await reopened.load();
		expect(reopened.getGlobals().stats.enabled).toBe(false);
	});
});
