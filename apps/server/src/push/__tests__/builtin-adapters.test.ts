/**
 * 内置适配器的「登记即启动、注销即停止」装配。
 *
 * 用假适配器钉:每个都被 `start` 一次并拿到只含自己连接的名单;连接变更的一声叫到每个适配器登记的回调;
 * 收尾时每个 `stop` 一次、各自上下文的 `signal` 已中止、订阅摘掉。
 * (引擎不再替适配器对账 / 收尾 —— 这条行为搬到了这里。)
 */

import type {
	Connection,
	Disposable,
	PlatformAdapter,
	PlatformAdapterContext,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { memoryIntegrationStore } from "../../__tests__/support/memory-key-value-store.js";
import { registerBuiltinAdapters } from "../builtin-adapters.js";
import { createPlatformAdapterRegistry } from "../registry.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function direct(id: string, platform: string): Connection {
	return {
		id,
		name: id,
		enabled: true,
		adapterKey: platform === "onebot" || platform === "qq-official" ? platform : "webhook",
		platform,
		settings: {},
		platformSnapshot: snapshotFor(platform),
	};
}

interface FakeAdapter extends PlatformAdapter {
	ctx?: PlatformAdapterContext;
	seen: string[][];
	changed: () => void;
}

function fakeAdapter(adapterKey: string): FakeAdapter {
	const fake = {
		adapterKey,
		settingsSchema: z.unknown(),
		seen: [] as string[][],
		changed: vi.fn() as unknown as () => void,
		isAvailable: () => true,
		send: async () => ({ ok: true, latencyMs: 1 }),
		start: vi.fn((ctx: PlatformAdapterContext) => {
			fake.ctx = ctx;
			fake.seen.push(ctx.connections().map((c) => c.id));
			ctx.onConnectionsChanged(() => fake.changed());
		}),
		stop: vi.fn(),
	} as unknown as FakeAdapter;
	return fake;
}

async function setup() {
	const stores = memoryIntegrationStore();
	const list: Connection[] = [
		direct("ob1", "onebot"),
		direct("qq1", "qq-official"),
		direct("wh1", "feishu"),
		direct("ob2", "onebot"),
	];
	const listeners = new Set<() => void>();
	const onConnectionsChanged = (fn: () => void): Disposable => {
		listeners.add(fn);
		return { dispose: () => listeners.delete(fn) };
	};
	const emit = () => {
		for (const fn of [...listeners]) fn();
	};
	const registry = createPlatformAdapterRegistry();
	const onebot = fakeAdapter("onebot");
	const qq = fakeAdapter("qq-official");
	const webhook = fakeAdapter("webhook");
	const builtin = await registerBuiltinAdapters({
		registry,
		adapters: [onebot, qq, webhook],
		logger,
		stores,
		connections: () => list,
		onConnectionsChanged,
	});
	return { registry, onebot, qq, webhook, builtin, emit, listeners, stores };
}

