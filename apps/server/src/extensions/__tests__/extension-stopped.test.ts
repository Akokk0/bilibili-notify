/**
 * 「拓展不在跑了」只认一处(ADR-0019 决策 61):它那面 ctx 开始收摊的那一刻,装载器递过去的
 * `onStopped` 叫一次。停用、加载失败、换代码、关机走的都是收摊,所以每条路都得叫到 —— 漏了哪条,
 * 首页上它名下的订阅就一直「在播」。
 *
 * 钉在装载器这一层(`loadExtensions()`),拓展是装进装载根的 v2 小拓展,代码经 `importModule` 换进来。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, ServiceContext, SubscriptionReportDelivery } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createAdapterRegistry } from "../../platforms/registry.js";
import type { ExtensionContext } from "../context.js";
import { loadExtensions } from "../loader.js";
import { createExtensionMounts } from "../mount.js";
import { createExtensionUpgrades } from "../upgrade.js";

const ID = "douyin";
const SUB = {
	id: "f0000000-0000-4000-8000-000000000001",
	extensionId: ID,
	externalId: "sec-1",
	enabled: true,
};
const LIVE = { live: true, viewers: 1 };

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
			apiVersion: 2,
			contributes: {
				subscription: {
					display: { label: "抖音", shortLabel: "抖", color: "#fe2c55" },
					events: ["liveStart", "liveEnd"],
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
};

/** 起一个真装载器;`events` 按先后记下「停了」与「报上来了」。 */
async function boot(activate: (ctx: ExtensionContext) => void | Promise<void>) {
	const events: string[] = [];
	let on = true;
	const loaded = await loadExtensions({
		root,
		host,
		mounts: createExtensionMounts(),
		adapters: createAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		subscriptions: () => [SUB],
		onSubscriptionsChanged: () => ({ dispose() {} }),
		onSubscriptionReport: (delivery: SubscriptionReportDelivery) =>
			events.push(`reported ${delivery.report.kind}`),
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
	it("停用 → 叫一次;之后它再报,宿主不收", async () => {
		let report: (() => Promise<void>) | undefined;
		const h = await boot((ctx) => {
			const handle = ctx.registerSubscriptionSource({ lookup: () => [] });
			report = () => handle.reportLiveStatus(SUB.externalId, LIVE);
		});
		await report?.();
		h.setEnabled(false);
		await h.loaded.sync();
		expect(h.events).toEqual(["reported liveStatus", `stopped ${ID}`]);
		await expect(report?.()).rejects.toThrow();
		expect(h.events).toEqual(["reported liveStatus", `stopped ${ID}`]);
	});

	it("activate 报了一条才抛(加载失败)→ 照样叫到", async () => {
		const h = await boot(async (ctx) => {
			const handle = ctx.registerSubscriptionSource({ lookup: () => [] });
			await handle.reportLiveStatus(SUB.externalId, LIVE);
			throw new Error("activate 炸了");
		});
		expect(h.loaded.list()[0]?.state).toBe("failed");
		expect(h.events).toEqual(["reported liveStatus", `stopped ${ID}`]);
	});

	it("换代码(重载)→ 旧的那面叫一次,新的照常跑", async () => {
		const h = await boot((ctx) => {
			ctx.registerSubscriptionSource({ lookup: () => [] });
		});
		await h.loaded.reload(ID);
		expect(h.events).toEqual([`stopped ${ID}`]);
		expect(h.loaded.list()[0]?.state).toBe("running");
	});

	it("宿主关机 → 叫一次;再收一次摊不重复叫", async () => {
		const h = await boot((ctx) => {
			ctx.registerSubscriptionSource({ lookup: () => [] });
		});
		await h.loaded.dispose();
		await h.loaded.dispose();
		expect(h.events).toEqual([`stopped ${ID}`]);
	});
});
