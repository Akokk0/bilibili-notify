import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BusEvents,
	Connection,
	Disposable,
	MessageBus,
	PushTarget,
	ServiceContext,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../config/schema.js";
import { CONFIG_DIR, type ConfigStore, createConfigStore } from "../config/store.js";
import { snapshotFor } from "./support/connection-snapshot.js";

// 目标不再自带平台:平台只在连接上。这份测试钉的是两道「改挂连接」的守卫(逐条写入与整节替换)
// 和读盘的宽容 —— 全部只碰自己的临时目录。

function makeBus(): MessageBus {
	return {
		emit: vi.fn(),
		on(_event: keyof BusEvents): Disposable {
			return { dispose() {} };
		},
	} as unknown as MessageBus;
}

function makeServiceCtx(): ServiceContext {
	return {
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: vi.fn(),
		signal: new AbortController().signal,
		track: vi.fn(),
	} as unknown as ServiceContext;
}

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "info" };
}

function makeStore(dir: string): ConfigStore {
	return createConfigStore({
		bootstrap: makeBootstrap(dir),
		dataRoot: dir,
		bus: makeBus(),
		serviceCtx: makeServiceCtx(),
	});
}

function onebotConnection(id: string = randomUUID(), name = "NapCat"): Connection {
	return {
		id,
		name,
		platform: "onebot",
		enabled: true,
		adapterKey: "onebot",
		platformSnapshot: snapshotFor("onebot"),
		settings: {
			transport: "http",
			baseUrl: "http://127.0.0.1:3000",
			protocolVersion: "v11",
			headers: {},
			timeoutMs: 15_000,
			imageMinTimeoutMs: 30_000,
			mergeForwardMinTimeoutMs: 60_000,
			maxRetries: 0,
			retryIntervalMs: 1_000,
		},
	} as Connection;
}

function qqOfficialConnection(id: string = randomUUID(), name = "官机"): Connection {
	return {
		id,
		name,
		platform: "qq-official",
		enabled: true,
		adapterKey: "qq-official",
		platformSnapshot: snapshotFor("qq-official"),
		settings: {
			appId: "1",
			appSecret: "s",
			sandbox: false,
			botType: "public",
			logReconnects: false,
		},
	} as Connection;
}

function sessionTarget(connectionId: string, id: string = randomUUID()): PushTarget {
	return {
		id,
		name: "群聊",
		connectionId,
		kind: "session",
		scope: "group",
		enabled: true,
		address: "10001",
	} as PushTarget;
}

const REJECT_MESSAGE = "建好之后不能换连接";

describe("ConfigStore:目标焊死在连接上", () => {
	let dir: string;
	let store: ConfigStore;
	const onebotA = onebotConnection();
	const onebotB = onebotConnection(undefined, "NapCat 2");
	const qq = qqOfficialConnection();

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bn-target-guard-"));
		store = makeStore(dir);
		await store.load();
		await store.upsertConnection(onebotA);
		await store.upsertConnection(onebotB);
		await store.upsertConnection(qq);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("patchTarget 改 connectionId(同平台也算) → 被拒,path 点名 connectionId", async () => {
		const target = sessionTarget(onebotA.id);
		await store.upsertTarget(target);
		await expect(store.patchTarget(target.id, { connectionId: onebotB.id })).rejects.toMatchObject({
			code: "invalid",
			scope: "targets",
			message: expect.stringContaining(REJECT_MESSAGE),
			issues: [expect.objectContaining({ path: ["connectionId"] })],
		});
		await expect(store.patchTarget(target.id, { connectionId: qq.id })).rejects.toMatchObject({
			code: "invalid",
			issues: [expect.objectContaining({ path: ["connectionId"] })],
		});
		expect(store.getTargets().find((t) => t.id === target.id)?.connectionId).toBe(onebotA.id);
	});

	it("patchTarget 不改连接、只改别的格 → 成功", async () => {
		const target = sessionTarget(onebotA.id);
		await store.upsertTarget(target);
		const patched = await store.patchTarget(target.id, {
			name: "改了名",
			connectionId: onebotA.id,
		});
		expect(patched.name).toBe("改了名");
		expect(patched.connectionId).toBe(onebotA.id);
	});

	it("upsertTarget 同 id 改 connectionId(同平台也算) → 被拒;不改连接只改别的格 → 成功", async () => {
		const target = sessionTarget(onebotA.id);
		await store.upsertTarget(target);
		for (const connectionId of [onebotB.id, qq.id]) {
			await expect(store.upsertTarget({ ...target, connectionId })).rejects.toMatchObject({
				code: "invalid",
				message: expect.stringContaining(REJECT_MESSAGE),
				issues: [expect.objectContaining({ path: ["connectionId"] })],
			});
		}
		await store.upsertTarget({ ...target, name: "改了名" });
		expect(store.getTargets().find((t) => t.id === target.id)?.name).toBe("改了名");
	});

	it("upsertTarget 新 id 挂到任意存在的连接 → 不受守卫管", async () => {
		await store.upsertTarget(sessionTarget(qq.id));
		expect(store.getTargets()).toHaveLength(1);
	});

	it("连接不存在的新连接仍由「连接存在」检查拒", async () => {
		await expect(store.upsertTarget(sessionTarget(randomUUID()))).rejects.toMatchObject({
			issues: [{ path: ["connectionId"], message: "没有这条连接" }],
		});
	});

	it("旧连接已经不在了,改挂也一律拒", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-target-guard-dangling-"));
		try {
			const state = join(dir2, ...CONFIG_DIR);
			await mkdir(state, { recursive: true });
			const dangling = sessionTarget(randomUUID());
			await writeFile(join(state, "connections.json"), JSON.stringify([qq]), "utf8");
			await writeFile(join(state, "targets.json"), JSON.stringify([dangling]), "utf8");
			const store2 = makeStore(dir2);
			await store2.load();
			expect(store2.getTargets()).toHaveLength(1);
			await expect(store2.patchTarget(dangling.id, { connectionId: qq.id })).rejects.toMatchObject({
				message: expect.stringContaining(REJECT_MESSAGE),
				issues: [expect.objectContaining({ path: ["connectionId"] })],
			});
		} finally {
			await rm(dir2, { recursive: true, force: true });
		}
	});
});

