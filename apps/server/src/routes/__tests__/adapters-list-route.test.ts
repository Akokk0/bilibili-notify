/**
 * `GET /api/adapters` —— 适配器表:每个平台适配器一条 `{ key, descriptor }`(ADR-0024 决策 1、3)。
 *
 * 跑真 app、真适配器登记表;装载器那张表手造。两张表照 `/api/sources` 的做法合:
 * - 登记表里不是拓展的(三个内置)取适配器自己的 `descriptor()`,每次读时现取(名字跟着此刻的语言);
 * - 拓展取装载器那份清单的推送那一口(已按当前语言盖好译文),跑没跑都列;在跑的也取清单那份。
 * 内置三个的连接配置项随 4-29 和表单一起设计,这一片先是空表。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdaptersResponse } from "@bilibili-notify/contract";
import type { PlatformAdapter, PlatformAdapterDescriptor } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeAdapterContext } from "../../__tests__/support/adapter-ctx.js";
import { builtinAdapterStubs } from "../../__tests__/support/builtin-adapter-stubs.js";
import { createApp, createCardSkinStore } from "../../app.js";
import type { BootstrapConfig } from "../../config/schema.js";
import type { ExtensionEntry } from "../../extensions/loader.js";
import { createAppRuntime } from "../../runtime/bootstrap.js";

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

/** 清单里开了推送那一口的拓展行。 */
function extensionEntry(
	id: string,
	state: ExtensionEntry["state"],
	push: Record<string, unknown>,
): ExtensionEntry {
	return {
		id,
		dir: `/data/extensions/${id}`,
		state,
		manifest: {
			id,
			name: `${id} 拓展`,
			description: "测试用",
			version: "1.0.0",
			apiVersion: 1,
			contributes: { push },
		} as never,
	};
}

/** 手写的适配器:只有键、启停与描述(读口只问这几样)。 */
function adapterOf(adapterKey: string, descriptor: () => PlatformAdapterDescriptor) {
	return { adapterKey, start: () => {}, stop: () => {}, descriptor } as unknown as PlatformAdapter;
}

describe("GET /api/adapters", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-adapters-list-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	async function boot(opts: {
		adapters: readonly PlatformAdapter[];
		entries?: () => ExtensionEntry[];
		settle?: () => Promise<void>;
	}) {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [] },
		);
		await runtime.configStore.load();
		for (const adapter of opts.adapters) {
			await runtime.adapterRegistry.register(adapter, fakeAdapterContext().ctx);
		}
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			// 装载器只用到列表与「头一轮扫完」;拓展自己的挂载口给个空的。
			extensions: {
				loaded: opts.entries ?? (() => []),
				mounts: { route: new Hono() },
				...(opts.settle ? { settle: opts.settle } : {}),
			} as never,
		});
		const read = async () => {
			const res = await app.request("/api/adapters");
			return { status: res.status, body: (await res.json()) as AdaptersResponse };
		};
		return { read, dispose: () => runtime.dispose() };
	}

	it("内置三个各带自己的脸(全名、短名、颜色),不带图标,连接配置项先是空表", async () => {
		const { read, dispose } = await boot({ adapters: builtinAdapterStubs() });
		const { status, body } = await read();
		await dispose();
		expect(status).toBe(200);
		expect(body.adapters).toEqual([
			{
				key: "onebot",
				descriptor: {
					label: "OneBot v11",
					shortLabel: "OneBot",
					color: "#3b82f6",
					settingsFields: [],
				},
			},
			{
				key: "qq-official",
				descriptor: {
					label: "QQ 官方机器人",
					shortLabel: "QQ官方",
					color: "#14b8a6",
					settingsFields: [],
				},
			},
			{
				key: "webhook",
				descriptor: {
					label: "Webhook",
					shortLabel: "Webhook",
					color: "#94a3b8",
					settingsFields: [],
				},
			},
		]);
	});

	it("内置的描述每次读时现取:适配器那边的名字变了(换了语言),下一次读就是新的", async () => {
		let label = "旧名字";
		const { read, dispose } = await boot({
			adapters: [
				adapterOf("onebot", () => ({
					label,
					shortLabel: "OB",
					color: "#000000",
					settingsFields: [],
				})),
			],
		});
		expect((await read()).body.adapters[0]?.descriptor.label).toBe("旧名字");
		label = "新名字";
		expect((await read()).body.adapters[0]?.descriptor.label).toBe("新名字");
		await dispose();
	});

	it("拓展跑没跑都照清单列出;在跑的取清单那份描述,不取登记表上那份", async () => {
		const push = {
			label: "机器人框架桥接",
			shortLabel: "桥",
			color: "#6366f1",
			settingsFields: [{ key: "token", label: "令牌", type: "string", required: true }],
		};
		const { read, dispose } = await boot({
			adapters: [
				adapterOf("bridge", () => ({
					label: "旧名字",
					shortLabel: "旧",
					color: "#000000",
					settingsFields: [],
				})),
			],
			entries: () => [
				extensionEntry("bridge", "running", push),
				extensionEntry("relay", "disabled", { label: "中继", shortLabel: "中", color: "#111111" }),
				extensionEntry("broken-push", "failed", {
					label: "坏的",
					shortLabel: "坏",
					color: "#222222",
				}),
			],
		});
		const { body } = await read();
		await dispose();
		expect(body.adapters).toEqual([
			{ key: "bridge", descriptor: push },
			{
				key: "relay",
				descriptor: { label: "中继", shortLabel: "中", color: "#111111", settingsFields: [] },
			},
			{
				key: "broken-push",
				descriptor: { label: "坏的", shortLabel: "坏", color: "#222222", settingsFields: [] },
			},
		]);
	});

	it("没开推送那一口的拓展、清单读不出来的拓展不列", async () => {
		const subscriptionOnly: ExtensionEntry = {
			...extensionEntry("douyin", "running", {}),
			manifest: {
				id: "douyin",
				name: "抖音",
				description: "测试用",
				version: "1.0.0",
				apiVersion: 1,
				contributes: { subscription: { label: "抖音", supportedFeatures: ["post"] } },
			} as never,
		};
		const unreadable: ExtensionEntry = {
			id: "broken",
			dir: "/data/extensions/broken",
			state: "failed",
			detail: "清单读不出来",
		};
		const { read, dispose } = await boot({
			adapters: [],
			entries: () => [subscriptionOnly, unreadable],
		});
		const { body } = await read();
		await dispose();
		expect(body.adapters).toEqual([]);
	});

	it("等装载器头一轮扫完再答:开机那一刻读,拓展的适配器也不缺", async () => {
		let scanned = false;
		const { read, dispose } = await boot({
			adapters: [],
			entries: () =>
				scanned
					? [
							extensionEntry("bridge", "running", {
								label: "桥",
								shortLabel: "桥",
								color: "#6366f1",
							}),
						]
					: [],
			settle: async () => {
				await Promise.resolve();
				scanned = true;
			},
		});
		const { body } = await read();
		await dispose();
		expect(body.adapters.map((entry) => entry.key)).toEqual(["bridge"]);
	});
});
