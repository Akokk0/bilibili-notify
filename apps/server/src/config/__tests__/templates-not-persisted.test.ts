/**
 * 文字模板「只存主人改过的」(ADR-0037 决策 10):
 * 新装写下的 core.json 里 `defaults.templates` 没有任何文字格,写别的格之后仍然没有;
 * 主人改了才有,发 `null` 删键后又没了(= 改回跟当前语言的默认走)。
 * 用真配置仓、真文件:schema 若给文字格补了 `.default`,第一次保存就会把整份默认文字写进盘。
 */

import { mkdtemp, readFile } from "node:fs/promises";
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
	dataDir = await mkdtemp(join(tmpdir(), "bn-template-settings-"));
	store = makeStore();
	await store.load();
});

const TEXT_KEYS = [
	"liveStart",
	"liveStreaming",
	"liveEnd",
	"liveSummary",
	"post",
	"postVideo",
	"viewerChat",
	"viewerEnter",
] as const;

const templatesOnDisk = async (): Promise<Record<string, unknown>> => {
	const raw = await onDisk();
	return (raw.defaults as { templates: Record<string, unknown> }).templates;
};

describe("文字模板只存改过的", () => {
	it("全新安装首启落下的 core.json 里没有任何文字格", async () => {
		const templates = await templatesOnDisk();
		for (const key of TEXT_KEYS) expect(key in templates).toBe(false);
		expect(templates.membership).toEqual({});
	});

	it("写别的格之后盘上仍然没有文字格", async () => {
		await store.patchGlobals({ mutedUntil: 1_786_500_000_000 });
		const templates = await templatesOnDisk();
		for (const key of TEXT_KEYS) expect(key in templates).toBe(false);
	});

	it("改了才有;发 null 删键后盘上又没了", async () => {
		await store.patchGlobals({ defaults: { templates: { liveStart: "我自己写的" } } } as never);
		expect((await templatesOnDisk()).liveStart).toBe("我自己写的");

		await store.patchGlobals({ defaults: { templates: { liveStart: null } } } as never);
		expect("liveStart" in (await templatesOnDisk())).toBe(false);
		expect(store.getGlobals().defaults.templates.liveStart).toBeUndefined();
	});
});
