import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BiliEvents,
	type ConfigScope,
	type Disposable,
	deterministicUuid,
	FEATURE_KEYS,
	type MessageBus,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type PushAdapter,
	type PushTarget,
	type ServiceContext,
	type Subscription,
	SubscriptionSchema,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function makeWebhookAdapter(
	overrides: Partial<Extract<PushAdapter, { platform: "webhook" }>> = {},
) {
	return {
		id: randomUUID(),
		name: "团队 Webhook",
		platform: "webhook" as const,
		enabled: true,
		config: { url: "https://example.com/hook", provider: "generic" as const, headers: {} },
		...overrides,
	};
}

function makeOnebotAdapter(overrides: Partial<Extract<PushAdapter, { platform: "onebot" }>> = {}) {
	return {
		id: randomUUID(),
		name: "NapCat",
		platform: "onebot" as const,
		enabled: true,
		config: {
			transport: "http" as const,
			baseUrl: "http://127.0.0.1:3000",
			protocolVersion: "v11" as const,
			headers: {},
			timeoutMs: 15_000,
			retryTimes: 0,
			retryIntervalMs: 1_000,
		},
		...overrides,
	};
}

function makeWebhookTarget(
	adapter: Extract<PushAdapter, { platform: "webhook" }>,
	overrides: Partial<Extract<PushTarget, { platform: "webhook" }>> = {},
) {
	return {
		id: randomUUID(),
		name: "手动 Webhook",
		adapterId: adapter.id,
		platform: "webhook" as const,
		scope: "channel" as const,
		enabled: true,
		session: {},
		...overrides,
	};
}

