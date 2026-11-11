import {
	access,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import { ignoredProblems } from "../../__tests__/support/ignored-problems.js";
import { fixedTimezone, inertTransitImages } from "../../__tests__/support/integration-io.js";
import { memoryIntegrationStore } from "../../__tests__/support/memory-key-value-store.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { BUILTIN_INTEGRATION_KEYS } from "../../compose.js";
import { loadExtensions } from "../../extensions/loader.js";
import { createExtensionMounts } from "../../extensions/mount.js";
import { createExtensionUpgrades } from "../../extensions/upgrade.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import { createDevelopmentExtensions } from "../development-extensions.js";
import { extensionScenarios } from "../scenarios/extensions.js";

function hostStubs() {
	const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
	const host: ServiceContext = {
		logger,
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose() {},
		signal: new AbortController().signal,
		track: () => {},
	};
	return {
		host,
		loggerOf: () => logger,
		integrationStore: memoryIntegrationStore(),
		problems: ignoredProblems,
		mounts: createExtensionMounts({ logger: silentLogger }),
		adapters: createPlatformAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		settings: () => undefined,
		onSettingsChanged: () => ({ dispose() {} }),
		inbound: {},
		upgrades: createExtensionUpgrades(),
	};
}

describe("源码开发场景", () => {
	let root: string;
	let repoDir: string;
	let installRoot: string;
	let loaded: Awaited<ReturnType<typeof loadExtensions>> | undefined;
	let development: ReturnType<typeof createDevelopmentExtensions>;
	const code = (value: string) =>
		`export function activate(ctx: {publishView(fn: () => unknown): void}) { ctx.publishView(() => ({summary:{text:[${JSON.stringify(value)}]}})); }`;
	beforeEach(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), "bn-source-scenarios-")));
		repoDir = join(root, "repo");
		installRoot = join(root, "installed");
		await mkdir(repoDir);
		development = createDevelopmentExtensions({
			root: installRoot,
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
			extensions: () => loaded,
		});
		loaded = await loadExtensions({
			root: installRoot,
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
			timezoneReader: fixedTimezone("Asia/Shanghai"),
			transitImages: inertTransitImages,
			locale: fixedLocale(),
			...hostStubs(),
			developmentEntry: development.resolveEntry,
			isEnabled: () => true,
			maxFailures: 3,
		});
	});
	afterEach(async () => {
		await development?.dispose();
		await loaded?.dispose();
		loaded = undefined;
		await rm(root, { recursive: true, force: true });
	});
	async function plant(id = "bridge") {
		const dir = join(repoDir, id);
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(
			join(dir, "extension.json"),
			JSON.stringify({
				id,
				name: id,
				description: "fixture",
				version: "1.0.0",
				apiVersion: 1,
				contributes: { push: { label: "Test", shortLabel: "T", color: "#000000" } },
			}),
		);
		await writeFile(join(dir, "src/index.ts"), code("one"));
		return dir;
	}
	function defs() {
		return extensionScenarios({ repoDir, development });
	}
	function must(id: string, from = defs()) {
		const def = from.find((d) => d.id === id);
		if (!def) throw new Error(id);
		return def;
	}
	it("无拓展时不登记场景", () => {
		expect(defs()).toEqual([]);
	});
	it("没有dist也直接挂载并启用源码，不要求重启", async () => {
		const dir = await plant();
		const out = await must("ext.install").run({ ext: "bridge" });
		expect(out).toMatchObject({ ok: true });
		expect(loaded?.status("bridge")).toMatchObject({ summary: { text: ["one"] } });
		expect(await readlink(join(installRoot, "bridge"))).toBe(dir);
		await expect(access(join(dir, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("加载器未就绪时拒绝挂载，不先留下空壳链接", async () => {
		await plant();
		const saved = loaded;
		loaded = undefined;
		try {
			expect(await must("ext.install").run({ ext: "bridge" })).toMatchObject({
				ok: false,
				code: "unavailable",
			});
			await expect(lstat(join(installRoot, "bridge"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			loaded = saved;
		}
	});
	it("已挂载不重复激活，真实安装目录不会被覆盖或删除", async () => {
		await plant();
		const install = must("ext.install");
		expect(await install.run({ ext: "bridge" })).toMatchObject({ ok: true });
		expect(await install.run({ ext: "bridge" })).toMatchObject({ ok: true });
		expect(await must("ext.uninstall").run({ ext: "bridge" })).toMatchObject({ ok: true });
		await mkdir(join(installRoot, "bridge"));
		await writeFile(join(installRoot, "bridge/keep.txt"), "keep");
		expect(await install.run({ ext: "bridge" })).toMatchObject({ ok: false });
		expect(await must("ext.uninstall").run({ ext: "bridge" })).toMatchObject({ ok: false });
		expect(await readFile(join(installRoot, "bridge/keep.txt"), "utf8")).toBe("keep");
	});
	it("解除挂载当场停止，源码保留；未挂载ID拒绝", async () => {
		const dir = await plant();
		await must("ext.install").run({ ext: "bridge" });
		expect(await must("ext.uninstall").run({ ext: "bridge" })).toMatchObject({ ok: true });
		expect(loaded?.list()).toEqual([]);
		expect(await readFile(join(dir, "src/index.ts"), "utf8")).toBe(code("one"));
		expect(await must("ext.uninstall").run({ ext: "bridge" })).toMatchObject({
			ok: false,
			code: "not_found",
		});
	});
	it("手动重新加载由BN校验源码，失败不替换当前实例", async () => {
		const dir = await plant();
		await must("ext.install").run({ ext: "bridge" });
		development.setWatching("bridge", false);
		await writeFile(join(dir, "src/index.ts"), "export !!! invalid");
		expect(await must("ext.reload").run({ ext: "bridge" })).toMatchObject({ ok: false });
		expect(loaded?.status("bridge")).toMatchObject({ summary: { text: ["one"] } });
		await writeFile(join(dir, "src/index.ts"), code("two"));
		expect(await must("ext.reload").run({ ext: "bridge" })).toMatchObject({ ok: true });
		expect(loaded?.status("bridge")).toMatchObject({ summary: { text: ["two"] } });
	});
	it("自动源码监听与当前生效条共用挂载服务，收摊可停止自动更新", async () => {
		const dir = await plant();
		const all = defs();
		await must("ext.install", all).run({ ext: "bridge" });
		const watch = must("ext.watch", all);
		expect(await watch.run({ ext: "bridge" })).toMatchObject({ ok: true });
		expect(watch.active?.()).not.toBeNull();
		await writeFile(join(dir, "src/index.ts"), code("two"));
		await vi.waitFor(
			() => expect(loaded?.status("bridge")).toMatchObject({ summary: { text: ["two"] } }),
			{ timeout: 4000 },
		);
		watch.reset?.();
		expect(watch.active?.()).toBeNull();
		expect(development.list()[0]?.watching).toBe(false);
	});
	it("源码校验失败仍继续监听，修正后恢复且生效条显示原因", async () => {
		const dir = await plant();
		const all = defs();
		await must("ext.install", all).run({ ext: "bridge" });
		const watch = must("ext.watch", all);
		await watch.run({ ext: "bridge" });
		await writeFile(join(dir, "src/index.ts"), "export !!! invalid");
		await vi.waitFor(() => expect(watch.active?.()?.label).toContain("源码加载失败"), {
			timeout: 4000,
		});
		expect(loaded?.status("bridge")).toMatchObject({ summary: { text: ["one"] } });
		await writeFile(join(dir, "src/index.ts"), code("fixed"));
		await vi.waitFor(
			() => expect(loaded?.status("bridge")).toMatchObject({ summary: { text: ["fixed"] } }),
			{ timeout: 4000 },
		);
	});
});
