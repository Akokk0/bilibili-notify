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
import { registerBuiltinAdapters } from "../builtin-adapters.js";
import { createPlatformAdapterRegistry } from "../registry.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function direct(id: string, platform: string): Connection {
	return {
		id,
		name: id,
		enabled: true,
		kind: "direct",
		platform,
		config: {},
	} as unknown as Connection;
}

interface FakeAdapter extends PlatformAdapter {
	ctx?: PlatformAdapterContext;
	seen: string[][];
	changed: () => void;
}

function fakeAdapter(adapterKey: string): FakeAdapter {
	const fake = {
		adapterKey,
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

function setup() {
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
	const builtin = registerBuiltinAdapters({
		registry,
		adapters: [onebot, qq, webhook],
		logger,
		connections: () => list,
		onConnectionsChanged,
	});
	return { registry, onebot, qq, webhook, builtin, emit, listeners };
}

describe("registerBuiltinAdapters", () => {
	it("每个适配器被 start 一次,拿到只含自己连接的名单,并进了登记表", () => {
		const { registry, onebot, qq, webhook } = setup();
		expect(onebot.start).toHaveBeenCalledTimes(1);
		expect(qq.start).toHaveBeenCalledTimes(1);
		expect(webhook.start).toHaveBeenCalledTimes(1);
		expect(onebot.seen).toEqual([["ob1", "ob2"]]);
		expect(qq.seen).toEqual([["qq1"]]);
		expect(webhook.seen).toEqual([["wh1"]]);
		expect(registry.list().map((a) => a.adapterKey)).toEqual(["onebot", "qq-official", "webhook"]);
	});

	it("订阅发一声,每个适配器登记的回调都被叫到", () => {
		const { onebot, qq, webhook, emit } = setup();
		emit();
		expect(onebot.changed).toHaveBeenCalledTimes(1);
		expect(qq.changed).toHaveBeenCalledTimes(1);
		expect(webhook.changed).toHaveBeenCalledTimes(1);
	});

	it("dispose() 之后每个都 stop 一次、各自上下文的 signal 已中止、再发一声没人被叫", async () => {
		const { registry, onebot, qq, webhook, builtin, emit, listeners } = setup();
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

	it("dispose() 幂等 —— 再调不重复 stop", async () => {
		const { onebot, builtin } = setup();
		await builtin.dispose();
		await builtin.dispose();
		expect(onebot.stop).toHaveBeenCalledTimes(1);
	});
});
