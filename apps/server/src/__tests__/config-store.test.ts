import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BiliEvents,
	type ConfigScope,
	type Disposable,
	type MessageBus,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type ServiceContext,
	type Subscription,
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
		const adapter = {
			id: randomUUID(),
			name: "wh1",
			platform: "webhook" as const,
			enabled: true,
			config: { url: "https://example.com/hook", headers: {} },
		};
		await store.upsertAdapter(adapter);
		const target = {
			id: randomUUID(),
			name: "t1",
			adapterId: adapter.id,
			platform: "webhook" as const,
			scope: "group" as const,
			enabled: true,
			session: {},
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
});
