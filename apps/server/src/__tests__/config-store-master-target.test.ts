/**
 * 主人目标只许指向私聊目标(ADR-0021 决策 57):把关在真正写盘的 ConfigStore,四个写入口各一条 ——
 * `patchSettings`(设置里的 `master.targetId`)、`patchTarget` / `upsertTarget`(把当前的主人目标改成不再是私聊)、
 * `deleteTarget`(删的正是主人目标)、`replaceSections`(恢复备份)。清空永远允许,改别的目标不受影响。
 *
 * **开机读盘不拒开机**:盘上的主人目标指向群或不存在时照常读进来、不抛 —— 靠迁移清空 + 发送时复检兜底。
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection, MessageBus, PushTarget, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../config/schema.js";
import {
	CONFIG_DIR,
	CORE_SETTINGS_FILE,
	type ConfigStore,
	ConfigValidationError,
	createConfigStore,
	type SettingsPatch,
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

const CONNECTION: Connection = {
	id: randomUUID(),
	name: "NapCat",
	platform: "onebot",
	enabled: true,
	kind: "direct",
	connector: "http",
	config: {
		transport: "http",
		baseUrl: "http://127.0.0.1:3000",
		protocolVersion: "v11",
		headers: {},
		timeoutMs: 15_000,
		imageMinTimeoutMs: 30_000,
		mergeForwardMinTimeoutMs: 60_000,
		retryTimes: 0,
		retryIntervalMs: 1_000,
	},
} as Connection;

function session(
	name: string,
	scope: "group" | "private" | "channel",
	address: string,
): PushTarget {
	return {
		id: randomUUID(),
		name,
		connectionId: CONNECTION.id,
		kind: "session",
		scope,
		address,
		enabled: true,
	} as PushTarget;
}

let dataDir: string;
let bus: MessageBus;
let store: ConfigStore;
let priv: PushTarget;
let otherPriv: PushTarget;
let group: PushTarget;

const open = async (): Promise<ConfigStore> => {
	const s = createConfigStore({
		bootstrap: makeBootstrap(dataDir),
		dataRoot: dataDir,
		bus,
		serviceCtx: makeServiceCtx(),
	});
	await s.load();
	return s;
};

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-config-master-target-"));
	await mkdir(join(dataDir, ...CONFIG_DIR), { recursive: true });
	bus = createNodeMessageBus();
	store = await open();
	await store.upsertConnection(CONNECTION);
	priv = session("主人私聊", "private", "10001");
	otherPriv = session("另一个私聊", "private", "10002");
	group = session("通知群", "group", "20001");
	for (const t of [priv, otherPriv, group]) await store.upsertTarget(t);
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

async function rejection(p: Promise<unknown>): Promise<ConfigValidationError> {
	const err = await p.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(ConfigValidationError);
	return err as ConfigValidationError;
}

/** 线上用 `null` 表示清除一格(deepMerge 的约定),类型上的补丁没有这一档,所以转一下。 */
const setMaster = (targetId: string | null) =>
	store.patchSettings({ core: { master: { targetId } } } as unknown as SettingsPatch);

describe("patchSettings:master.targetId", () => {
	it("指向私聊目标 → 放行并落盘", async () => {
		await setMaster(priv.id);
		expect(store.getGlobals().master.targetId).toBe(priv.id);
	});

	it("指向群目标 → 拒收(invalid),说明原因,一个字都不改", async () => {
		const err = await rejection(setMaster(group.id));
		expect(err.code).toBe("invalid");
		expect(err.message).toMatch(/私聊/);
		expect(store.getGlobals().master.targetId).toBeUndefined();
	});

	it("指向不存在的目标 → 拒收(invalid)", async () => {
		const err = await rejection(setMaster(randomUUID()));
		expect(err.code).toBe("invalid");
		expect(err.message).toMatch(/不存在/);
		expect(store.getGlobals().master.targetId).toBeUndefined();
	});

	it("清空(null)永远允许 —— 哪怕盘上存着的是失效的值", async () => {
		await setMaster(priv.id);
		await setMaster(null);
		expect(store.getGlobals().master.targetId).toBeUndefined();
	});

	it("没动主人那一格的设置照常能存(不被盘上留着的失效值拖住)", async () => {
		// 先在盘上造一个指向群的主人目标:开机读盘不拒。
		await store.patchSettings({ core: { app: { memoryLog: false } } });
		const corePath = join(dataDir, ...CORE_SETTINGS_FILE);
		const raw = JSON.parse(await readFile(corePath, "utf8")) as Record<string, unknown>;
		await writeFile(corePath, JSON.stringify({ ...raw, master: { targetId: group.id } }), "utf8");
		const reopened = await open();
		expect(reopened.getGlobals().master.targetId).toBe(group.id);

		await reopened.patchSettings({ core: { app: { memoryLog: true } } });
		expect(reopened.getGlobals().app.memoryLog).toBe(true);
		// 要把主人那一格改成别的群仍然拦
		await rejection(reopened.patchSettings({ core: { master: { targetId: group.id } } }));
	});
});

