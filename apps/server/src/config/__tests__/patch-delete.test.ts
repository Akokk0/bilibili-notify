/**
 * 单元测试 — PATCH 的删除语义(JSON Merge Patch)。
 *
 * 配置 PATCH 是差异更新:**键不出现 = 该字段不改**,只有显式 `null` 才是删除。
 * dashboard 上每一个「关掉某项覆盖 / 退回跟随全局」的开关都压在这条语义上 ——
 * 前端若靠「把键删掉再整个回传」来表达关闭,请求会 200,后端却原样留着旧值,
 * 用户看到的是「关不掉」(卡片单独样式、图片日志等级都曾这么坏过)。
 *
 * 这里从 store 的公开 API 验一遍,免得日后有人「优化」deepMerge 时把它改回
 * 纯合并 —— 那种回归在前端测试里看不出来(前端只管发对了 null)。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BiliEvents, Disposable, MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../schema.js";
import { type ConfigStore, createConfigStore } from "../store.js";

function makeBus(): MessageBus {
	const listeners = new Map<keyof BiliEvents, Set<(...a: unknown[]) => void>>();
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
	};
}

let dataDir: string;
let store: ConfigStore;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-patch-del-"));
	const b: BootstrapConfig = {
		server: { host: "127.0.0.1", port: 8787 },
		dataDir,
		logLevel: "info",
	};
	store = createConfigStore({ bootstrap: b, bus: makeBus(), serviceCtx: makeCtx() });
	await store.load();
});

describe("patchGlobals 的删除语义", () => {
	it("显式 null 删掉某个卡片类型的覆盖,其它类型不受牵连", async () => {
		await store.patchGlobals({
			defaults: {
				cardStyleByKind: {
					live: { cardColorStart: "#live" },
					sc: { cardColorStart: "#sc" },
				},
			},
		});
		expect(store.getGlobals().defaults.cardStyleByKind?.live).toBeTruthy();

		// 前端「关掉直播卡的单独样式」下发的形状:关掉的给 null,留着的原样。
		await store.patchGlobals({
			defaults: {
				cardStyleByKind: {
					live: null,
					dynamic: null,
					sc: { cardColorStart: "#sc" },
					guard: null,
				},
			},
		} as never);

		const byKind = store.getGlobals().defaults.cardStyleByKind;
		expect(byKind?.live).toBeUndefined();
		expect(byKind?.sc).toEqual({ cardColorStart: "#sc" });
	});

	it("键不出现 = 不改 —— 这正是「关不掉」的成因,钉住它免得被当成删除", async () => {
		await store.patchGlobals({
			defaults: { cardStyleByKind: { live: { cardColorStart: "#live" } } },
		});
		// 老前端的下发形状:live 被 delete 掉,于是整个 map 是空的。
		await store.patchGlobals({ defaults: { cardStyleByKind: {} } });
		expect(store.getGlobals().defaults.cardStyleByKind?.live).toEqual({
			cardColorStart: "#live",
		});
	});

	it("显式 null 把模块日志等级退回跟随全局", async () => {
		await store.patchGlobals({ app: { logLevels: { image: "debug" } } });
		expect(store.getGlobals().app.logLevels?.image).toBe("debug");

		await store.patchGlobals({ app: { logLevels: { image: null } } } as never);
		expect(store.getGlobals().app.logLevels?.image).toBeUndefined();
	});
});
