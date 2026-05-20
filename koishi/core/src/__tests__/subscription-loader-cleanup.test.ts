/**
 * 回归守护 — P1-A K1:`bn restart` 后 ctx.on listener 累积。
 *
 * 验证 SubscriptionLoader.registerAdvancedSubListener() 注册的三个 ctx.on listener
 * 会在 dispose() 时被全部释放,bringUp+tearDown 重复 N 次后 active listener 数恒定。
 *
 * 这是 P1-A 的最小回归点:Codex Critical 报告里的"restart 累积"。
 */

import type { BilibiliAPI } from "@bilibili-notify/api";
import type { Logger } from "koishi";
import { describe, expect, it, vi } from "vitest";

// subscription-loader.ts 运行时 import { h } from "koishi" 用于 updateSubNotifier
// 渲染 koishi console 通知。vitest 加载 koishi 会拉 @koishijs/loader,启动期失败。
// 这里 mock 一个 minimal h fragment factory;测试不触达 updateSubNotifier 路径。
vi.mock("koishi", () => {
	const h = Object.assign((_type: string, ..._args: unknown[]) => ({ type: "stub" }), {
		Fragment: "fragment",
	});
	return { h };
});

const { SubscriptionLoader } = await import("../subscription-loader");

type Listener = (...args: unknown[]) => void;

/**
 * 最小的 koishi Context 测试替身:实现 on/emit 的 release 语义。
 * registerAdvancedSubListener 只用 ctx.on,够测了。
 */
function makeFakeCtx() {
	const listeners = new Map<string, Set<Listener>>();
	const ctx = {
		on(name: string, fn: Listener) {
			let set = listeners.get(name);
			if (!set) {
				set = new Set();
				listeners.set(name, set);
			}
			set.add(fn);
			return () => {
				const cur = listeners.get(name);
				if (!cur) return false;
				return cur.delete(fn);
			};
		},
		listenerCount(name: string): number {
			return listeners.get(name)?.size ?? 0;
		},
		totalListenerCount(): number {
			let total = 0;
			for (const set of listeners.values()) total += set.size;
			return total;
		},
	};
	return ctx;
}

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	level: 1,
} as unknown as Logger;

function makeLoader(ctx: ReturnType<typeof makeFakeCtx>): InstanceType<typeof SubscriptionLoader> {
	return new SubscriptionLoader({
		// biome-ignore lint/suspicious/noExplicitAny: koishi Context 测试替身
		ctx: ctx as any,
		logger: silentLogger,
		hooks: {
			getConfig: () => ({ advancedSub: true }) as never,
			setConfig: () => {},
			subList: () => "",
		},
		store: {
			replaceAll: () => {},
			list: () => [],
			// biome-ignore lint/suspicious/noExplicitAny: 测试替身
		} as any,
		registry: {
			setAdapter: () => {},
			set: () => {},
			clear: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: 测试替身
		} as any,
		api: {} as BilibiliAPI,
	});
}

describe("SubscriptionLoader cleanup — P1-A K1 listener 累积", () => {
	it("registerAdvancedSubListener 注册 3 个 listener,dispose 后全部清掉", () => {
		const ctx = makeFakeCtx();
		const loader = makeLoader(ctx);

		expect(ctx.totalListenerCount()).toBe(0);
		loader.registerAdvancedSubListener();
		expect(ctx.listenerCount("bilibili-notify/advanced-sub-adapters")).toBe(1);
		expect(ctx.listenerCount("bilibili-notify/advanced-sub-targets")).toBe(1);
		expect(ctx.listenerCount("bilibili-notify/advanced-sub")).toBe(1);
		expect(ctx.totalListenerCount()).toBe(3);

		loader.dispose();
		expect(ctx.totalListenerCount()).toBe(0);
	});

	it("register+dispose 重复 5 次,active listener 数恒定 = 0(无累积)", () => {
		const ctx = makeFakeCtx();
		for (let i = 0; i < 5; i++) {
			const loader = makeLoader(ctx);
			loader.registerAdvancedSubListener();
			expect(ctx.totalListenerCount()).toBe(3); // 每次启动都是 3 个
			loader.dispose();
			expect(ctx.totalListenerCount()).toBe(0); // 每次关闭都清零
		}
	});
});