describe("ConfigStore:replaceSections 的目标归属统一规矩", () => {
	let dir: string;
	let store: ConfigStore;
	const onebotId = randomUUID();
	const otherOnebotId = randomUUID();
	const qqId = randomUUID();
	const targetId = randomUUID();

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bn-target-guard-replace-"));
		store = makeStore(dir);
		await store.load();
		await store.upsertConnection(onebotConnection(onebotId));
		await store.upsertConnection(onebotConnection(otherOnebotId, "NapCat 2"));
		await store.upsertConnection(qqOfficialConnection(qqId));
		await store.upsertTarget(sessionTarget(onebotId, targetId));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("同 id 的目标换了连接(同平台也算) → 被拒,且一个字节不写", async () => {
		const existing = store.getTargets()[0] as PushTarget;
		for (const connectionId of [otherOnebotId, qqId]) {
			await expect(
				store.replaceSections({ targets: [{ ...existing, connectionId } as PushTarget] }),
			).rejects.toMatchObject({
				code: "invalid",
				message: expect.stringContaining(REJECT_MESSAGE),
			});
		}
		expect(store.getTargets()[0]?.connectionId).toBe(onebotId);
	});

	it("只换连接、有保留目标挂着的连接平台变了 → 被拒,且一个字节不写", async () => {
		const beforeConnections = store.getConnections();
		await expect(
			store.replaceSections({
				connections: [
					qqOfficialConnection(onebotId, "NapCat"),
					onebotConnection(otherOnebotId, "NapCat 2"),
					qqOfficialConnection(qqId),
				],
			}),
		).rejects.toMatchObject({
			code: "invalid",
			message: expect.stringContaining("平台变了"),
		});
		expect(store.getConnections()).toEqual(beforeConnections);
	});

	it("两节一起给也拒:连接平台变了而同 id 目标还挂着", async () => {
		const existing = store.getTargets()[0] as PushTarget;
		await expect(
			store.replaceSections({
				connections: [qqOfficialConnection(onebotId, "换成官机")],
				targets: [existing],
			}),
		).rejects.toMatchObject({
			code: "invalid",
			message: expect.stringContaining("平台变了"),
		});
		expect(store.getConnections()).toHaveLength(3);
	});

	it("只是连接的适配器变了(平台名相同) → 被拒,括号里写适配器", async () => {
		await expect(
			store.replaceSections({
				connections: [
					{
						id: onebotId,
						name: "NapCat",
						enabled: true,
						adapterKey: "bridge",
						platform: "onebot",
						settings: { botId: "onebot:42" },
						platformSnapshot: snapshotFor("onebot"),
					},
					onebotConnection(otherOnebotId, "NapCat 2"),
					qqOfficialConnection(qqId),
				],
			}),
		).rejects.toMatchObject({
			code: "invalid",
			message: expect.stringContaining("onebot → bridge"),
		});
	});

	it("只换连接、平台没变 → 成功", async () => {
		await store.replaceSections({
			connections: [
				onebotConnection(onebotId, "改了名"),
				onebotConnection(otherOnebotId, "NapCat 2"),
				qqOfficialConnection(qqId),
			],
		});
		expect(store.getConnections().find((c) => c.id === onebotId)?.name).toBe("改了名");
	});

	it("替换前没有的新目标不比:挂到平台不同的新连接也行", async () => {
		const fresh = sessionTarget(qqId, randomUUID());
		await store.replaceSections({ targets: [store.getTargets()[0] as PushTarget, fresh] });
		expect(store.getTargets()).toHaveLength(2);
	});

	it("一整套 id 全新的恢复 → 成功", async () => {
		const newConn = qqOfficialConnection(randomUUID(), "全新官机");
		const newTarget = sessionTarget(newConn.id, randomUUID());
		await store.replaceSections({ connections: [newConn], targets: [newTarget] });
		expect(store.getConnections().map((c) => c.platform)).toEqual(["qq-official"]);
		expect(store.getTargets().map((t) => t.id)).toEqual([newTarget.id]);
	});
});

describe("ConfigStore:读盘宽容", () => {
	it("连接不存在的目标照读进来;带着遗留 platform 的目标读进来后没有这一格", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bn-target-load-"));
		try {
			const state = join(dir, ...CONFIG_DIR);
			await mkdir(state, { recursive: true });
			const conn = onebotConnection();
			const orphan = sessionTarget(randomUUID());
			const legacy = { ...sessionTarget(conn.id), platform: "onebot" };
			await writeFile(join(state, "connections.json"), JSON.stringify([conn]), "utf8");
			await writeFile(join(state, "targets.json"), JSON.stringify([orphan, legacy]), "utf8");
			const store = makeStore(dir);
			await store.load();
			const targets = store.getTargets();
			expect(targets.map((t) => t.id)).toEqual([orphan.id, legacy.id]);
			expect(targets[1]).not.toHaveProperty("platform");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
