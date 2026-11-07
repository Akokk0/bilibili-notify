/**
 * 统计总开关的**缓存读口**(ADR-0027 决策 9;㉙a)。
 *
 * 设置每读一次是整份深拷贝,而观看人数约两秒一帧、粉丝样本与「在记」也密 —— 开关判断读的是一个缓存的布尔,
 * 设置变了(总线上的 `config-changed`,范围是核心设置)才作废。
 */

import type { MessageBus } from "@bilibili-notify/internal";
import { makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { createStatsEnabled } from "../enabled.js";

function makeBus() {
	const handlers = new Set<(payload?: unknown) => void>();
	const bus = {
		emit: () => {},
		on: (_event: string, handler: (payload?: unknown) => void) => {
			handlers.add(handler);
			return { dispose: () => handlers.delete(handler) };
		},
	} as unknown as MessageBus;
	return {
		bus,
		changed: (scope: string) => {
			for (const h of [...handlers]) h({ scope });
		},
		listeners: () => handlers.size,
	};
}

function setup() {
	const { bus, changed, listeners } = makeBus();
	const globals = makeDefaultGlobalSettings();
	const getGlobals = vi.fn(() => globals);
	const sw = createStatsEnabled({ bus, getGlobals });
	return { sw, getGlobals, globals, changed, listeners };
}

describe("createStatsEnabled", () => {
	it("读的是设置里的 stats.enabled,出厂开着", () => {
		const { sw, globals } = setup();
		expect(sw.isEnabled()).toBe(true);
		globals.stats.enabled = false;
	});

	it("反复读只读一次设置(缓存),不是每次都深拷贝一份", () => {
		const { sw, getGlobals } = setup();
		for (let i = 0; i < 50; i++) sw.isEnabled();
		expect(getGlobals).toHaveBeenCalledTimes(1);
	});

	it("核心设置变了(config-changed globals)就作废,下一次读按新值 —— 不用重启", () => {
		const { sw, globals, changed } = setup();
		expect(sw.isEnabled()).toBe(true);
		globals.stats.enabled = false;
		// 没通知之前读缓存:证明缓存是真的在用。
		expect(sw.isEnabled()).toBe(true);
		changed("globals");
		expect(sw.isEnabled()).toBe(false);
		globals.stats.enabled = true;
		changed("globals");
		expect(sw.isEnabled()).toBe(true);
	});

	it("别的范围的变动(订阅、连接……)不作废它", () => {
		const { sw, getGlobals, changed } = setup();
		sw.isEnabled();
		changed("subscriptions");
		sw.isEnabled();
		expect(getGlobals).toHaveBeenCalledTimes(1);
	});

	it("dispose 解绑总线", () => {
		const { sw, listeners } = setup();
		expect(listeners()).toBe(1);
		sw.dispose();
		expect(listeners()).toBe(0);
	});
});