describe("registerBuiltinAdapters", () => {
	it("每个适配器被 start 一次,拿到只含自己连接的名单,并进了登记表", async () => {
		const { registry, onebot, qq, webhook } = await setup();
		expect(onebot.start).toHaveBeenCalledTimes(1);
		expect(qq.start).toHaveBeenCalledTimes(1);
		expect(webhook.start).toHaveBeenCalledTimes(1);
		expect(onebot.seen).toEqual([["ob1", "ob2"]]);
		expect(qq.seen).toEqual([["qq1"]]);
		expect(webhook.seen).toEqual([["wh1"]]);
		expect(registry.list().map((a) => a.adapterKey)).toEqual(["onebot", "qq-official", "webhook"]);
	});

	it("订阅发一声,每个适配器登记的回调都被叫到", async () => {
		const { onebot, qq, webhook, emit } = await setup();
		emit();
		expect(onebot.changed).toHaveBeenCalledTimes(1);
		expect(qq.changed).toHaveBeenCalledTimes(1);
		expect(webhook.changed).toHaveBeenCalledTimes(1);
	});

	it("dispose() 之后每个都 stop 一次、各自上下文的 signal 已中止、再发一声没人被叫", async () => {
		const { registry, onebot, qq, webhook, builtin, emit, listeners } = await setup();
		await builtin.dispose();
		expect(onebot.stop).toHaveBeenCalledTimes(1);
		expect(qq.stop).toHaveBeenCalledTimes(1);
		expect(webhook.stop).toHaveBeenCalledTimes(1);
		for (const fake of [onebot, qq, webhook]) expect(fake.ctx?.signal.aborted).toBe(true);
		expect(registry.list()).toEqual([]);
		expect(listeners.size).toBe(0);
		emit();
		expect(onebot.changed).not.toHaveBeenCalled();
		expect(qq.changed).not.toHaveBeenCalled();
		expect(webhook.changed).not.toHaveBeenCalled();
	});

	it("dispose() 之后用 start 时存下的 ctx 再订连接变更 → 当场撤掉,订阅发一声回调不被叫", async () => {
		const { onebot, builtin, emit, listeners } = await setup();
		await builtin.dispose();
		const late = vi.fn();
		onebot.ctx?.onConnectionsChanged(late);
		expect(listeners.size).toBe(0);
		emit();
		expect(late).not.toHaveBeenCalled();
	});

	it("登记到一半失败(第二个与第一个键相同)→ 抛出,第一个被 stop、signal 已中止、登记表空、第三个没 start", async () => {
		const registry = createPlatformAdapterRegistry();
		const first = fakeAdapter("onebot");
		const dup = fakeAdapter("onebot");
		const third = fakeAdapter("qq-official");
		// 每次 open 都给一份独立的内存存储:这一条要走到的是登记表的「键重复」,不是存储的「同键已开」。
		await expect(
			registerBuiltinAdapters({
				registry,
				adapters: [first, dup, third],
				logger,
				stores: { open: (key) => memoryIntegrationStore().open(key) },
				connections: () => [],
				onConnectionsChanged: () => ({ dispose() {} }),
			}),
		).rejects.toThrow(/already registered/);
		expect(first.start).toHaveBeenCalledTimes(1);
		expect(first.stop).toHaveBeenCalledTimes(1);
		expect(first.ctx?.signal.aborted).toBe(true);
		expect(registry.list()).toEqual([]);
		expect(dup.start).not.toHaveBeenCalled();
		expect(third.start).not.toHaveBeenCalled();
	});

	it("存储打不开 → 抛出,已登记的回滚、开着的把手都关了", async () => {
		const stores = memoryIntegrationStore();
		const registry = createPlatformAdapterRegistry();
		const first = fakeAdapter("onebot");
		const second = fakeAdapter("qq-official");
		await expect(
			registerBuiltinAdapters({
				registry,
				adapters: [first, second],
				logger,
				stores: {
					open: async (key) => {
						if (key === "qq-official") throw new Error("打不开");
						return stores.open(key);
					},
				},
				connections: () => [],
				onConnectionsChanged: () => ({ dispose() {} }),
			}),
		).rejects.toThrow("打不开");
		expect(first.stop).toHaveBeenCalledTimes(1);
		expect(registry.list()).toEqual([]);
		expect(second.start).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(stores.openKeys()).toEqual([]));
	});

	it("每个适配器按自己的键开存储;dispose() 之后各把手都关了(能再开)", async () => {
		const { builtin, stores } = await setup();
		expect(stores.openKeys().sort()).toEqual(["onebot", "qq-official", "webhook"]);
		await builtin.dispose();
		expect(stores.openKeys()).toEqual([]);
	});

	it("适配器 start 里拿到的 state / secrets 是这个适配器那一份,互不相干", async () => {
		const { onebot, qq } = await setup();
		await onebot.ctx?.state.set("k", "onebot");
		await qq.ctx?.state.set("k", "qq");
		expect(onebot.ctx?.state.get("k")).toBe("onebot");
		expect(qq.ctx?.state.get("k")).toBe("qq");
		expect(onebot.ctx?.secrets.get("k")).toBeUndefined();
	});

	it("dispose() 幂等 —— 再调不重复 stop", async () => {
		const { onebot, builtin } = await setup();
		await builtin.dispose();
		await builtin.dispose();
		expect(onebot.stop).toHaveBeenCalledTimes(1);
	});
});
