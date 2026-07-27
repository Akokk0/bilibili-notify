/**
 * 「已知道这版默认」的账本走一趟保存路径的往返。
 *
 * 账本是**逐字段增量**记的:主人这次处理 liveStart,下次处理 liveEnd,两笔得都在。
 * 若 PATCH 合并把这个 record 整体替换掉,第二笔会把第一笔冲掉 —— 界面上的表现是
 * 「处理过的提示又冒出来了」,而且只有处理过两条以上的人才撞得到。
 *
 * 这条路径本仓库翻过车(见 `internal/patch.ts` 抬头那段「关不掉」),所以单独钉一遍:
 * 落盘 → 换个 store 重新读 → 两笔都还在。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BiliEvents, Disposable, MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../config/schema.js";
import { type ConfigStore, createConfigStore } from "../config/store.js";

function makeFakeBus(): MessageBus {
	const listeners = new Map<keyof BiliEvents, Set<(...a: unknown[]) => void>>();
	return {
		emit(event, ...args) {
			for (const h of [...(listeners.get(event) ?? [])]) {
				(h as (...a: unknown[]) => void)(...(args as unknown[]));
			}
		},
		on(event, handler): Disposable {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			const wrapped = (...a: unknown[]) => (handler as (...x: unknown[]) => void)(...a);
			set.add(wrapped);
			return { dispose: () => listeners.get(event)?.delete(wrapped) };
		},
	} as MessageBus;
}

function makeFakeServiceCtx(): ServiceContext {
	return {
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	} as unknown as ServiceContext;
}

function makeBootstrap(dataDir: string): BootstrapConfig {
	return {
		server: { host: "127.0.0.1", port: 8787 },
		dataDir,
		logLevel: "info",
		cookieEncryptionKey: "0123456789abcdef0123456789abcdef",
	};
}

let dataDir: string;
let store: ConfigStore;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-seen-"));
	store = createConfigStore({
		bootstrap: makeBootstrap(dataDir),
		bus: makeFakeBus(),
		serviceCtx: makeFakeServiceCtx(),
	});
	await store.load();
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

describe("templateDefaultsSeen 的保存往返", () => {
	it("PATCH 记一笔 → 换个 store 重新读还在", async () => {
		await store.patchGlobals({ defaults: { templateDefaultsSeen: { liveStart: "aaa" } } });
		const reopened = createConfigStore({
			bootstrap: makeBootstrap(dataDir),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await reopened.load();
		expect(reopened.getGlobals().defaults.templateDefaultsSeen.liveStart).toBe("aaa");
	});

	it("分两次记两个字段 → 两笔都在,后一笔不冲掉前一笔", async () => {
		// 这才是这条测试存在的理由。整体替换的话 liveStart 会在第二次 PATCH 后消失,
		// 主人看到的是「上次明明处理过的提示,怎么又冒出来了」。
		await store.patchGlobals({ defaults: { templateDefaultsSeen: { liveStart: "aaa" } } });
		await store.patchGlobals({ defaults: { templateDefaultsSeen: { liveEnd: "bbb" } } });
		expect(store.getGlobals().defaults.templateDefaultsSeen).toMatchObject({
			liveStart: "aaa",
			liveEnd: "bbb",
		});
	});

	it("首次启动落盘的 globals.json 里账本是满的,不是空对象", async () => {
		// 全新安装不该看见任何「有更新」。账本空着的话,主人一改文案就被提示。
		const seen = store.getGlobals().defaults.templateDefaultsSeen;
		expect(Object.keys(seen).length).toBeGreaterThan(0);
		expect(seen.liveStart).toBeTruthy();
	});
});
