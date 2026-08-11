/**
 * 单元测试 — 全局静音的到期时刻在 globals 里怎么活下来。
 *
 * 静音存进 globals 换来两件事:重启不解除、网页上看得见。这个文件钉的就是这两件事
 * 各自的失效方式:
 *
 * - **别的设置一保存就把静音清掉** —— 面板保存走 PATCH,键不出现 = 不改。哪天有人把
 *   保存路径改成整份回传,静音就会在主人改任意一个开关时静悄悄消失。
 * - **老 globals.json 里没有这个字段** —— 独立端 load 时是 `parse` 而不是宽松合并,
 *   缺字段没有 default 就直接 ConfigValidationError,已经装好的用户开不了机。
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

const UNTIL = 1_786_500_000_000;

let dataDir: string;
let store: ConfigStore;

function makeStore(): ConfigStore {
	const b: BootstrapConfig = {
		server: { host: "127.0.0.1", port: 8787 },
		dataDir,
		logLevel: "info",
	};
	return createConfigStore({ bootstrap: b, bus: makeBus(), serviceCtx: makeCtx() });
}

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-mute-"));
	store = makeStore();
	await store.load();
});

describe("静音状态的存活", () => {
	it("没设置过就是 0 = 没在静音", () => {
		expect(store.getGlobals().mutedUntil).toBe(0);
	});

	it("写进去读得出来", async () => {
		await store.patchGlobals({ mutedUntil: UNTIL });
		expect(store.getGlobals().mutedUntil).toBe(UNTIL);
	});

	// 主人静音着,顺手在面板上改了个日志等级 —— 静音不该因此消失。
	it("保存别的设置不会把静音清掉", async () => {
		await store.patchGlobals({ mutedUntil: UNTIL });
		await store.patchGlobals({ app: { logLevel: "debug" } });
		expect(store.getGlobals().mutedUntil).toBe(UNTIL);
	});

	it("0 写得回去 —— 解除静音不能被当成「没传就是不改」", async () => {
		await store.patchGlobals({ mutedUntil: UNTIL });
		await store.patchGlobals({ mutedUntil: 0 });
		expect(store.getGlobals().mutedUntil).toBe(0);
	});

	// 「重启不解除静音」这件事全靠它落了盘。
	it("重启后还在", async () => {
		await store.patchGlobals({ mutedUntil: UNTIL });
		const reborn = makeStore();
		await reborn.load();
		expect(reborn.getGlobals().mutedUntil).toBe(UNTIL);
	});

	// 已经装好的用户盘上那份 globals.json 里没有这个字段。load 走的是 parse,
	// 缺字段没有 default 就直接开不了机。
	it("老 globals.json 缺这个字段 → 补 0,而不是启动失败", async () => {
		const file = join(dataDir, "state", "globals.json");
		const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		delete raw.mutedUntil;
		await writeFile(file, JSON.stringify(raw), "utf8");

		const reborn = makeStore();
		await reborn.load();
		expect(reborn.getGlobals().mutedUntil).toBe(0);
	});
});
