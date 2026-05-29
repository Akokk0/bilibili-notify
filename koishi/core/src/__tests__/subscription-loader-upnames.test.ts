/**
 * 回归守护 — `bili list` / `bili ll` / 控制台 notifier 把 UP 主昵称渲染成 UID。
 *
 * koishi 端的名字是用户在配置里手填的静态配置,现在统一承载在
 * `Subscription.name`:
 *  - 普通模式:flatSubToSubscription 从 config.subs[].name 写入 sub.name;
 *  - 高级订阅:advanced-subscription 从配置字典 key 写入 sub.name(见其测试)。
 * 渲染层直接读 `sub.name?.trim() || sub.uid`,不再额外发 API 请求或走事件缓存。
 */

import type { FlatSubConfigItem } from "@bilibili-notify/subscription";
import { describe, expect, it, vi } from "vitest";

// subscription-loader.ts 运行时 import { h } from "koishi" 用于 updateSubNotifier
// 渲染 koishi console 通知。vitest 加载 koishi 会拉 @koishijs/loader,启动期失败。
// 这里 mock 一个 minimal h;本测试只触达 flatSubToSubscription。
vi.mock("koishi", () => {
	const h = Object.assign((_type: string, ..._args: unknown[]) => ({ type: "stub" }), {
		Fragment: "fragment",
	});
	return { h };
});

const { flatSubToSubscription } = await import("../subscription-loader");

function makeRegistry() {
	return {
		findKoishiBotAdapter: () => undefined,
		setAdapter: vi.fn(),
		findTargetByChannel: () => undefined,
		set: vi.fn(),
		clear: vi.fn(),
	};
}

function makeFlatSub(patch: Partial<FlatSubConfigItem> = {}): FlatSubConfigItem {
	return {
		name: "Asaki大人",
		uid: "194484313",
		platform: "onebot",
		target: "10000",
		dynamic: true,
		dynamicAtAll: false,
		live: true,
		liveAtAll: true,
		liveEnd: true,
		liveGuardBuy: false,
		superchat: false,
		wordcloud: true,
		liveSummary: true,
		...patch,
	};
}

describe("flatSubToSubscription — 用户手填 UP 昵称写入 Subscription.name", () => {
	it("普通配置的 name 写入 sub.name,uid 归一化与订阅 id 保持一致", () => {
		const registry = makeRegistry();
		const sub = flatSubToSubscription(
			makeFlatSub({ name: "  Asaki大人  ", uid: "194484313,999" }),
			// biome-ignore lint/suspicious/noExplicitAny: TargetRegistry 测试替身
			registry as any,
		);

		expect(sub.uid).toBe("194484313");
		expect(sub.name).toBe("Asaki大人");
	});

	it("name 为空或等于 uid 时不写入,渲染层自然回退 uid", () => {
		const registry = makeRegistry();
		const blank = flatSubToSubscription(
			makeFlatSub({ name: "   " }),
			// biome-ignore lint/suspicious/noExplicitAny: TargetRegistry 测试替身
			registry as any,
		);
		const sameAsUid = flatSubToSubscription(
			makeFlatSub({ name: "194484313" }),
			// biome-ignore lint/suspicious/noExplicitAny: TargetRegistry 测试替身
			registry as any,
		);

		expect(blank.name).toBeUndefined();
		expect(sameAsUid.name).toBeUndefined();
	});
});
