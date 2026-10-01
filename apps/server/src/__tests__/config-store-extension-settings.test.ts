/**
 * 配置仓里各拓展的设置:一个拓展一个文件 `config/settings/extensions/<拓展 id>.json`(ADR-0021 决策 42 下 10-01 的
 * 🔗)。拓展的开关 `enabled` 归宿主、留在核心那份(`config/settings/core.json` 的 `extensions.<id>`),拓展的
 * 文件只装它自己的设置 —— 开关放进拓展的文件,那个文件一坏,关掉它的开关也读不出来。
 *
 * 仓不认得拓展设置的形状(那归拓展自己那份 zod,在仓外核,见 `extensions/settings-io.ts`),只原样存取:
 *   - 读盘:目录里每个 `<id>.json` 读进来;没有这个目录就是一个都没存过;
 *   - `updateExtensionSettings`:在设置那条排队里「读当前 → 算新值 → 落盘」,只广播 `integration-settings`;
 *     `update` 抛了整次作废;拓展 id 不合 id 的形状整次拒收(拿它拼路径,`../` 一类不许进来);
 *   - `removeExtension`:开关那一格与设置文件一起删;
 *   - `replaceSections({ extensionSettings })`:带来的那几个拓展整份换,没带的不动。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigScope, MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../config/schema.js";
import {
	CORE_SETTINGS_FILE,
	type ConfigStore,
	createConfigStore,
	extensionSettingsFile,
} from "../config/store.js";
import { createNodeMessageBus } from "../runtime/message-bus.js";

function makeServiceCtx(): ServiceContext {
	return {
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: vi.fn(),
		signal: new AbortController().signal,
		track: vi.fn(),
	};
}

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "info" };
}

let dataDir: string;
let bus: MessageBus;
let scopes: ConfigScope[];

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-config-ext-settings-"));
	bus = createNodeMessageBus();
	scopes = [];
	bus.on("config-changed", ({ scope }) => scopes.push(scope));
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

async function open(): Promise<ConfigStore> {
	const store = createConfigStore({
		bootstrap: makeBootstrap(dataDir),
		dataRoot: dataDir,
		bus,
		serviceCtx: makeServiceCtx(),
	});
	await store.load();
	return store;
}

const fileOf = (id: string) => join(dataDir, ...extensionSettingsFile(id));

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

describe("拓展设置 — 读盘", () => {
	it("目录里每个 <id>.json 读进来,原样;没有目录 = 一个都没存过", async () => {
		const empty = await open();
		expect(empty.getAllExtensionSettings()).toEqual({});
		expect(empty.getExtensionSettings("douyin")).toBeUndefined();

		await mkdir(join(dataDir, "config", "settings", "extensions"), { recursive: true });
		await writeFile(fileOf("douyin"), JSON.stringify({ cookie: "c", list: [1, 2] }), "utf8");
		await writeFile(fileOf("acme.tiktok"), JSON.stringify({ token: "t" }), "utf8");
		const store = await open();
		expect(store.getExtensionSettings("douyin")).toEqual({ cookie: "c", list: [1, 2] });
		expect(store.getAllExtensionSettings()).toEqual({
			douyin: { cookie: "c", list: [1, 2] },
			"acme.tiktok": { token: "t" },
		});
	});

	it("读出来的是深拷贝:改返回值不影响仓里那份", async () => {
		const store = await open();
		await store.updateExtensionSettings("douyin", () => ({ list: [1] }));
		const got = store.getExtensionSettings("douyin") as { list: number[] };
		got.list.push(2);
		expect(store.getExtensionSettings("douyin")).toEqual({ list: [1] });
	});
});

describe("拓展设置 — updateExtensionSettings", () => {
	it("写进 config/settings/extensions/<id>.json;核心那份里没有设置;只广播 integration-settings", async () => {
		const store = await open();
		await store.patchGlobals({ extensions: { douyin: { enabled: true } } });
		scopes.length = 0;

		const saved = await store.updateExtensionSettings("douyin", (current) => {
			expect(current).toBeUndefined();
			return { cookie: "c" };
		});

		expect(saved).toEqual({ cookie: "c" });
		expect(await readJson(fileOf("douyin"))).toEqual({ cookie: "c" });
		const core = (await readJson(join(dataDir, ...CORE_SETTINGS_FILE))) as {
			extensions: Record<string, unknown>;
		};
		expect(core.extensions.douyin).toEqual({ enabled: true });
		expect(scopes).toEqual(["integration-settings"]);
	});

	it("update 拿到现在那份;它抛了整次作废,盘上内存都不动、不广播", async () => {
		const store = await open();
		await store.updateExtensionSettings("douyin", () => ({ n: 1 }));
		const bytes = await readFile(fileOf("douyin"), "utf8");
		scopes.length = 0;

		await expect(
			store.updateExtensionSettings("douyin", (current) => {
				expect(current).toEqual({ n: 1 });
				throw new Error("版本号对不上");
			}),
		).rejects.toThrow("版本号对不上");

		expect(await readFile(fileOf("douyin"), "utf8")).toBe(bytes);
		expect(store.getExtensionSettings("douyin")).toEqual({ n: 1 });
		expect(scopes).toEqual([]);
	});

	it.each(["../evil", "Douyin", "a/b", "constructor", ""])(
		"拓展 id 不合 id 的形状(%j)→ 整次拒收,一个文件都不写",
		async (id) => {
			const store = await open();
			await expect(store.updateExtensionSettings(id, () => ({ x: 1 }))).rejects.toThrow();
			expect(await exists(join(dataDir, "config", "settings", "extensions"))).toBe(false);
			expect(await exists(join(dataDir, "config", "evil.json"))).toBe(false);
		},
	);
});

describe("拓展设置 — removeExtension(卸载)", () => {
	it("开关那一格与设置文件一起删;别的拓展不动", async () => {
		const store = await open();
		await store.patchGlobals({
			extensions: { douyin: { enabled: true }, kuaishou: { enabled: true } },
		});
		await store.updateExtensionSettings("douyin", () => ({ cookie: "c" }));
		await store.updateExtensionSettings("kuaishou", () => ({ cookie: "k" }));

		await store.removeExtension("douyin");

		expect(store.getGlobals().extensions).toEqual({ kuaishou: { enabled: true } });
		expect(store.getExtensionSettings("douyin")).toBeUndefined();
		expect(await exists(fileOf("douyin"))).toBe(false);
		expect(await readJson(fileOf("kuaishou"))).toEqual({ cookie: "k" });
		// 重开一个仓读回来也是这样(盘上真删了)。
		const again = await open();
		expect(again.getAllExtensionSettings()).toEqual({ kuaishou: { cookie: "k" } });
		expect(again.getGlobals().extensions).toEqual({ kuaishou: { enabled: true } });
	});

	it("没存过设置的拓展也卸得掉(只删开关)", async () => {
		const store = await open();
		await store.patchGlobals({ extensions: { douyin: { enabled: false } } });
		await store.removeExtension("douyin");
		expect(store.getGlobals().extensions).toEqual({});
	});
});

describe("拓展设置 — replaceSections(恢复备份)", () => {
	it("带来的那几个拓展整份换(不是合并),没带的不动;广播 integration-settings", async () => {
		const store = await open();
		await store.updateExtensionSettings("douyin", () => ({ cookie: "old", extra: 1 }));
		await store.updateExtensionSettings("kuaishou", () => ({ cookie: "k" }));
		scopes.length = 0;

		await store.replaceSections({ extensionSettings: { douyin: { cookie: "new" } } });

		expect(store.getExtensionSettings("douyin")).toEqual({ cookie: "new" });
		expect(await readJson(fileOf("douyin"))).toEqual({ cookie: "new" });
		expect(store.getExtensionSettings("kuaishou")).toEqual({ cookie: "k" });
		expect(scopes).toContain("integration-settings");
	});

	it("备份里的拓展 id 不合 id 的形状 → 整份拒收,一个字都不写", async () => {
		const store = await open();
		await expect(
			store.replaceSections({ extensionSettings: { "../evil": { x: 1 } } }),
		).rejects.toThrow();
		expect(await readdir(join(dataDir, "config"))).not.toContain("evil.json");
		expect(store.getAllExtensionSettings()).toEqual({});
	});
});
