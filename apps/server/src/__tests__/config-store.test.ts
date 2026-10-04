import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BILIBILI_SOURCE_KEY,
	type BusEvents,
	type ConfigScope,
	type Connection,
	type Disposable,
	deterministicUuid,
	FEATURE_KEYS,
	isDirectConnection,
	type MessageBus,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type PushTarget,
	type ServiceContext,
	type Subscription,
	SubscriptionSchema,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createBackupService } from "../backup/service.js";
import type { BootstrapConfig } from "../config/schema.js";
import {
	CONFIG_DIR,
	CORE_SETTINGS_FILE,
	type ConfigStore,
	ConfigValidationError,
	createConfigStore,
} from "../config/store.js";
import { storageWriteGate } from "./support/storage-write-gate.js";
import { subscriptionsFileText } from "./support/subscriptions-file.js";

// 落盘函数前的闸默认敞开;只有「close 等在途的写」那组用例才 hold(见 support/storage-write-gate.ts)。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("./support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeFakeBus(): MessageBus & { events: Array<[keyof BusEvents, unknown]> } {
	const events: Array<[keyof BusEvents, unknown]> = [];
	const listeners = new Map<keyof BusEvents, Set<(payload?: unknown) => void>>();
	return {
		events,
		emit(event, payload?: unknown) {
			events.push([event, payload]);
			const set = listeners.get(event);
			if (!set) return;
			for (const h of [...set]) h(payload);
		},
		on(event, handler): Disposable {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			const wrapped = (payload?: unknown) => (handler as (payload?: unknown) => void)(payload);
			set.add(wrapped);
			return {
				dispose() {
					listeners.get(event)?.delete(wrapped);
				},
			};
		},
	};
}

function makeFakeServiceCtx(): ServiceContext {
	return {
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: vi.fn(),
		signal: new AbortController().signal,
		track: vi.fn(),
	};
}

function makeBootstrap(dataDir: string): BootstrapConfig {
	return {
		server: { host: "127.0.0.1", port: 8787 },
		dataDir,
		logLevel: "info",
	};
}

function makeSampleSubscription(uid = "12345"): Subscription {
	return makeEmptySubscription({
		id: randomUUID(),
		identity: { sourceKey: "bilibili", externalId: uid },
	});
}

function makeWebhookConnection(
	overrides: Partial<Extract<Connection, { connector: "webhook" }>> = {},
) {
	return {
		id: randomUUID(),
		name: "团队 Webhook",
		platform: "feishu" as const,
		enabled: true,
		kind: "direct" as const,
		connector: "webhook" as const,
		config: { url: "https://example.com/hook", headers: {} },
		...overrides,
	};
}

function makeOnebotConnection(
	overrides: Partial<Extract<Connection, { platform: "onebot" }>> = {},
) {
	return {
		id: randomUUID(),
		name: "NapCat",
		platform: "onebot" as const,
		enabled: true,
		kind: "direct" as const,
		connector: "http" as const,
		config: {
			transport: "http" as const,
			baseUrl: "http://127.0.0.1:3000",
			protocolVersion: "v11" as const,
			headers: {},
			timeoutMs: 15_000,
			imageMinTimeoutMs: 30_000,
			forwardMinTimeoutMs: 60_000,
			retryTimes: 0,
			retryIntervalMs: 1_000,
		},
		...overrides,
	};
}

function makeWebhookTarget(
	connection: Extract<Connection, { connector: "webhook" }>,
	overrides: Partial<Extract<PushTarget, { kind: "endpoint" }>> = {},
) {
	return {
		id: randomUUID(),
		name: "手动 Webhook",
		connectionId: connection.id,
		kind: "endpoint" as const,
		platform: connection.platform,
		scope: "channel" as const,
		enabled: true,
		session: {},
		...overrides,
	};
}

function managedWebhookTargetId(connectionId: string): string {
	return deterministicUuid(`push-target:webhook-adapter:${connectionId}`);
}

