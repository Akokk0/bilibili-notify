/**
 * 「拓展不在跑了」只认一处(ADR-0019 决策 61):它那面 ctx 开始收摊的那一刻,装载器递过去的
 * `onStopped` 叫一次。停用、加载失败、换代码、关机走的都是收摊,所以每条路都得叫到 —— 漏了哪条,
 * 首页上它名下的订阅就一直「在播」。
 *
 * 钉在装载器这一层(`loadExtensions()`),拓展是装进装载根的 v3 小拓展,代码经 `importModule` 换进来。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceDef } from "@bilibili-notify/extension";
import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import { ignoredProblems } from "../../__tests__/support/ignored-problems.js";
import { inertTransitImages } from "../../__tests__/support/integration-io.js";
import { memoryIntegrationStore } from "../../__tests__/support/memory-key-value-store.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import type { ExtensionContext } from "../context.js";
import { loadExtensions } from "../loader.js";
import { createExtensionMounts } from "../mount.js";
import { createExtensionUpgrades } from "../upgrade.js";

const ID = "douyin";
let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bn-ext-stopped-"));
	await mkdir(join(root, ID), { recursive: true });
	await writeFile(
		join(root, ID, "extension.json"),
		JSON.stringify({
			id: ID,
			name: "抖音订阅",
			description: "测试用",
			version: "0.1.0",
			apiVersion: 3,
			contributes: {
				subscription: {
					label: "抖音",
					shortLabel: "抖",
					color: "#fe2c55",
					supportedFeatures: ["liveStart", "liveStreaming", "liveEnd"],
				},
			},
		}),
	);
	await writeFile(join(root, ID, "index.mjs"), "export function activate() {}");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const silent: Logger = { info() {}, warn() {}, error() {}, debug() {} };
const host: ServiceContext = {
	logger: silent,
	setInterval: () => ({ dispose() {} }),
	setTimeout: () => ({ dispose() {} }),
	onDispose() {},
	signal: new AbortController().signal,
	track: () => {},
};

function sourceDef(): SourceDef {
	return {
		start() {},
		stop() {},
		searchCreators: async () => ({ ok: true, candidates: [] }),
		fetchLiveStatus: async () => ({ ok: true, kind: "offline" }),
	};
}

/** 起一个真装载器;`events` 按先后记下「停了」与「报上来了」。 */
async function boot(activate: (ctx: ExtensionContext) => void | Promise<void>) {
	const events: string[] = [];
	let on = true;
	const loaded = await loadExtensions({
		transitImages: inertTransitImages,
		locale: fixedLocale(),
		root,
		host,
		loggerOf: () => silent,
		integrationStore: memoryIntegrationStore(),
		problems: ignoredProblems,
		mounts: createExtensionMounts({ logger: silentLogger }),
		adapters: createPlatformAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		registerSource: async () => ({ dispose() {} }),
		onStopped: (id) => events.push(`stopped ${id}`),
		settings: () => undefined,
		onSettingsChanged: () => ({ dispose() {} }),
		inbound: {},
		upgrades: createExtensionUpgrades(),
		isEnabled: () => on,
		maxFailures: 3,
		importModule: async () => ({ activate }),
	});
	return {
		loaded,
		events,
		setEnabled(next: boolean) {
			on = next;
		},
	};
}

describe("onStopped:拓展不在跑了", () => {
	it("停用 → 叫一次", async () => {
		const h = await boot((ctx) => {
			ctx.registerSource(sourceDef());
		});
		h.setEnabled(false);
		await h.loaded.sync();
		expect(h.events).toEqual([`stopped ${ID}`]);
	});

	it("activate 抛了(加载失败)→ 照样叫到", async () => {
		const h = await boot(async (ctx) => {
			ctx.registerSource(sourceDef());
			throw new Error("activate 炸了");
		});
		expect(h.loaded.list()[0]?.state).toBe("failed");
		expect(h.events).toEqual([`stopped ${ID}`]);
	});

	it("换代码(重载)→ 旧的那面叫一次,新的照常跑", async () => {
		const h = await boot((ctx) => {
			ctx.registerSource(sourceDef());
		});
		await h.loaded.reload(ID);
		expect(h.events).toEqual([`stopped ${ID}`]);
		expect(h.loaded.list()[0]?.state).toBe("running");
	});

	it("宿主关机 → 叫一次;再收一次摊不重复叫", async () => {
		const h = await boot((ctx) => {
			ctx.registerSource(sourceDef());
		});
		await h.loaded.dispose();
		await h.loaded.dispose();
		expect(h.events).toEqual([`stopped ${ID}`]);
	});
});