function managedWebhookTargetId(adapterId: string): string {
	return deterministicUuid(`push-target:webhook-adapter:${adapterId}`);
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
		const adapter = makeOnebotAdapter();
		await store.upsertAdapter(adapter);
		const target = {
			id: randomUUID(),
			name: "t1",
			adapterId: adapter.id,
			platform: "onebot" as const,
			scope: "group" as const,
			enabled: true,
			session: { groupId: "10001" },
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
		const adapter = makeOnebotAdapter();
		await store.upsertAdapter(adapter);
		const target = {
			id: randomUUID(),
			name: "群聊",
			adapterId: adapter.id,
			platform: "onebot" as const,
			scope: "group" as const,
			enabled: true,
			session: { groupId: "10001" },
		};
		const keptTarget = {
			id: randomUUID(),
			name: "私聊",
			adapterId: adapter.id,
			platform: "onebot" as const,
			scope: "private" as const,
			enabled: true,
			session: { userId: "20002" },
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

	it("upsertAdapter(webhook) 自动创建系统托管 target", async () => {
		const adapter = makeWebhookAdapter();
		await store.upsertAdapter(adapter);

		const targets = store.getTargets();
		expect(targets).toHaveLength(1);
		expect(targets[0]).toMatchObject({
			id: managedWebhookTargetId(adapter.id),
			name: adapter.name,
			adapterId: adapter.id,
			platform: "webhook",
			scope: "channel",
			enabled: true,
			managedBy: "adapter",
			session: {},
		});
		const scopes = bus.events.filter(([e]) => e === "config-changed").map(([, args]) => args[0]);
		expect(scopes).toEqual(["adapters", "targets"]);
	});

	it("load() 回填缺失的 webhook 托管 target", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-managed-empty-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const adapter = makeWebhookAdapter();
		await writeFile(join(state2, "adapters.json"), JSON.stringify([adapter]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();
		expect(store2.getTargets()).toEqual([
			expect.objectContaining({
				id: managedWebhookTargetId(adapter.id),
				adapterId: adapter.id,
				managedBy: "adapter",
			}),
		]);
		await rm(dir2, { recursive: true, force: true });
	});

	it("load() 标记既有 webhook target 且保留 id", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-managed-existing-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const adapter = makeWebhookAdapter();
		const target = makeWebhookTarget(adapter, { id: randomUUID(), name: "旧 Webhook" });
		const sub = makeSampleSubscription("44444");
		sub.routing.dynamic = [target.id];
		await writeFile(join(state2, "adapters.json"), JSON.stringify([adapter]), "utf8");
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
			name: adapter.name,
			adapterId: adapter.id,
			managedBy: "adapter",
			scope: "channel",
		});
		expect(store2.getSubscriptions()[0]?.routing.dynamic).toEqual([target.id]);
		await rm(dir2, { recursive: true, force: true });
	});

	it("patchAdapter(webhook) 同步托管 target 名称与启用状态", async () => {
		const adapter = makeWebhookAdapter();
		await store.upsertAdapter(adapter);
		const patched = await store.patchAdapter(adapter.id, { name: "飞书 Webhook", enabled: false });
		expect(patched.name).toBe("飞书 Webhook");

		const target = store.getTargets()[0];
		expect(target).toMatchObject({
			id: managedWebhookTargetId(adapter.id),
			name: "飞书 Webhook",
			enabled: false,
			managedBy: "adapter",
			session: {},
		});
	});

	it("patchAdapter / upsertAdapter 拒绝变更既有 adapter platform", async () => {
		const adapter = makeWebhookAdapter();
		await store.upsertAdapter(adapter);
		const onebot = makeOnebotAdapter({ id: adapter.id, name: adapter.name });

		await expect(
			store.patchAdapter(adapter.id, { platform: "onebot", config: onebot.config } as never),
		).rejects.toBeInstanceOf(ConfigValidationError);
		await expect(store.upsertAdapter(onebot)).rejects.toBeInstanceOf(ConfigValidationError);
		expect(store.getAdapters()[0]?.platform).toBe("webhook");
		expect(store.getTargets()).toHaveLength(1);
	});

	it("deleteAdapter(webhook) 级联删除托管 target 并清理订阅 routing / atAll", async () => {
		const adapter = makeWebhookAdapter();
		await store.upsertAdapter(adapter);
		const targetId = store.getTargets()[0]?.id;
		expect(targetId).toBeDefined();
		const sub = makeSampleSubscription("55555");
		sub.routing.dynamic = [targetId as string];
		sub.routing.live = [targetId as string];
		sub.atAll.dynamic[targetId as string] = true;
		sub.atAll.live[targetId as string] = true;
		await store.upsertSubscription(sub);
		bus.events.length = 0;

		await expect(store.deleteAdapter(adapter.id)).resolves.toBe(true);
		expect(store.getAdapters()).toHaveLength(0);
		expect(store.getTargets()).toHaveLength(0);
		const nextSub = store.getSubscriptions()[0];
		expect(nextSub?.routing.dynamic).toEqual([]);
		expect(nextSub?.routing.live).toEqual([]);
		expect(nextSub?.atAll.dynamic).toEqual({});
		expect(nextSub?.atAll.live).toEqual({});
		const scopes = bus.events.filter(([e]) => e === "config-changed").map(([, args]) => args[0]);
		expect(scopes).toEqual(["adapters", "targets", "subscriptions"]);
	});

	it("deleteAdapter(onebot) 仍在被 target 引用时拒绝", async () => {
		const adapter = makeOnebotAdapter();
		await store.upsertAdapter(adapter);
		await store.upsertTarget({
			id: randomUUID(),
			name: "群聊",
			adapterId: adapter.id,
			platform: "onebot",
			scope: "group",
			enabled: true,
			session: { groupId: "10001" },
		});

		await expect(store.deleteAdapter(adapter.id)).rejects.toBeInstanceOf(ConfigValidationError);
		expect(store.getAdapters()).toHaveLength(1);
		expect(store.getTargets()).toHaveLength(1);
	});

	it("deleteTarget(managed) 拒绝直接删除托管 target", async () => {
		const adapter = makeWebhookAdapter();
		await store.upsertAdapter(adapter);
		const targetId = store.getTargets()[0]?.id;
		expect(targetId).toBeDefined();

		await expect(store.deleteTarget(targetId as string)).rejects.toBeInstanceOf(
			ConfigValidationError,
		);
		expect(store.getTargets()).toHaveLength(1);
	});

	it("upsertTarget(webhook) 拒绝外部手动创建 webhook target", async () => {
		const adapter = makeWebhookAdapter();
		await store.upsertAdapter(adapter);
		const manual = makeWebhookTarget(adapter, { id: randomUUID(), name: "额外 Webhook" });

		await expect(store.upsertTarget(manual)).rejects.toBeInstanceOf(ConfigValidationError);
		expect(store.getTargets()).toHaveLength(1);
	});

	it("patchTarget(managed) 拒绝外部修改，recordTargetTestStatus 允许内部状态写回", async () => {
		const adapter = makeWebhookAdapter();
		await store.upsertAdapter(adapter);
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

	it("load() 合并同一 webhook adapter 下多余 targets 并把订阅引用迁到托管 id", async () => {
		const dir2 = await mkdtemp(join(tmpdir(), "bn-config-managed-duplicates-"));
		const state2 = join(dir2, "state");
		await mkdir(state2, { recursive: true });
		const adapter = makeWebhookAdapter();
		const primary = makeWebhookTarget(adapter, { id: randomUUID(), name: "主 Webhook" });
		const extra = makeWebhookTarget(adapter, { id: randomUUID(), name: "多余 Webhook" });
		const sub = makeSampleSubscription("66666");
		sub.routing.dynamic = [extra.id, primary.id];
		sub.routing.live = [extra.id];
		sub.atAll.dynamic[extra.id] = true;
		sub.atAll.live[extra.id] = false;
		await writeFile(join(state2, "adapters.json"), JSON.stringify([adapter]), "utf8");
		await writeFile(join(state2, "targets.json"), JSON.stringify([primary, extra]), "utf8");
		await writeFile(join(state2, "subscriptions.json"), JSON.stringify([sub]), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();

		expect(store2.getTargets()).toEqual([
			expect.objectContaining({ id: primary.id, managedBy: "adapter", name: adapter.name }),
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
		expect(tpl.dynamic).toBe("{name}发布了一条动态：{url}");
		expect(tpl.dynamicVideo).toBe("{name}发布了新视频：{url}");
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
		await writeFile(join(state2, "globals.json"), JSON.stringify(old), "utf8");

		const store2 = createConfigStore({
			bootstrap: makeBootstrap(dir2),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await store2.load();
		const t = store2.getGlobals().defaults.templates;
		expect(t.liveStart).toBe("{name} 开播啦，当前粉丝数：{follower}\n{link}");
		expect(t.liveOngoing).toBe("{name} 正在直播，已播 {time}，累计观看：{watched}\n{link}");
		expect(t.liveEnd).toBe("我自定义的下播文案 {name}"); // 自定义保留,不被迁移覆盖
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
		// ② dynamic/dynamicVideo 回填成当前默认
		expect(t.dynamic).toBe("{name}发布了一条动态：{url}");
		expect(t.dynamicVideo).toBe("{name}发布了新视频：{url}");
		// ③ 旧 {title}/{duration} 直播默认 + 旧 {user} 上舰默认迁移成当前默认
		expect(t.liveStart).toBe("{name} 开播啦，当前粉丝数：{follower}\n{link}");
		expect(t.liveOngoing).toBe("{name} 正在直播，已播 {time}，累计观看：{watched}\n{link}");
		expect(t.liveEnd).toBe("{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}");
		expect((t.guardBuy as { captain: { template: string } }).captain.template).toBe(
			"{uname} 成为了 {mname} 的舰长！",
		);
		await rm(dir2, { recursive: true, force: true });
	});
});
