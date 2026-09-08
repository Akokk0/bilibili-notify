import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BiliEvents,
	type ConfigScope,
	type Connection,
	type Disposable,
	deterministicUuid,
	FEATURE_KEYS,
	type MessageBus,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type PushTarget,
	type ServiceContext,
	type Subscription,
	SubscriptionSchema,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createBackupService } from "../backup/service.js";
import type { BootstrapConfig } from "../config/schema.js";
import { type ConfigStore, ConfigValidationError, createConfigStore } from "../config/store.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeFakeBus(): MessageBus & { events: Array<[keyof BiliEvents, unknown[]]> } {
	const events: Array<[keyof BiliEvents, unknown[]]> = [];
	const listeners = new Map<keyof BiliEvents, Set<(...a: unknown[]) => void>>();
	return {
		events,
		emit(event, ...args) {
			events.push([event, args as unknown[]]);
			const set = listeners.get(event);
			if (!set) return;
			for (const h of [...set]) (h as (...a: unknown[]) => void)(...args);
		},
		on(event, handler): Disposable {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			const wrapped = (...a: unknown[]) => (handler as (...x: unknown[]) => void)(...a);
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
	return makeEmptySubscription({ id: randomUUID(), uid });
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
		stateDir = join(dataDir, "state");
		bus = makeFakeBus();
		store = createConfigStore({
			bootstrap: makeBootstrap(dataDir),
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
		const globalsRaw = await readFile(join(stateDir, "globals.json"), "utf8");
		const subsRaw = await readFile(join(stateDir, "subscriptions.json"), "utf8");
		const tgtsRaw = await readFile(join(stateDir, "targets.json"), "utf8");
		expect(JSON.parse(globalsRaw)).toEqual(makeDefaultGlobalConfig());
		expect(JSON.parse(subsRaw)).toEqual([]);
		expect(JSON.parse(tgtsRaw)).toEqual([]);
		expect(store.getGlobals()).toEqual(makeDefaultGlobalConfig());
	});

	it("getGlobals/getSubscriptions/getTargets return cloned snapshots", () => {
		const a = store.getGlobals();
		a.app.dynamicCron = "tampered";
		const b = store.getGlobals();
		expect(b.app.dynamicCron).not.toBe("tampered");

		const subs = store.getSubscriptions();
		subs.push(makeSampleSubscription());
		expect(store.getSubscriptions()).toHaveLength(0);
	});

	it("SY1: patchGlobals 收到 null 清除可选字段;undefined 仍是“不改”", async () => {
		// targetId 规范是 z.uuid().optional(),须用结构合法的 UUID(版本/变体
		// nibble 正确),用 crypto.randomUUID() 生成 v4。
		const T1 = randomUUID();
		const T2 = randomUUID();
		await store.patchGlobals({ master: { targetId: T1 }, app: { userAgent: "UA/1" } });
		expect(store.getGlobals().master.targetId).toBe(T1);
		expect(store.getGlobals().app.userAgent).toBe("UA/1");

		// null = 显式清除
		await store.patchGlobals({
			master: { targetId: null },
			app: { userAgent: null },
		} as never);
		expect(store.getGlobals().master.targetId).toBeUndefined();
		expect(store.getGlobals().app.userAgent).toBeUndefined();

		// undefined / 不带该键 ≠ 清除:重配后再发不含 master 的 patch,值保留
		await store.patchGlobals({ master: { targetId: T2 } });
		await store.patchGlobals({ app: { dynamicCron: "*/9 * * * *" } });
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
			bus: bus2,
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();
		expect(store2.getGlobals().defaults.messageLayout.live).toEqual(customLive);
	});

	/**
	 * 换人格只改一个指针字符串,是最容易被中间某层吃掉的那种改动 —— 而症状恰好
	 * 就是主人报的「怎么选都切不过去」。这里把整条落盘链钉住:合并 → schema
	 * (`migratePersonaPointer` 会重算指针,它必须认账而不是按 `ai.persona` 把选择
	 * 拨回去)→ 落盘 → 冷重启再读。
	 */
	it("换全局人格:activePreset 存得住,冷重启后不被 ai.persona 拨回去", async () => {
		// 默认配置的 persona 就是「温柔女仆」那份,指针也指着它 —— 换成傲娇毒舌之后,
		// persona 与指针刻意不一致,正是迁移最容易判错的形状。
		expect(store.getGlobals().defaults.ai.activePreset).toBe("gentle-maid");

		const next = await store.patchGlobals({ defaults: { ai: { activePreset: "tsundere" } } });
		expect(next.defaults.ai.activePreset).toBe("tsundere");
		// 指针不改写 persona —— 主人手写的那份原封不动。
		expect(next.defaults.ai.persona.name).toBe("小绫");

		const bus2 = makeFakeBus();
		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dataDir),
			bus: bus2,
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();
		expect(store2.getGlobals().defaults.ai.activePreset).toBe("tsundere");
	});

	it("setGlobals rejects malformed input with ConfigValidationError", async () => {
		const bad = { ...store.getGlobals(), app: { dynamicCron: 123 as unknown as string } };
		await expect(store.setGlobals(bad as never)).rejects.toBeInstanceOf(ConfigValidationError);
	});

	it("patchGlobals rejects malformed input with ConfigValidationError and does not mutate", async () => {
		const before = store.getGlobals();
		await expect(
			store.patchGlobals({ app: { dynamicCron: 42 as unknown as string } }),
		).rejects.toBeInstanceOf(ConfigValidationError);
		expect(store.getGlobals()).toEqual(before);
	});

	it("patchGlobals atomic write: persisted file matches getGlobals() immediately", async () => {
		const next = await store.patchGlobals({ app: { dynamicCron: "*/5 * * * *" } });
		expect(next.app.dynamicCron).toBe("*/5 * * * *");
		expect(store.getGlobals().app.dynamicCron).toBe("*/5 * * * *");
		const onDisk = JSON.parse(await readFile(join(stateDir, "globals.json"), "utf8"));
		expect(onDisk).toEqual(next);
	});

	it("concurrent patchGlobals calls serialize and converge to a consistent state", async () => {
		await Promise.all([
			store.patchGlobals({ app: { dynamicCron: "*/3 * * * *" } }),
			store.patchGlobals({ app: { healthCheckMinutes: 60 } }),
			store.patchGlobals({ master: { targetId: undefined } }),
		]);
		const final = store.getGlobals();
		expect(final.app.dynamicCron).toBe("*/3 * * * *");
		expect(final.app.healthCheckMinutes).toBe(60);
		// On-disk matches in-memory
		const onDisk = JSON.parse(await readFile(join(stateDir, "globals.json"), "utf8"));
		expect(onDisk).toEqual(final);
		// All three writes emitted exactly one 'config-changed' for globals
		const globalEvents = bus.events.filter(
			([e, args]) => e === "config-changed" && args[0] === "globals",
		);
		expect(globalEvents).toHaveLength(3);
	});

	it("upsertSubscription adds a new entry; same id updates in place; deleteSubscription removes", async () => {
		const sub = makeSampleSubscription("11111");
		await store.upsertSubscription(sub);
		expect(store.getSubscriptions()).toHaveLength(1);
		expect(store.getSubscriptions()[0]?.uid).toBe("11111");

		// Update the same id (cannot mutate uid past schema regex, but we can flip enabled / notes)
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
		const broken = { ...makeSampleSubscription(), uid: "not-a-uid" };
		await expect(store.upsertSubscription(broken as never)).rejects.toBeInstanceOf(
			ConfigValidationError,
		);
		const onDisk = JSON.parse(await readFile(join(stateDir, "subscriptions.json"), "utf8"));
		expect(onDisk).toEqual([]);
	});

	it("emits 'config-changed' exactly once per successful write with correct scope", async () => {
		const captured: ConfigScope[] = [];
		const sub = bus.on("config-changed", (scope) => {
			captured.push(scope);
		});

		await store.patchGlobals({ app: { dynamicCron: "*/4 * * * *" } });
		await store.upsertSubscription(makeSampleSubscription("22222"));

		// Failures must NOT emit
		await store.patchGlobals({ app: { dynamicCron: 9 as unknown as string } }).catch(() => {});

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
		const events1 = bus.events.filter(
			([e, args]) => e === "config-changed" && args[0] === "targets",
		);
		expect(events1).toHaveLength(1);

		const removed = await store.deleteTarget(target.id);
		expect(removed).toBe(true);
		expect(store.getTargets()).toHaveLength(0);
	});

	it("deleteTarget 级联清理订阅 routing / atAll 并保持 schema 自洽", async () => {
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
		sub.atAll.dynamic[target.id] = true;
		sub.atAll.dynamic[keptTarget.id] = false;
		sub.atAll.live[target.id] = false;
		sub.atAll.live[keptTarget.id] = true;
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
		expect(nextSub?.atAll.dynamic).toEqual({ [keptTarget.id]: false });
		expect(nextSub?.atAll.live).toEqual({ [keptTarget.id]: true });
		expect(SubscriptionSchema.safeParse(nextSub).success).toBe(true);
		const scopes = bus.events.filter(([e]) => e === "config-changed").map(([, args]) => args[0]);
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
		const scopes = bus.events.filter(([e]) => e === "config-changed").map(([, args]) => args[0]);
		expect(scopes).toEqual(["adapters", "targets"]);
	});

	it("load() 把老形状的 adapters.json 就地迁移并回写 —— 主人盘上那份没有 kind/connector", async () => {
		// 这是这次形状变更**唯一真会炸主人机器**的路径:schema 一旦要求 kind/connector,
		// 存量 adapters.json 就 parse 不过、开机直接 ConfigValidationError。夹具刻意写成
		// 「史前」形状(连 transport 都没有),走的是与 schema `.default("http")` 同一个回落。
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-migrate-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const legacy = {
			id: randomUUID(),
			name: "老 NapCat",
			platform: "onebot",
			enabled: true,
			config: { baseUrl: "http://127.0.0.1:3000", accessToken: "tok" },
		};
		await writeFile(join(state2, "adapters.json"), JSON.stringify([legacy]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();

		expect(store2.getConnections()).toEqual([
			expect.objectContaining({ id: legacy.id, kind: "direct", connector: "http" }),
		]);
		// 回写到盘上,而不是每次开机都在内存里补一遍 —— 否则任何一次 upsert 都会把
		// 没迁移的那份原样写回去。
		const onDisk = JSON.parse(await readFile(join(state2, "adapters.json"), "utf8"));
		expect(onDisk[0]).toMatchObject({ kind: "direct", connector: "http" });
		// 迁移前的原件留一份 —— 迁移错了主人还能自己捞回来。
		const bak = JSON.parse(await readFile(join(state2, "adapters.json.bak"), "utf8"));
		expect(bak).toEqual([legacy]);
	});

	it("load() 把老形状的 targets.json 就地迁移并回写 —— 主人盘上那份没有 kind", async () => {
		// 与连接侧同一条路径:schema 一旦要求 kind,存量 targets.json 就 parse 不过、
		// 开机直接炸。两支各验一条 —— webhook 那条要落到 endpoint、群那条要落到 session。
		const dir2 = await mkdtemp(join(tmpdir(), "bn-target-migrate-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const connection = makeOnebotConnection();
		const legacyTarget = {
			id: randomUUID(),
			name: "老群目标",
			adapterId: connection.id,
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "10001" },
		};
		await writeFile(join(state2, "adapters.json"), JSON.stringify([connection]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([legacyTarget]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();

		expect(store2.getTargets()).toEqual([
			expect.objectContaining({ id: legacyTarget.id, kind: "session" }),
		]);
		const onDisk = JSON.parse(await readFile(join(state2, "targets.json"), "utf8"));
		expect(onDisk[0]).toMatchObject({ kind: "session" });
		const bak = JSON.parse(await readFile(join(state2, "targets.json.bak"), "utf8"));
		expect(bak).toEqual([legacyTarget]);
		// 连接那份已经是新形状 —— 别顺手也给它留一份 .bak。
		await expect(readFile(join(state2, "adapters.json.bak"), "utf8")).rejects.toThrow();
	});

	it("load() 把老 webhook 目标迁成 endpoint —— 托管同步认的是形态,迁错就会重造一张", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-target-migrate-wh-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const connection = makeWebhookConnection();
		const legacyId = managedWebhookTargetId(connection.id);
		const legacyTarget = {
			id: legacyId,
			name: connection.name,
			adapterId: connection.id,
			platform: "webhook",
			scope: "channel",
			enabled: true,
			managedBy: "adapter",
			session: {},
		};
		await writeFile(join(state2, "adapters.json"), JSON.stringify([connection]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([legacyTarget]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();

		expect(store2.getTargets()).toEqual([
			expect.objectContaining({ id: legacyId, kind: "endpoint", managedBy: "connection" }),
		]);
	});

	it("load() 对已经是新形状的 adapters.json 不回写 —— 也就不会每次开机都留一份 .bak", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-nomigrate-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		await writeFile(
			join(state2, "adapters.json"),
			JSON.stringify([makeOnebotConnection()]),
			"utf8",
		);
		await writeFile(join(state2, "targets.json"), JSON.stringify([]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();
		await expect(readFile(join(state2, "adapters.json.bak"), "utf8")).rejects.toThrow();
	});

	it("load() 回填缺失的 webhook 托管 target", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-managed-empty-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const connection = makeWebhookConnection();
		await writeFile(join(state2, "adapters.json"), JSON.stringify([connection]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
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

	// 已撤下的平台(web-dashboard 早先、koishi-bot / astrbot 随宿主一起)留下的存量条目:
	// 当年的 schema 是收它们的(dashboard 不给建,但直调 API / 旧备份都能留下)。loader 一律
	// 静默丢弃 —— safeParse 一失败就是启动期 throw,没有面板可以进去改,boot 三振回落也救不回来。
	it.each([
		{ platform: "web-dashboard", config: {}, session: {} },
		{ platform: "koishi-bot", config: { botPlatform: "onebot" }, session: { channelId: "1" } },
		{ platform: "astrbot", config: {}, session: {} },
	])("load() 静默丢弃已撤下平台 $platform 的存量 adapter 与 target", async (stale) => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-drop-removed-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const webhook = makeWebhookConnection();
		const connection = {
			id: randomUUID(),
			name: stale.platform,
			platform: stale.platform,
			enabled: true,
			config: stale.config,
		};
		const target = {
			id: randomUUID(),
			name: "stale",
			adapterId: connection.id,
			platform: stale.platform,
			scope: "group",
			enabled: true,
			session: stale.session,
		};
		await writeFile(join(state2, "adapters.json"), JSON.stringify([connection, webhook]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([target]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load(); // 不应抛错
		expect(store2.getConnections().map((a) => a.connector)).toEqual(["webhook"]);
		// 撤下平台的 target 被丢弃;只剩 webhook 自动托管 target
		expect(store2.getTargets().every((t) => t.kind === "endpoint")).toBe(true);
		await rm(dir2, { recursive: true, force: true });
	});

	it("load() 留下形状正确、平台却不认得的 target —— 桥驮来的就长这样", async () => {
		// 目标的平台开放之后,「认不认识」不能再靠词表答:telegram 不在任何词表里,
		// 但它是合法的。判据换成「认不得的平台**又** parse 不过才是存量」,所以这一条
		// 必须活下来 —— 上一条用例(已撤下平台)与这一条一起才把那个判据钉住。
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-open-platform-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const connection = makeOnebotConnection();
		const bridged = {
			id: randomUUID(),
			name: "桥上的 telegram 群",
			connectionId: connection.id,
			kind: "session",
			platform: "telegram",
			scope: "group",
			enabled: true,
			address: "-1001234567890",
		};
		await writeFile(join(state2, "adapters.json"), JSON.stringify([connection]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([bridged]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();
		expect(store2.getTargets()).toEqual([expect.objectContaining({ platform: "telegram" })]);
		await rm(dir2, { recursive: true, force: true });
	});

	it("load() 对认得的平台上坏掉的 target 照旧抛错 —— 别把真损坏当存量吃掉", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-broken-target-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const connection = makeOnebotConnection();
		const broken = {
			id: randomUUID(),
			name: "坏的",
			connectionId: connection.id,
			kind: "session",
			platform: "onebot",
			scope: "群",
			enabled: true,
			address: "1",
		};
		await writeFile(join(state2, "adapters.json"), JSON.stringify([connection]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([broken]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await expect(store2.load()).rejects.toBeInstanceOf(ConfigValidationError);
		await rm(dir2, { recursive: true, force: true });
	});

	it("load() 标记既有 webhook target 且保留 id", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-managed-existing-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const connection = makeWebhookConnection();
		const target = makeWebhookTarget(connection, { id: randomUUID(), name: "旧 Webhook" });
		const sub = makeSampleSubscription("44444");
		sub.routing.dynamic = [target.id];
		await writeFile(join(state2, "adapters.json"), JSON.stringify([connection]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([target]), "utf8");
		await writeFile(join(state2, "subscriptions.json"), JSON.stringify([sub]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
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
		expect(store2.getSubscriptions()[0]?.routing.dynamic).toEqual([target.id]);
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
		expect(store.getConnections()[0]?.platform).toBe(connection.platform);
		expect(store.getTargets()).toHaveLength(1);
	});

	it("deleteConnection(webhook) 级联删除托管 target 并清理订阅 routing / atAll", async () => {
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);
		const targetId = store.getTargets()[0]?.id;
		expect(targetId).toBeDefined();
		const sub = makeSampleSubscription("55555");
		sub.routing.dynamic = [targetId as string];
		sub.routing.live = [targetId as string];
		sub.atAll.dynamic[targetId as string] = true;
		sub.atAll.live[targetId as string] = true;
		await store.upsertSubscription(sub);
		bus.events.length = 0;

		await expect(store.deleteConnection(connection.id)).resolves.toBe(true);
		expect(store.getConnections()).toHaveLength(0);
		expect(store.getTargets()).toHaveLength(0);
		const nextSub = store.getSubscriptions()[0];
		expect(nextSub?.routing.dynamic).toEqual([]);
		expect(nextSub?.routing.live).toEqual([]);
		expect(nextSub?.atAll.dynamic).toEqual({});
		expect(nextSub?.atAll.live).toEqual({});
		const scopes = bus.events.filter(([e]) => e === "config-changed").map(([, args]) => args[0]);
		expect(scopes).toEqual(["adapters", "targets", "subscriptions"]);
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
				adapters: [connection],
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

		await expect(store.deleteConnection(connection.id)).rejects.toBeInstanceOf(
			ConfigValidationError,
		);
		expect(store.getConnections()).toHaveLength(1);
		expect(store.getTargets()).toHaveLength(1);
	});

	it("deleteTarget(managed) 拒绝直接删除托管 target", async () => {
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);
		const targetId = store.getTargets()[0]?.id;
		expect(targetId).toBeDefined();

		await expect(store.deleteTarget(targetId as string)).rejects.toBeInstanceOf(
			ConfigValidationError,
		);
		expect(store.getTargets()).toHaveLength(1);
	});

	it("upsertTarget(webhook) 拒绝外部手动创建 webhook target", async () => {
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);
		const manual = makeWebhookTarget(connection, { id: randomUUID(), name: "额外 Webhook" });

		await expect(store.upsertTarget(manual)).rejects.toBeInstanceOf(ConfigValidationError);
		expect(store.getTargets()).toHaveLength(1);
	});

	it("备份往返:getTargets() 吐得出来的,upsertTarget() 就必须吃得下", async () => {
		// 备份导出走 getTargets()(必然含托管 target),恢复走 upsertTarget() —— 两头对不上
		// 的话,**任何含 webhook 适配器的备份都恢复不了**。而恢复是逐条 await、没有事务也
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
		sub.routing.dynamic = [legacyId];
		sub.atAll.dynamic[legacyId] = true;
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
		expect(nextSub?.routing.dynamic).toEqual([managedId]);
		expect(nextSub?.atAll.dynamic).toEqual({ [managedId as string]: true });
	});

	it("patchTarget(managed) 拒绝外部修改，recordTargetTestStatus 允许内部状态写回", async () => {
		const connection = makeWebhookConnection();
		await store.upsertConnection(connection);
		const target = store.getTargets()[0];
		expect(target).toBeDefined();

		await expect(
			store.patchTarget(target?.id as string, { name: "用户改名" }),
		).rejects.toBeInstanceOf(ConfigValidationError);
		await expect(
			store.patchTarget(target?.id as string, {
				testStatus: { ok: true, lastCheckedAt: "2026-06-06T00:00:00.000Z", latencyMs: 12 },
			}),
		).rejects.toBeInstanceOf(ConfigValidationError);
		const patched = await store.recordTargetTestStatus(target?.id as string, {
			ok: true,
			lastCheckedAt: "2026-06-06T00:00:00.000Z",
			latencyMs: 12,
		});
		expect(patched.testStatus).toMatchObject({ ok: true, latencyMs: 12 });
	});

	it("端到端:含 webhook 适配器的备份,导出后能在一台干净机器上恢复回来", async () => {
		// 这条住在这里,是因为真 ConfigStore 的夹具只有这个文件有 —— 而 backup-service
		// 那边用的是替身,替身把 upsertTarget 打成空函数,正是它把这个 bug 整个盖住了。
		// 源机器刻意造成「老装机」:托管 target 带的是**非确定性 id**(makeManagedWebhookTarget
		// 取 `existing?.id ?? 确定性id`,老记录会一直保留自己的)。这一步是承重的 —— 否则
		// 「把备份里的 target 恢复回来」和「照 adapter 重新生成一个」会得到同一个 id,测试
		// 分不出这两件事,也就钉不住任何东西。
		const connection = makeWebhookConnection();
		const legacyId = randomUUID();
		const sub = makeSampleSubscription("22222");
		sub.routing.dynamic = [legacyId];
		const dirA = await mkdtemp(join(tmpdir(), "bn-config-backup-src-"));
		const stateA = join(dirA, "state");
		await mkdir(stateA, { recursive: true });
		await writeFile(join(stateA, "adapters.json"), JSON.stringify([connection]), "utf8");
		await writeFile(
			join(stateA, "targets.json"),
			JSON.stringify([makeWebhookTarget(connection, { id: legacyId, managedBy: "connection" })]),
			"utf8",
		);
		await writeFile(join(stateA, "subscriptions.json"), JSON.stringify([sub]), "utf8");
		const source = createConfigStore({
			bootstrap: makeBootstrap(dirA),
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
		expect(fresh.getSubscriptions()[0]?.routing.dynamic).toEqual([legacyId]);
		await rm(dir2, { recursive: true, force: true });
		await rm(dirA, { recursive: true, force: true });
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
			cron: store.getGlobals().app.dynamicCron,
		};

		await expect(
			store.replaceSections({
				globals: {
					...store.getGlobals(),
					app: { ...store.getGlobals().app, dynamicCron: "*/9 * * * *" },
				},
				subscriptions: [],
				adapters: [connection],
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
		expect(store.getGlobals().app.dynamicCron).toBe(before.cron);
	});

	it("replaceSections:target 指向不存在的 adapter → 拒绝,且不写", async () => {
		const connection = makeOnebotConnection();
		await store.upsertConnection(connection);
		const before = store.getConnections();

		await expect(
			store.replaceSections({
				adapters: [connection],
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
		sub.routing.live = [legacyId];
		await store.upsertSubscription(sub);

		await store.replaceSections({
			adapters: [connection],
			targets: [
				makeWebhookTarget(connection, { id: legacyId, managedBy: "connection" }) as PushTarget,
			],
		});

		expect(store.getTargets()).toHaveLength(1);
		// 只有一条时它就是留下的那条 —— 老 id 保住,不会被换成确定性 id
		expect(store.getTargets()[0]?.id).toBe(legacyId);
		expect(store.getTargets()[0]?.managedBy).toBe("connection");
		expect(store.getSubscriptions()[0]?.routing.live).toEqual([legacyId]);
	});

	it("load() 合并同一 webhook adapter 下多余 targets 并把订阅引用迁到托管 id", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-managed-duplicates-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const connection = makeWebhookConnection();
		const primary = makeWebhookTarget(connection, { id: randomUUID(), name: "主 Webhook" });
		const extra = makeWebhookTarget(connection, { id: randomUUID(), name: "多余 Webhook" });
		const sub = makeSampleSubscription("66666");
		sub.routing.dynamic = [extra.id, primary.id];
		sub.routing.live = [extra.id];
		sub.atAll.dynamic[extra.id] = true;
		sub.atAll.live[extra.id] = false;
		await writeFile(join(state2, "adapters.json"), JSON.stringify([connection]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([primary, extra]), "utf8");
		await writeFile(join(state2, "subscriptions.json"), JSON.stringify([sub]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();

		expect(store2.getTargets()).toEqual([
			expect.objectContaining({ id: primary.id, managedBy: "connection", name: connection.name }),
		]);
		const nextSub = store2.getSubscriptions()[0];
		expect(nextSub?.routing.dynamic).toEqual([primary.id]);
		expect(nextSub?.routing.live).toEqual([primary.id]);
		expect(nextSub?.atAll.dynamic).toEqual({ [primary.id]: true });
		expect(nextSub?.atAll.live).toEqual({ [primary.id]: false });
		await rm(dir2, { recursive: true, force: true });
	});

	it("a fresh store re-loads existing JSON on disk", async () => {
		const sub = makeSampleSubscription("33333");
		await store.upsertSubscription(sub);
		await store.patchGlobals({ app: { dynamicCron: "*/7 * * * *" } });

		// Build a second store pointing at the same dataDir
		const bus2 = makeFakeBus();
		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dataDir),
			bus: bus2,
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();
		expect(store2.getGlobals().app.dynamicCron).toBe("*/7 * * * *");
		expect(store2.getSubscriptions()).toHaveLength(1);
		expect(store2.getSubscriptions()[0]?.id).toBe(sub.id);
	});

	it("加载缺 templates.dynamic/dynamicVideo 的老 globals.json → schema 回填默认,不抛", async () => {
		// 回归:dynamic/dynamicVideo 字段加入前写入的 globals.json 没有这两项。
		// 若 TemplateBundleSchema 把它们设为 required 无默认,旧用户升级后 load() 会
		// ConfigValidationError 直接拒绝启动。.default(...) 兜底保证旧配置仍可加载。
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-old-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const old = makeDefaultGlobalConfig() as unknown as {
			defaults: { templates: Record<string, unknown> };
		};
		delete old.defaults.templates.dynamic;
		delete old.defaults.templates.dynamicVideo;
		await writeFile(join(state2, "globals.json"), JSON.stringify(old), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await expect(store2.load()).resolves.toBeUndefined();
		const tpl = store2.getGlobals().defaults.templates;
		expect(tpl.dynamic).toBe("{name}发布了一条动态");
		expect(tpl.dynamicVideo).toBe("{name}发布了新视频");
		await rm(dir2, { recursive: true, force: true });
	});

	it("一次性迁移:老 globals.json 旧默认直播/上舰模板 → 改写为当前默认,自定义值保留", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-tpl-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const old = makeDefaultGlobalConfig() as unknown as {
			defaults: {
				templates: Record<string, unknown> & {
					guardBuy: { captain: { template: string }; commander: { template: string } };
				};
			};
		};
		// 占位符语法统一前的旧默认(用 {title}/{duration}/{user}/{mastername})
		old.defaults.templates.liveStart = "{name} 开播了！\n直播间标题：{title}\n直播间链接：{link}";
		old.defaults.templates.liveOngoing =
			"{name} 仍在直播中（已直播 {duration}）\n标题：{title}\n看过：{watched}";
		// liveEnd 改成用户自定义 → 迁移必须保留
		old.defaults.templates.liveEnd = "我自定义的下播文案 {name}";
		old.defaults.templates.guardBuy.captain.template = "{user} 成为了 {mastername} 的舰长！";
		// 消息版式引入前「链接内嵌模板」那代的动态默认 → 也要迁移成当前无链接默认
		old.defaults.templates.dynamic = "{name}发布了一条动态：{url}";
		await writeFile(join(state2, "globals.json"), JSON.stringify(old), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();
		const t = store2.getGlobals().defaults.templates;
		expect(t.liveStart).toBe("{name} 开播啦，当前粉丝数：{follower}");
		expect(t.liveOngoing).toBe("{name} 正在直播，已播 {time}，累计观看：{watched}");
		expect(t.liveEnd).toBe("我自定义的下播文案 {name}"); // 自定义保留,不被迁移覆盖
		expect(t.dynamic).toBe("{name}发布了一条动态"); // 带链接那代的默认 → 无链接新默认
		expect(t.guardBuy.captain.template).toBe("{uname} 成为了 {mname} 的舰长！");
		await rm(dir2, { recursive: true, force: true });
	});

	it("累积迁移:真 alpha.x globals.json(有 liveMsgEnabled、无 dynamic/dynamicVideo、旧 {title} liveStart)经 load() 自洽", async () => {
		// 跨三笔改动的兜底:① liveMsgEnabled 已从 schema 删除 → safeParse 须 strip 不报错;
		// ② dynamic/dynamicVideo 字段是新加的 → .default() 回填;③ 旧 {title} 默认 liveStart
		// → 一次性迁移成新默认。三件事叠加后顺序/交互不能互相打架。
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-legacy-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		// 从当前默认起步,再"退化"成 alpha.x 磁盘形态:抹掉 dynamic/dynamicVideo(老数据
		// 没这俩字段)、塞 liveMsgEnabled(schema 已删的旧键)、写回旧 {title}/{duration}
		// 直播默认 + 旧 {user} 上舰默认。用 JSON 往返 + 析构剔除,不用 delete。
		const base = makeDefaultGlobalConfig() as unknown as {
			defaults: {
				templates: Record<string, unknown> & { guardBuy: { captain: { template: string } } };
			};
		};
		const { dynamic: _d, dynamicVideo: _dv, ...restTpl } = base.defaults.templates;
		const legacy = {
			...base,
			defaults: {
				...base.defaults,
				templates: {
					...restTpl,
					liveMsgEnabled: false, // schema 已无此键 → 须被 strip
					liveStart: "{name} 开播了！\n直播间标题：{title}\n直播间链接：{link}",
					liveOngoing: "{name} 仍在直播中（已直播 {duration}）\n标题：{title}\n看过：{watched}",
					liveEnd: "{name} 下播了，直播时长 {duration}",
					guardBuy: {
						...base.defaults.templates.guardBuy,
						captain: {
							...base.defaults.templates.guardBuy.captain,
							template: "{user} 成为了 {mastername} 的舰长！",
						},
					},
				},
			},
		};
		await writeFile(join(state2, "globals.json"), JSON.stringify(legacy), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		// ① 不报错(strip 未知键,不抛 ConfigValidationError)
		await store2.load();
		const t = store2.getGlobals().defaults.templates as Record<string, unknown>;
		// ① liveMsgEnabled 被 strip
		expect(t.liveMsgEnabled).toBeUndefined();
		// ② dynamic/dynamicVideo 回填成当前默认(链接不再进模板)
		expect(t.dynamic).toBe("{name}发布了一条动态");
		expect(t.dynamicVideo).toBe("{name}发布了新视频");
		// ③ 旧 {title}/{duration} 直播默认 + 旧 {user} 上舰默认迁移成当前默认
		expect(t.liveStart).toBe("{name} 开播啦，当前粉丝数：{follower}");
		expect(t.liveOngoing).toBe("{name} 正在直播，已播 {time}，累计观看：{watched}");
		expect(t.liveEnd).toBe("{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}");
		expect((t.guardBuy as { captain: { template: string } }).captain.template).toBe(
			"{uname} 成为了 {mname} 的舰长！",
		);
		await rm(dir2, { recursive: true, force: true });
	});
});