/** 假总线上按序收到的 `config-changed` 的 scope。 */
function configScopes(bus: ReturnType<typeof makeFakeBus>): unknown[] {
	return bus.events
		.filter(([e]) => e === "config-changed")
		.map(([, payload]) => (payload as { scope: ConfigScope }).scope);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConfigStore", () => {
	let dataDir: string;
	let stateDir: string;
	let bus: ReturnType<typeof makeFakeBus>;
	let store: ConfigStore;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-config-test-"));
		stateDir = join(dataDir, ...CONFIG_DIR);
		bus = makeFakeBus();
		store = createConfigStore({
			bootstrap: makeBootstrap(dataDir),
			dataRoot: dataDir,
			bus,
			serviceCtx: makeFakeServiceCtx(),
		});
		await store.load();
		// reset events captured during seed-on-load (load itself does not emit)
		bus.events.length = 0;
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("seeds default JSON files on first boot", async () => {
		const globalsRaw = await readFile(join(dataDir, ...CORE_SETTINGS_FILE), "utf8");
		const subsRaw = await readFile(join(stateDir, "subscriptions.json"), "utf8");
		const tgtsRaw = await readFile(join(stateDir, "targets.json"), "utf8");
		expect(JSON.parse(globalsRaw)).toEqual(makeDefaultGlobalConfig());
		expect(JSON.parse(subsRaw)).toEqual({ tags: [], subscriptions: [] });
		expect(JSON.parse(tgtsRaw)).toEqual([]);
		expect(store.getGlobals()).toEqual(makeDefaultGlobalConfig());
	});

	it("getGlobals/getSubscriptions/getTargets return cloned snapshots", () => {
		const a = store.getGlobals();
		a.app.fansCron = "tampered";
		const b = store.getGlobals();
		expect(b.app.fansCron).not.toBe("tampered");

		const subs = store.getSubscriptions();
		subs.push(makeSampleSubscription());
		expect(store.getSubscriptions()).toHaveLength(0);
	});

	it("SY1: patchGlobals 收到 null 清除可选字段;undefined 仍是“不改”", async () => {
		// targetId 规范是 z.uuid().optional(),须用结构合法的 UUID(版本/变体
		// nibble 正确),用 crypto.randomUUID() 生成 v4。
		const T1 = randomUUID();
		const T2 = randomUUID();
		await store.patchGlobals({
			master: { targetId: T1 },
			app: { logLevels: { core: "debug" } },
		});
		expect(store.getGlobals().master.targetId).toBe(T1);
		expect(store.getGlobals().app.logLevels?.core).toBe("debug");

		// null = 显式清除
		await store.patchGlobals({
			master: { targetId: null },
			app: { logLevels: { core: null } },
		} as never);
		expect(store.getGlobals().master.targetId).toBeUndefined();
		expect(store.getGlobals().app.logLevels?.core).toBeUndefined();

		// undefined / 不带该键 ≠ 清除:重配后再发不含 master 的 patch,值保留
		await store.patchGlobals({ master: { targetId: T2 } });
		await store.patchGlobals({ app: { fansCron: "*/9 * * * *" } });
		expect(store.getGlobals().master.targetId).toBe(T2);
	});

	it("SY1: null 清除深至嵌套标量 —— 关掉玻璃片透明度真的能存下去", async () => {
		await store.patchGlobals({ defaults: { cardStyle: { glassOpacity: 0.82 } } });
		expect(store.getGlobals().defaults.cardStyle.glassOpacity).toBe(0.82);

		// 面板把「关掉」表达成 glassOpacity: null(见 web services/api.ts SY1 —— 线上
		// 发 undefined 会被 JSON.stringify 丢键,deepMerge 当「不改」→ 存不掉)。
		await store.patchGlobals({ defaults: { cardStyle: { glassOpacity: null } } } as never);
		expect(store.getGlobals().defaults.cardStyle.glassOpacity).toBeUndefined();
	});

	it("消息版式:patchGlobals 持久化的自定义版式在冷重启(新 ConfigStore 读同一 dataDir)后仍生效", async () => {
		const customLive = {
			blocks: [
				{ id: "text", type: "text", visible: true },
				{ id: "card", type: "card", visible: true },
				{ id: "link", type: "link", visible: false },
			],
			separator: " | ",
		};
		await store.patchGlobals({
			defaults: { messageLayout: { live: customLive } },
		} as never);
		expect(store.getGlobals().defaults.messageLayout.live).toEqual(customLive);

		// 冷重启:另开一个 ConfigStore 指向同一 dataDir,模拟进程重启后的 load()。
		const bus2 = makeFakeBus();
		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dataDir),
			dataRoot: dataDir,
			bus: bus2,
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();
		expect(store2.getGlobals().defaults.messageLayout.live).toEqual(customLive);
	});

	/**
	 * 换人格只改一个指针字符串,是最容易被中间某层吃掉的那种改动 —— 而症状恰好
	 * 就是主人报的「怎么选都切不过去」。这里把整条落盘链钉住:合并 → schema
	 * (指针必须原样认下,不能有哪一层按 `ai.persona` 的内容把选择拨回去)→ 落盘 →
	 * 冷重启再读。
	 */
	it("换全局人格:activePreset 存得住,冷重启后不被 ai.persona 拨回去", async () => {
		// 默认配置的 persona 就是「温柔女仆」那份,指针也指着它 —— 换成傲娇毒舌之后,
		// persona 与指针刻意不一致,正是「按内容匹配指针」最容易判错的形状。
		expect(store.getGlobals().defaults.ai.activePreset).toBe("gentle-maid");

		const next = await store.patchGlobals({ defaults: { ai: { activePreset: "tsundere" } } });
		expect(next.defaults.ai.activePreset).toBe("tsundere");
		// 指针不改写 persona —— 主人手写的那份原封不动。
		expect(next.defaults.ai.persona.name).toBe("小绫");

		const bus2 = makeFakeBus();
		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dataDir),
			dataRoot: dataDir,
			bus: bus2,
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();
		expect(store2.getGlobals().defaults.ai.activePreset).toBe("tsundere");
	});

	it("setGlobals rejects malformed input with ConfigValidationError", async () => {
		const bad = { ...store.getGlobals(), app: { fansCron: 123 as unknown as string } };
		await expect(store.setGlobals(bad as never)).rejects.toBeInstanceOf(ConfigValidationError);
	});

	it("patchGlobals rejects malformed input with ConfigValidationError and does not mutate", async () => {
		const before = store.getGlobals();
		await expect(
			store.patchGlobals({ app: { fansCron: 42 as unknown as string } }),
		).rejects.toBeInstanceOf(ConfigValidationError);
		expect(store.getGlobals()).toEqual(before);
	});

	it("patchGlobals atomic write: persisted file matches getGlobals() immediately", async () => {
		const next = await store.patchGlobals({ app: { fansCron: "*/5 * * * *" } });
		expect(next.app.fansCron).toBe("*/5 * * * *");
		expect(store.getGlobals().app.fansCron).toBe("*/5 * * * *");
		const onDisk = JSON.parse(await readFile(join(dataDir, ...CORE_SETTINGS_FILE), "utf8"));
		expect(onDisk).toEqual(next);
	});

	it("concurrent patchGlobals calls serialize and converge to a consistent state", async () => {
		await Promise.all([
			store.patchGlobals({ app: { fansCron: "*/3 * * * *" } }),
			store.patchGlobals({ history: { retentionDays: 60 } }),
			store.patchGlobals({ master: { targetId: undefined } }),
		]);
		const final = store.getGlobals();
		expect(final.app.fansCron).toBe("*/3 * * * *");
		expect(final.history.retentionDays).toBe(60);
		// On-disk matches in-memory
		const onDisk = JSON.parse(await readFile(join(dataDir, ...CORE_SETTINGS_FILE), "utf8"));
		expect(onDisk).toEqual(final);
		// All three writes emitted exactly one 'config-changed' for globals
		const globalEvents = configScopes(bus).filter((scope) => scope === "globals");
		expect(globalEvents).toHaveLength(3);
	});

	it("upsertSubscription adds a new entry; same id updates in place; deleteSubscription removes", async () => {
		const sub = makeSampleSubscription("11111");
		await store.upsertSubscription(sub);
		expect(store.getSubscriptions()).toHaveLength(1);
		const stored = store.getSubscriptions()[0];
		expect(stored && subscriptionIdentityOf(stored)).toEqual({
			sourceKey: BILIBILI_SOURCE_KEY,
			externalId: "11111",
		});

		// Update the same id (the identity cannot change, but we can flip enabled / notes)
		const updated: Subscription = { ...sub, enabled: false, notes: "paused" };
		await store.upsertSubscription(updated);
		expect(store.getSubscriptions()).toHaveLength(1);
		expect(store.getSubscriptions()[0]?.enabled).toBe(false);
		expect(store.getSubscriptions()[0]?.notes).toBe("paused");

		// Delete
		const removed = await store.deleteSubscription(sub.id);
		expect(removed).toBe(true);
		expect(store.getSubscriptions()).toHaveLength(0);

		// Deleting unknown id returns false and does NOT emit
		const beforeEvents = bus.events.length;
		const removedAgain = await store.deleteSubscription(sub.id);
		expect(removedAgain).toBe(false);
		expect(bus.events.length).toBe(beforeEvents);
	});

	it("SY1: patchSubscription 收到 overrides slice = null 时清除整段;缺键仍是“不改”", async () => {
		// 回归:dashboard 关闭某 per-UP 覆盖框后保存不生效。前端 buildOverridesPatch 对被关闭
		// 的 slice 下发显式 null,store 必须真正删除该 slice,否则旧值残留 → 灵动岛 diff 不归零。
		const sub = makeSampleSubscription("99999");
		await store.upsertSubscription(sub);
		await store.patchSubscription(sub.id, {
			overrides: { imageGroup: { enable: true, forward: true }, filters: { minScPrice: 30 } },
		});
		expect(store.getSubscriptions()[0]?.overrides.imageGroup).toEqual({
			enable: true,
			forward: true,
		});

		// null = 显式清除 imageGroup;同一 patch 里不带 filters 键 → filters 保留(“不改”)。
		await store.patchSubscription(sub.id, {
			overrides: { imageGroup: null },
		} as never);
		const after = store.getSubscriptions()[0];
		expect(after?.overrides.imageGroup).toBeUndefined();
		// filters slice 不被 null patch 波及,先前写入的 minScPrice 仍在。
		expect(after?.overrides.filters?.minScPrice).toBe(30);
	});

	it("patch 仅直播阈值域(minScPrice/minGuardLevel)不得污染过滤域字段(blockDraw/blockAv)", async () => {
		// 回归:overrides.filters 被「动态过滤」与「直播阈值」两个 section 分域共写。
		// ContentFiltersPartialSchema = ContentFiltersSchema.partial(),但 blockDraw /
		// blockAv 带 .default(false),partial 不剥默认值 → 只存阈值域也会被 zod 塞进
		// blockDraw:false / blockAv:false。前端据 `字段 !== undefined` 判「动态过滤已覆盖」
		// → toggle / 侧栏小点被动亮起(dashboard「打开直播阈值连带打开动态过滤」)。
		const sub = makeSampleSubscription("31415");
		await store.upsertSubscription(sub);
		await store.patchSubscription(sub.id, {
			overrides: { filters: { minScPrice: 50, minGuardLevel: 2 } },
		});
		const f = store.getSubscriptions()[0]?.overrides.filters;
		expect(f?.minScPrice).toBe(50);
		expect(f?.minGuardLevel).toBe(2);
		// 过滤域字段一个都不该出现(包括带 default 的 blockDraw / blockAv)。
		expect(f && "blockDraw" in f).toBe(false);
		expect(f && "blockAv" in f).toBe(false);
		expect(f && "blockKeywords" in f).toBe(false);
		expect(Object.keys(f ?? {}).sort()).toEqual(["minGuardLevel", "minScPrice"]);
	});

	it("upsertSubscription validates: malformed sub throws, file unchanged", async () => {
		const broken = {
			...makeSampleSubscription(),
			identity: { sourceKey: "bilibili", externalId: "" },
		};
		await expect(store.upsertSubscription(broken as never)).rejects.toBeInstanceOf(
			ConfigValidationError,
		);
		const onDisk = JSON.parse(await readFile(join(stateDir, "subscriptions.json"), "utf8"));
		expect(onDisk).toEqual({ tags: [], subscriptions: [] });
	});

	it("emits 'config-changed' exactly once per successful write with correct scope", async () => {
		const captured: ConfigScope[] = [];
		const sub = bus.on("config-changed", ({ scope }) => {
			captured.push(scope);
		});

		await store.patchGlobals({ app: { fansCron: "*/4 * * * *" } });
		await store.upsertSubscription(makeSampleSubscription("22222"));

		// Failures must NOT emit
		await store.patchGlobals({ app: { fansCron: 9 as unknown as string } }).catch(() => {});

		expect(captured).toEqual(["globals", "subscriptions"]);
		sub.dispose();
	});

	it("targets CRUD: upsert / patch / delete with proper events", async () => {
		const connection = makeOnebotConnection();
		await store.upsertConnection(connection);
		const target = {
			id: randomUUID(),
			name: "t1",
			connectionId: connection.id,
			kind: "session" as const,
			platform: "onebot" as const,
			scope: "group" as const,
			enabled: true,
			address: "10001",
		};
		await store.upsertTarget(target);
		expect(store.getTargets()).toHaveLength(1);
		const events1 = configScopes(bus).filter((scope) => scope === "targets");
		expect(events1).toHaveLength(1);

		const removed = await store.deleteTarget(target.id);
		expect(removed).toBe(true);
		expect(store.getTargets()).toHaveLength(0);
	});

	it("deleteTarget 级联清理订阅 routing / extraTargets 并保持 schema 自洽", async () => {
		const connection = makeOnebotConnection();
		await store.upsertConnection(connection);
		const target = {
			id: randomUUID(),
			name: "群聊",
			connectionId: connection.id,
			kind: "session" as const,
			platform: "onebot" as const,
			scope: "group" as const,
			enabled: true,
			address: "10001",
		};
		const keptTarget = {
			id: randomUUID(),
			name: "私聊",
			connectionId: connection.id,
			kind: "session" as const,
			platform: "onebot" as const,
			scope: "private" as const,
			enabled: true,
			address: "20002",
		};
		await store.upsertTarget(target);
		await store.upsertTarget(keptTarget);
		const sub = makeSampleSubscription("77777");
		for (const k of FEATURE_KEYS) sub.routing[k] = [target.id, keptTarget.id];
		sub.extraTargets.atAllPost[target.id] = true;
		sub.extraTargets.atAllPost[keptTarget.id] = false;
		sub.extraTargets.atAllLiveStart[target.id] = false;
		sub.extraTargets.atAllLiveStart[keptTarget.id] = true;
		await store.upsertSubscription(sub);
		bus.events.length = 0;

		await expect(store.deleteTarget(target.id)).resolves.toBe(true);

		expect(store.getTargets().map((t) => t.id)).toEqual([keptTarget.id]);
		const nextSub = store.getSubscriptions()[0];
		expect(nextSub).toBeDefined();
		for (const k of FEATURE_KEYS) {
			expect(nextSub?.routing[k]).not.toContain(target.id);
			expect(nextSub?.routing[k]).toContain(keptTarget.id);
		}
		expect(nextSub?.extraTargets.atAllPost).toEqual({ [keptTarget.id]: false });
		expect(nextSub?.extraTargets.atAllLiveStart).toEqual({ [keptTarget.id]: true });
		expect(SubscriptionSchema.safeParse(nextSub).success).toBe(true);
		const scopes = configScopes(bus);
		expect(scopes).toEqual(["targets", "subscriptions"]);
	});

	it("upsertConnection(webhook) 自动创建系统托管 target", async () => {
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);

		const targets = store.getTargets();
		expect(targets).toHaveLength(1);
		expect(targets[0]).toMatchObject({
			id: managedWebhookTargetId(connection.id),
			name: connection.name,
			connectionId: connection.id,
			kind: "endpoint",
			// 托管目标的平台跟着连接走。
			platform: connection.platform,
			scope: "channel",
			enabled: true,
			managedBy: "connection",
		});
		const scopes = configScopes(bus);
		expect(scopes).toEqual(["connections", "targets"]);
	});

	it("connections.json 与 targets.json 都没有 = 全新安装,建空的两份", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-fresh-"));
		const state2 = join(dir2, ...CONFIG_DIR);
		await mkdir(state2, { recursive: true });

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			dataRoot: dir2,
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();

		expect(store2.getConnections()).toEqual([]);
		expect(JSON.parse(await readFile(join(state2, "connections.json"), "utf8"))).toEqual([]);
		await expect(readFile(join(state2, "adapters.json"), "utf8")).rejects.toThrow();
		await rm(dir2, { recursive: true, force: true });
	});

	it("load() 回填缺失的 webhook 托管 target", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-managed-empty-"));
		const state2 = join(dir2, ...CONFIG_DIR);
		await mkdir(state2, { recursive: true });
		const connection = makeWebhookConnection();
		await writeFile(join(state2, "connections.json"), JSON.stringify([connection]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			dataRoot: dir2,
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();
		expect(store2.getTargets()).toEqual([
			expect.objectContaining({
				id: managedWebhookTargetId(connection.id),
				connectionId: connection.id,
				managedBy: "connection",
			}),
		]);
		await rm(dir2, { recursive: true, force: true });
	});

	it("load() 标记既有 webhook target 且保留 id", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-managed-existing-"));
		const state2 = join(dir2, ...CONFIG_DIR);
		await mkdir(state2, { recursive: true });
		const connection = makeWebhookConnection();
		const target = makeWebhookTarget(connection, { id: randomUUID(), name: "旧 Webhook" });
		const sub = makeSampleSubscription("44444");
		sub.routing.post = [target.id];
		await writeFile(join(state2, "connections.json"), JSON.stringify([connection]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([target]), "utf8");
		await writeFile(join(state2, "subscriptions.json"), subscriptionsFileText([sub]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			dataRoot: dir2,
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();
		const managed = store2.getTargets()[0];
		expect(managed).toMatchObject({
			id: target.id,
			name: connection.name,
			connectionId: connection.id,
			managedBy: "connection",
			scope: "channel",
		});
		expect(store2.getSubscriptions()[0]?.routing.post).toEqual([target.id]);
		await rm(dir2, { recursive: true, force: true });
	});

	it("patchConnection(webhook) 同步托管 target 名称与启用状态", async () => {
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);
		const patched = await store.patchConnection(connection.id, {
			name: "飞书 Webhook",
			enabled: false,
		});
		expect(patched.name).toBe("飞书 Webhook");

		const target = store.getTargets()[0];
		expect(target).toMatchObject({
			id: managedWebhookTargetId(connection.id),
			name: "飞书 Webhook",
			enabled: false,
			managedBy: "connection",
		});
	});

	it("patchConnection / upsertConnection 拒绝变更既有 adapter platform", async () => {
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);
		const onebot = makeOnebotConnection({ id: connection.id, name: connection.name });

		await expect(
			store.patchConnection(connection.id, { platform: "onebot", config: onebot.config } as never),
		).rejects.toBeInstanceOf(ConfigValidationError);
		await expect(store.upsertConnection(onebot)).rejects.toBeInstanceOf(ConfigValidationError);
		const kept = store.getConnections()[0];
		expect(kept && isDirectConnection(kept) && kept.platform).toBe(connection.platform);
		expect(store.getTargets()).toHaveLength(1);
	});

	it("deleteConnection(webhook) 级联删除托管 target 并清理订阅 routing / extraTargets", async () => {
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);
		const targetId = store.getTargets()[0]?.id;
		expect(targetId).toBeDefined();
		const sub = makeSampleSubscription("55555");
		sub.routing.post = [targetId as string];
		sub.routing.liveStart = [targetId as string];
		sub.extraTargets.atAllPost[targetId as string] = true;
		sub.extraTargets.atAllLiveStart[targetId as string] = true;
		await store.upsertSubscription(sub);
		bus.events.length = 0;

		await expect(store.deleteConnection(connection.id)).resolves.toBe(true);
		expect(store.getConnections()).toHaveLength(0);
		expect(store.getTargets()).toHaveLength(0);
		const nextSub = store.getSubscriptions()[0];
		expect(nextSub?.routing.post).toEqual([]);
		expect(nextSub?.routing.liveStart).toEqual([]);
		expect(nextSub?.extraTargets.atAllPost).toEqual({});
		expect(nextSub?.extraTargets.atAllLiveStart).toEqual({});
		const scopes = configScopes(bus);
		expect(scopes).toEqual(["connections", "targets", "subscriptions"]);
	});

	// 目标的平台开放之后,「挂在 onebot 连接下、平台写着 telegram」这种目标**schema 收得下**
	// —— 从前是闭集,它连 parse 都过不去。挡住它的只剩 store 里那条不变式,而那条不变式
	// 在这两条路上各写了一份(逐条 upsert / 整体 replaceSections),原先一条测试都没有:
	// 整个删掉,全仓 5986 个测试照样绿。
	it("upsertTarget 拒绝平台与连接对不上的目标", async () => {
		const connection = makeOnebotConnection();
		await store.upsertConnection(connection);
		await expect(
			store.upsertTarget({
				id: randomUUID(),
				name: "冒充的",
				connectionId: connection.id,
				kind: "session",
				platform: "telegram",
				scope: "group",
				enabled: true,
				address: "1",
			}),
		).rejects.toBeInstanceOf(ConfigValidationError);
		expect(store.getTargets()).toHaveLength(0);
	});

	it("replaceSections 也拒绝 —— 恢复备份走的是这一条,不能只挡住手工那条", async () => {
		const connection = makeOnebotConnection();
		await store.upsertConnection(connection);
		await expect(
			store.replaceSections({
				connections: [connection],
				targets: [
					{
						id: randomUUID(),
						name: "冒充的",
						connectionId: connection.id,
						kind: "session",
						platform: "telegram",
						scope: "group",
						enabled: true,
						address: "1",
					} as PushTarget,
				],
			}),
		).rejects.toBeInstanceOf(ConfigValidationError);
		expect(store.getTargets()).toHaveLength(0);
	});

	it("deleteConnection(onebot) 仍在被 target 引用时拒绝", async () => {
		const connection = makeOnebotConnection();
		await store.upsertConnection(connection);
		await store.upsertTarget({
			id: randomUUID(),
			name: "群聊",
			connectionId: connection.id,
			kind: "session",
			platform: "onebot",
			scope: "group",
			enabled: true,
			address: "10001",
		});

		// 「还被用着」是与当前状态冲突(conflict),话里说清该怎么办。
		await expect(store.deleteConnection(connection.id)).rejects.toMatchObject({
			name: "ConfigValidationError",
			code: "conflict",
			message: expect.stringContaining("先解除引用"),
		});
		expect(store.getConnections()).toHaveLength(1);
		expect(store.getTargets()).toHaveLength(1);
	});

	it("改 / 补丁一条不存在的订阅、连接、推送目标 → not_found,话里点名是哪一种", async () => {
		const ghost = randomUUID();
		await expect(store.patchSubscription(ghost, { enabled: false })).rejects.toMatchObject({
			name: "ConfigValidationError",
			code: "not_found",
			scope: "subscriptions",
			message: expect.stringContaining("订阅"),
		});
		await expect(store.patchConnection(ghost, { name: "x" })).rejects.toMatchObject({
			code: "not_found",
			scope: "connections",
			message: expect.stringContaining("连接"),
		});
		await expect(store.patchTarget(ghost, { name: "x" })).rejects.toMatchObject({
			code: "not_found",
			scope: "targets",
			message: expect.stringContaining("推送目标"),
		});
		await expect(store.recordTargetTestStatus(ghost, undefined)).rejects.toMatchObject({
			code: "not_found",
		});
	});

	it("目标挂着不存在的连接 / 平台和连接对不上 → invalid,issues 点名那一格", async () => {
		const connection = makeOnebotConnection();
		await store.upsertConnection(connection);
		const target = {
			id: randomUUID(),
			name: "群聊",
			connectionId: connection.id,
			kind: "session" as const,
			platform: "onebot" as const,
			scope: "group" as const,
			enabled: true,
			address: "10001",
		};
		await expect(
			store.upsertTarget({ ...target, connectionId: randomUUID() } as PushTarget),
		).rejects.toMatchObject({
			code: "invalid",
			scope: "targets",
			issues: [{ path: ["connectionId"], message: "没有这条连接" }],
		});
		await expect(
			store.upsertTarget({ ...target, platform: "telegram" } as PushTarget),
		).rejects.toMatchObject({
			code: "invalid",
			issues: [{ path: ["platform"], message: "要和连接的平台一致" }],
		});
	});

	it("schema 校验不过 → invalid,逐格原因进 issues,顶上一句中文", async () => {
		await expect(
			store.patchGlobals({ app: { fansCron: 42 as unknown as string } }),
		).rejects.toMatchObject({
			name: "ConfigValidationError",
			code: "invalid",
			scope: "globals",
			message: expect.stringMatching(/^全局设置有 \d+ 格不合法：app\.fansCron：/),
			issues: [expect.objectContaining({ path: ["app", "fansCron"] })],
		});
	});

	it("deleteTarget(managed) 拒绝直接删除托管 target", async () => {
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);
		const targetId = store.getTargets()[0]?.id;
		expect(targetId).toBeDefined();

		await expect(store.deleteTarget(targetId as string)).rejects.toMatchObject({
			name: "ConfigValidationError",
			code: "conflict",
		});
		expect(store.getTargets()).toHaveLength(1);
	});

	it("upsertTarget(webhook) 拒绝外部手动创建 webhook target", async () => {
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);
		const manual = makeWebhookTarget(connection, { id: randomUUID(), name: "额外 Webhook" });

		await expect(store.upsertTarget(manual)).rejects.toMatchObject({
			name: "ConfigValidationError",
			code: "invalid",
		});
		expect(store.getTargets()).toHaveLength(1);
	});

	it("备份往返:getTargets() 吐得出来的,upsertTarget() 就必须吃得下", async () => {
		// 备份导出走 getTargets()(必然含托管 target),恢复走 upsertTarget() —— 两头对不上
		// 的话,**任何含 webhook 连接的备份都恢复不了**。而恢复是逐条 await、没有事务也
		// 没有回滚的:炸在 targets 这步时 globals / 订阅 / adapters 已经落盘,配置变成半新
		// 半旧,订阅里还引用着从未创建的 target id,而原状态已被覆盖。
		//
		// 托管 target 的 id 不能靠「导出时丢掉、恢复时重建」绕过去:makeManagedWebhookTarget
		// 取的是 `existing?.id ?? 确定性id`,老记录会永远保留自己那个非确定性 id,重建就换了
		// 身份,订阅 routing 当场断。
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);
		const managed = store.getTargets().find((t) => t.managedBy === "connection");
		expect(managed).toBeDefined();

		await expect(store.upsertTarget(managed as PushTarget)).resolves.toBeUndefined();
		expect(store.getTargets()).toHaveLength(1);
		expect(store.getTargets()[0]?.id).toBe(managed?.id);
	});

	it("备份往返:恢复回来的老 id 与当前托管 target 并存 → 合并,订阅引用迁过去", async () => {
		// 恢复的顺序是 订阅 → adapters → targets:adapter 一落盘就先生成了确定性 id 的托管
		// target,随后送回来的那条却带着备份里的**老 id**(老记录会一直保留自己的 id)。两条
		// 同主并存时必须合并成一条,并把订阅里的老 id 改写过去 —— 否则用户恢复完会看到两个
		// 一模一样的 webhook 目标,而订阅指着那个被吞掉的。
		const connection = makeWebhookConnection();
		const legacyId = randomUUID();
		const sub = makeSampleSubscription("77777");
		sub.routing.post = [legacyId];
		sub.extraTargets.atAllPost[legacyId] = true;
		await store.upsertSubscription(sub);
		await store.upsertConnection(connection);

		const managedId = store.getTargets()[0]?.id;
		expect(managedId).toBe(managedWebhookTargetId(connection.id));

		await store.upsertTarget(
			makeWebhookTarget(connection, { id: legacyId, managedBy: "connection" }) as PushTarget,
		);

		expect(store.getTargets()).toHaveLength(1);
		expect(store.getTargets()[0]?.id).toBe(managedId);
		const nextSub = store.getSubscriptions().find((s) => s.id === sub.id);
		expect(nextSub?.routing.post).toEqual([managedId]);
		expect(nextSub?.extraTargets.atAllPost).toEqual({ [managedId as string]: true });
	});

	it("patchTarget(managed) 拒绝外部修改，recordTargetTestStatus 允许内部状态写回", async () => {
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);
		const target = store.getTargets()[0];
		expect(target).toBeDefined();

		await expect(
			store.patchTarget(target?.id as string, { name: "用户改名" }),
		).rejects.toMatchObject({ name: "ConfigValidationError", code: "conflict" });
		await expect(
			store.patchTarget(target?.id as string, {
				testStatus: { ok: true, lastCheckedAt: "2026-06-06T00:00:00.000Z", latencyMs: 12 },
			}),
		).rejects.toMatchObject({ name: "ConfigValidationError", code: "conflict" });
		const patched = await store.recordTargetTestStatus(target?.id as string, {
			ok: true,
			lastCheckedAt: "2026-06-06T00:00:00.000Z",
			latencyMs: 12,
		});
		expect(patched.testStatus).toMatchObject({ ok: true, latencyMs: 12 });
	});

	it("端到端:含 webhook 连接的备份,导出后能在一台干净机器上恢复回来", async () => {
		// 这条住在这里,是因为真 ConfigStore 的夹具只有这个文件有 —— 而 backup-service
		// 那边用的是替身,替身把 upsertTarget 打成空函数,正是它把这个 bug 整个盖住了。
		// 源机器刻意造成「老装机」:托管 target 带的是**非确定性 id**(makeManagedWebhookTarget
		// 取 `existing?.id ?? 确定性id`,老记录会一直保留自己的)。这一步是承重的 —— 否则
		// 「把备份里的 target 恢复回来」和「照 adapter 重新生成一个」会得到同一个 id,测试
		// 分不出这两件事,也就钉不住任何东西。
		const connection = makeWebhookConnection();
		const legacyId = randomUUID();
		const sub = makeSampleSubscription("22222");
		sub.routing.post = [legacyId];
		const dirA = await mkdtemp(join(tmpdir(), "bn-config-backup-src-"));
		const stateA = join(dirA, ...CONFIG_DIR);
		await mkdir(stateA, { recursive: true });
		await writeFile(join(stateA, "connections.json"), JSON.stringify([connection]), "utf8");
		await writeFile(
			join(stateA, "targets.json"),
			JSON.stringify([makeWebhookTarget(connection, { id: legacyId, managedBy: "connection" })]),
			"utf8",
		);
		await writeFile(join(stateA, "subscriptions.json"), subscriptionsFileText([sub]), "utf8");
		const source = createConfigStore({
			bootstrap: makeBootstrap(dirA),
			dataRoot: dirA,
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await source.load();
		const managedId = source.getTargets()[0]?.id;
		expect(managedId).toBe(legacyId);
		expect(managedId).not.toBe(managedWebhookTargetId(connection.id));

		const noCookies = { load: async () => null, save: async () => {} };
		const env = await createBackupService({
			configStore: source,
			cookieStore: noCookies,
		}).exportBackup({ kind: "sanitized" });
		// 导出必然带着托管 target —— 正是老写法恢复不回去的那一条
		expect(env.sections.targets?.some((t) => t.managedBy === "connection")).toBe(true);

		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-restore-"));
		const fresh = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			dataRoot: dir2,
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await fresh.load();
		await createBackupService({ configStore: fresh, cookieStore: noCookies }).importBackup({
			envelope: env,
			mode: "overwrite",
		});

		expect(fresh.getConnections()).toHaveLength(1);
		expect(fresh.getTargets()).toHaveLength(1);
		// 恢复回来的是**备份里那一条**,不是照 adapter 重新生成的 —— 订阅还指着这个 id
		expect(fresh.getTargets()[0]?.id).toBe(legacyId);
		expect(fresh.getSubscriptions()[0]?.routing.post).toEqual([legacyId]);
		await rm(dir2, { recursive: true, force: true });
		await rm(dirA, { recursive: true, force: true });
	});

	/**
	 * 🔴 只勾了 targets 那一段导出的老备份:v1 的 `platform: "webhook"` 得跟着**它那条
	 * 连接**降格成飞书 / 钉钉,而连接不在这份备份里 —— 迁移那一步于是查不到表,整份目标
	 * 落成 `generic`,落地时被 `assertTargetOwner` 判「平台对不上」**整份拒掉**
	 * (`syncManagedWebhookTargets` 救不回来:它排在那道校验之后)。
	 *
	 * 备份没有的那一段,拿**现在盘上那份**补位。
	 */
	/**
	 * 🔴 **拓展连接的 platform 同样是身份轴。**
	 *
	 * 「一条连接 = 一个借来的 bot」(ADR-0012 决策 45)之后,拓展连接**有** `platform`,
	 * 目标的平台正是从它抄的。而两道校验(改连接时的身份轴、目标↔连接的平台一致)都还停在
	 * 「桥接入没有 platform」那一版,对拓展连接一律早退 —— 于是把一条桥连接从 QQ bot 换成
	 * telegram bot 能保存成功,底下的 QQ 群目标平台原地不动,投递却跑去了 telegram。
	 */
	const bridgeConnection = (platform: string) => ({
		id: "11111111-1111-4111-8111-111111111111",
		name: "阿库娅",
		enabled: true,
		kind: "extension" as const,
		extensionId: "bridge",
		platform,
		config: { botId: `${platform}:42` },
	});

	it("拓展连接也不许换 platform —— 底下的目标还挂在原来那个平台上", async () => {
		await store.upsertConnection(bridgeConnection("onebot") as never);
		await expect(
			store.upsertConnection(bridgeConnection("telegram") as never),
		).rejects.toMatchObject({
			name: "ConfigValidationError",
			code: "invalid",
			issues: [{ path: ["platform"], message: "身份格不许改" }],
		});
		expect(store.getConnections()[0]?.platform).toBe("onebot");
	});

	it("拓展连接底下的目标平台必须和它一致", async () => {
		const connection = bridgeConnection("telegram");
		await store.upsertConnection(connection as never);
		await expect(
			store.upsertTarget({
				id: randomUUID(),
				name: "对不上的群",
				connectionId: connection.id,
				kind: "session",
				platform: "onebot",
				scope: "group",
				enabled: true,
				address: "123",
			} as never),
		).rejects.toBeInstanceOf(ConfigValidationError);
	});

	it("replaceSections:任一分区校验不过 → 一个字节都不写", async () => {
		// 这是这个方法存在的理由。老写法逐条 upsert,炸在 targets 那步时 globals / 订阅 /
		// adapters 已经落盘,配置只剩半新半旧且原状态已被覆盖。
		const connection = makeOnebotConnection();
		await store.upsertConnection(connection);
		await store.upsertSubscription(makeSampleSubscription("88888"));
		const before = {
			subs: store.getSubscriptions(),
			connections: store.getConnections(),
			targets: store.getTargets(),
			cron: store.getGlobals().app.fansCron,
		};

		await expect(
			store.replaceSections({
				globals: {
					...store.getGlobals(),
					app: { ...store.getGlobals().app, fansCron: "*/9 * * * *" },
				},
				subscriptions: [],
				connections: [connection],
				// scope 不在词表里 → schema 当场拒绝
				targets: [
					{
						id: randomUUID(),
						name: "坏目标",
						connectionId: connection.id,
						platform: "onebot",
						scope: "nope",
						enabled: true,
						session: { groupId: "1" },
					} as unknown as PushTarget,
				],
			}),
		).rejects.toBeInstanceOf(ConfigValidationError);

		expect(store.getSubscriptions()).toEqual(before.subs);
		expect(store.getConnections()).toEqual(before.connections);
		expect(store.getTargets()).toEqual(before.targets);
		expect(store.getGlobals().app.fansCron).toBe(before.cron);
	});

	it("replaceSections:target 指向不存在的 adapter → 拒绝,且不写", async () => {
		const connection = makeOnebotConnection();
		await store.upsertConnection(connection);
		const before = store.getConnections();

		await expect(
			store.replaceSections({
				connections: [connection],
				targets: [
					{
						id: randomUUID(),
						name: "孤儿目标",
						connectionId: randomUUID(),
						kind: "session",
						platform: "onebot",
						scope: "group",
						enabled: true,
						address: "1",
					} as PushTarget,
				],
			}),
		).rejects.toBeInstanceOf(ConfigValidationError);
		expect(store.getTargets()).toHaveLength(0);
		expect(store.getConnections()).toEqual(before);
	});

	it("replaceSections:缺席的分区保持不动,给空数组才是真清空", async () => {
		const connection = makeOnebotConnection();
		await store.upsertConnection(connection);
		await store.upsertSubscription(makeSampleSubscription("99999"));

		// 只给 targets:订阅与 adapters 不该被碰
		await store.replaceSections({ targets: [] });
		expect(store.getSubscriptions()).toHaveLength(1);
		expect(store.getConnections()).toHaveLength(1);

		// 给空数组 → 真清空
		await store.replaceSections({ subscriptions: [] });
		expect(store.getSubscriptions()).toHaveLength(0);
	});

	it("replaceSections:webhook 托管目标照样归一化,订阅引用跟着迁", async () => {
		const connection = makeWebhookConnection();
		const legacyId = randomUUID();
		const sub = makeSampleSubscription("11111");
		sub.routing.liveStart = [legacyId];
		await store.upsertSubscription(sub);

		await store.replaceSections({
			connections: [connection],
			targets: [
				makeWebhookTarget(connection, { id: legacyId, managedBy: "connection" }) as PushTarget,
			],
		});

		expect(store.getTargets()).toHaveLength(1);
		// 只有一条时它就是留下的那条 —— 老 id 保住,不会被换成确定性 id
		expect(store.getTargets()[0]?.id).toBe(legacyId);
		expect(store.getTargets()[0]?.managedBy).toBe("connection");
		expect(store.getSubscriptions()[0]?.routing.liveStart).toEqual([legacyId]);
	});

	it("load() 合并同一 webhook adapter 下多余 targets 并把订阅引用迁到托管 id", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-managed-duplicates-"));
		const state2 = join(dir2, ...CONFIG_DIR);
		await mkdir(state2, { recursive: true });
		const connection = makeWebhookConnection();
		const primary = makeWebhookTarget(connection, { id: randomUUID(), name: "主 Webhook" });
		const extra = makeWebhookTarget(connection, { id: randomUUID(), name: "多余 Webhook" });
		const sub = makeSampleSubscription("66666");
		sub.routing.post = [extra.id, primary.id];
		sub.routing.liveStart = [extra.id];
		sub.extraTargets.atAllPost[extra.id] = true;
		sub.extraTargets.atAllLiveStart[extra.id] = false;
		await writeFile(join(state2, "connections.json"), JSON.stringify([connection]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([primary, extra]), "utf8");
		await writeFile(join(state2, "subscriptions.json"), subscriptionsFileText([sub]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			dataRoot: dir2,
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();

		expect(store2.getTargets()).toEqual([
			expect.objectContaining({ id: primary.id, managedBy: "connection", name: connection.name }),
		]);
		const nextSub = store2.getSubscriptions()[0];
		expect(nextSub?.routing.post).toEqual([primary.id]);
		expect(nextSub?.routing.liveStart).toEqual([primary.id]);
		expect(nextSub?.extraTargets.atAllPost).toEqual({ [primary.id]: true });
		expect(nextSub?.extraTargets.atAllLiveStart).toEqual({ [primary.id]: false });
		await rm(dir2, { recursive: true, force: true });
	});

	it("a fresh store re-loads existing JSON on disk", async () => {
		const sub = makeSampleSubscription("33333");
		await store.upsertSubscription(sub);
		await store.patchGlobals({ app: { fansCron: "*/7 * * * *" } });

		// Build a second store pointing at the same dataDir
		const bus2 = makeFakeBus();
		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dataDir),
			dataRoot: dataDir,
			bus: bus2,
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();
		expect(store2.getGlobals().app.fansCron).toBe("*/7 * * * *");
		expect(store2.getSubscriptions()).toHaveLength(1);
		expect(store2.getSubscriptions()[0]?.id).toBe(sub.id);
	});
});

describe("ConfigStore.close", () => {
	let dataDir: string;
	let stateDir: string;
	let store: ConfigStore;

	beforeEach(async () => {
		storageWriteGate.reset();
		dataDir = await mkdtemp(join(tmpdir(), "bn-config-close-"));
		stateDir = join(dataDir, ...CONFIG_DIR);
		store = createConfigStore({
			bootstrap: makeBootstrap(dataDir),
			dataRoot: dataDir,
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store.load();
	});

	afterEach(async () => {
		storageWriteGate.reset();
		await rm(dataDir, { recursive: true, force: true });
	});

	/** 挂起 `promise` 之后过一小会儿它还没落定 —— 用来断言「close 还在等」。 */
	async function stillPending(promise: Promise<unknown>): Promise<boolean> {
		let settled = false;
		void promise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		return !settled;
	}

	it("close 等在途的写落盘", async () => {
		await store.upsertConnection(makeWebhookConnection());
		const target = store.getTargets()[0] as PushTarget;
		storageWriteGate.hold();
		const writing = store.recordTargetTestStatus(target.id, {
			ok: true,
			lastCheckedAt: "2026-06-06T00:00:00.000Z",
			latencyMs: 12,
		});
		await storageWriteGate.arrived();

		const closing = store.close();
		expect(await stillPending(closing)).toBe(true);

		storageWriteGate.release();
		await closing;
		await writing;
		const onDisk = JSON.parse(
			await readFile(join(stateDir, "targets.json"), "utf8"),
		) as PushTarget[];
		expect(onDisk.find((t) => t.id === target.id)?.testStatus).toMatchObject({
			ok: true,
			latencyMs: 12,
		});
	});

	it("close 等得到嵌套排队的写(replaceSections 排在 globals 的写后面、关门时才轮到它去拿其余分区)", async () => {
		const sub = makeSampleSubscription("33333");
		storageWriteGate.hold();
		const patching = store.patchGlobals({ app: { fansCron: "*/3 * * * *" } });
		await storageWriteGate.arrived();
		// 外层任务排在 globals 的队里干等:内层四个分区的写要等它跑起来才会一层层交进来。
		const replacing = store.replaceSections({ subscriptions: [sub] });

		const closing = store.close();
		expect(await stillPending(closing)).toBe(true);

		storageWriteGate.release();
		await closing;
		await patching;
		await expect(replacing).resolves.toEqual(["subscriptions"]);
		const onDisk = JSON.parse(await readFile(join(stateDir, "subscriptions.json"), "utf8")) as {
			subscriptions: Array<{ id: string }>;
		};
		expect(onDisk.subscriptions.map((s) => s.id)).toEqual([sub.id]);
	});

	it("close 之后的写被拒且不碰盘", async () => {
		await store.upsertConnection(makeWebhookConnection());
		const before = await readFile(join(stateDir, "targets.json"), "utf8");
		await store.close();
		const writesAtClose = storageWriteGate.writes;

		await expect(store.upsertConnection(makeWebhookConnection())).rejects.toMatchObject({
			code: "queue_closed",
		});
		await expect(store.patchGlobals({ app: { fansCron: "*/2 * * * *" } })).rejects.toMatchObject({
			code: "queue_closed",
		});

		expect(storageWriteGate.writes).toBe(writesAtClose);
		expect(await readFile(join(stateDir, "targets.json"), "utf8")).toBe(before);
		expect(store.getConnections()).toHaveLength(1);
	});
});