describe("patchTarget / upsertTarget:当前的主人目标不许改成不再是私聊", () => {
	beforeEach(async () => {
		await setMaster(priv.id);
	});

	it("patchTarget 把主人目标改成群 → 拒收,说明「它是主人目标」", async () => {
		const err = await rejection(store.patchTarget(priv.id, { scope: "group" }));
		expect(err.code).toBe("invalid");
		expect(err.message).toMatch(/主人目标/);
		expect(store.getTargets().find((t) => t.id === priv.id)).toMatchObject({ scope: "private" });
	});

	it("upsertTarget 同 id 换成群 → 拒收", async () => {
		const err = await rejection(store.upsertTarget({ ...priv, scope: "group" } as PushTarget));
		expect(err.message).toMatch(/主人目标/);
	});

	it("改主人目标的别的格(名字)照常能存", async () => {
		await store.patchTarget(priv.id, { name: "新名字" });
		expect(store.getTargets().find((t) => t.id === priv.id)?.name).toBe("新名字");
	});

	it("改别的目标(哪怕改成群)不受影响", async () => {
		await store.patchTarget(otherPriv.id, { scope: "group" });
		expect(store.getTargets().find((t) => t.id === otherPriv.id)).toMatchObject({ scope: "group" });
	});
});

describe("deleteTarget:不许删主人目标", () => {
	it("删的正是主人目标 → conflict,目标还在", async () => {
		await setMaster(priv.id);
		const err = await rejection(store.deleteTarget(priv.id));
		expect(err.code).toBe("conflict");
		expect(err.message).toMatch(/主人目标/);
		expect(store.getTargets().some((t) => t.id === priv.id)).toBe(true);
	});

	it("换掉(或清空)主人目标之后就能删", async () => {
		await setMaster(priv.id);
		await setMaster(otherPriv.id);
		expect(await store.deleteTarget(priv.id)).toBe(true);
	});

	it("删别的目标不受影响", async () => {
		await setMaster(priv.id);
		expect(await store.deleteTarget(group.id)).toBe(true);
	});
});

describe("replaceSections(恢复备份):跨分区校验", () => {
	it("备份里的主人目标指向群 → 整份中止,什么都不写", async () => {
		const before = { globals: store.getGlobals(), targets: store.getTargets() };
		const err = await rejection(
			store.replaceSections({
				globals: { ...store.getGlobals(), master: { targetId: group.id } },
			}),
		);
		expect(err.message).toMatch(/私聊/);
		expect(store.getGlobals()).toEqual(before.globals);
		expect(store.getTargets()).toEqual(before.targets);
	});

	it("备份里的主人目标指向它自己带来的目标表里不存在的 → 整份中止", async () => {
		await rejection(
			store.replaceSections({
				globals: { ...store.getGlobals(), master: { targetId: priv.id } },
				targets: [group],
			}),
		);
	});

	it("目标表被换掉、而现有的主人目标不在新表里 → 整份中止", async () => {
		await setMaster(priv.id);
		await rejection(store.replaceSections({ connections: [CONNECTION], targets: [group] }));
	});

	it("主人目标指向私聊(备份自己带着目标表)→ 放行;没配主人 → 放行", async () => {
		await store.replaceSections({
			globals: { ...store.getGlobals(), master: { targetId: otherPriv.id } },
			targets: [priv, otherPriv, group],
		});
		expect(store.getGlobals().master.targetId).toBe(otherPriv.id);
		await store.replaceSections({ globals: { ...store.getGlobals(), master: {} } });
		expect(store.getGlobals().master.targetId).toBeUndefined();
	});
});

describe("开机读盘不拒开机", () => {
	async function writeMaster(targetId: string): Promise<void> {
		const corePath = join(dataDir, ...CORE_SETTINGS_FILE);
		const raw = JSON.parse(await readFile(corePath, "utf8")) as Record<string, unknown>;
		await writeFile(corePath, JSON.stringify({ ...raw, master: { targetId } }), "utf8");
	}

	it("盘上的主人目标指向群 → 照常读进来,不抛", async () => {
		await setMaster(priv.id);
		await writeMaster(group.id);
		const reopened = await open();
		expect(reopened.getGlobals().master.targetId).toBe(group.id);
	});

	it("盘上的主人目标指向不存在的目标 → 照常读进来,不抛", async () => {
		await setMaster(priv.id);
		const ghost = randomUUID();
		await writeMaster(ghost);
		const reopened = await open();
		expect(reopened.getGlobals().master.targetId).toBe(ghost);
	});
});
