/**
 * 语言与口吻两格「默认不落盘」(ADR-0037 决策 3 下的 🔗、决策 17):
 * 老 core.json 缺这两格,开机、写别的格之后盘上仍然没有它们;
 * 主人设了才有,发 `null` 删键后又没了(= 改回跟默认走)。
 * 用真配置仓、真文件:schema 若给这两格补了默认值,第一次保存就会把它们写进盘。
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BusEvents, Disposable, MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../schema.js";
import { CORE_SETTINGS_FILE, type ConfigStore, createConfigStore } from "../store.js";

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

let dataDir: string;
let store: ConfigStore;

function makeStore(): ConfigStore {
	const b: BootstrapConfig = {
		server: { host: "127.0.0.1", port: 8787 },
		dataDir,
		logLevel: "info",
	};
	return createConfigStore({
		bootstrap: b,
		dataRoot: dataDir,
		bus: makeBus(),
		serviceCtx: makeCtx(),
	});
}

const onDisk = async (): Promise<Record<string, unknown>> =>
	JSON.parse(await readFile(join(dataDir, ...CORE_SETTINGS_FILE), "utf8")) as Record<
		string,
		unknown
	>;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-text-settings-"));
	store = makeStore();
	await store.load();
});

describe("locale / voice 不落盘", () => {
	it("全新安装首启落下的 core.json 里没有这两格", async () => {
		const raw = await onDisk();
		expect("locale" in raw).toBe(false);
		expect("voice" in raw).toBe(false);
	});

	it("老 core.json 缺这两格 → 照常开机;写别的格之后盘上仍然没有", async () => {
		const file = join(dataDir, ...CORE_SETTINGS_FILE);
		const raw = await onDisk();
		delete raw.locale;
		delete raw.voice;
		await writeFile(file, JSON.stringify(raw), "utf8");

		const reborn = makeStore();
		await reborn.load();
		expect(reborn.getGlobals().locale).toBeUndefined();
		await reborn.patchGlobals({ mutedUntil: 1_786_500_000_000 });

		const after = await onDisk();
		expect("locale" in after).toBe(false);
		expect("voice" in after).toBe(false);
	});

	it("设了才有;发 null 删键后盘上又没了", async () => {
		await store.patchGlobals({ voice: "plain", locale: "en" });
		expect((await onDisk()).voice).toBe("plain");
		expect((await onDisk()).locale).toBe("en");

		await store.patchGlobals({ voice: null, locale: null } as never);
		const after = await onDisk();
		expect("voice" in after).toBe(false);
		expect("locale" in after).toBe(false);
		expect(store.getGlobals().voice).toBeUndefined();
	});
});
