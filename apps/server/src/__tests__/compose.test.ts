/**
 * 🔴 **组装根 `compose.ts` 的接线要有自己的守卫。**
 *
 * 零件(开发场景、登记表)各自的测试全绿,证明不了 `compose.ts` 真用对了认领键、真只挑 B 站订阅、
 * 真没在门没开时提前调工厂 —— 这些剪断了,别的测试一条都不会红。这里用真的 `createBiliDevtools`
 * (测试进程里解析到的是真入口,换桩只挂在打包配置上)外面包一层 spy,逐条钉。
 */

import { BILIBILI_SOURCE_KEY } from "@bilibili-notify/internal";
import type { Subscription } from "@bilibili-notify/subscription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Api } from "../bilibili/api/index.js";
import { createBiliDevtools } from "../bilibili/devtools/index.js";
import type { DynamicEngine } from "../bilibili/dynamic/index.js";
import { observeLiveConnections } from "../bilibili/live/protocol/client.js";
import { composeBuiltinIntegrations } from "../compose.js";
import { overridableApi } from "../devtools/api-overrides.js";
import { createDevtoolsProviderRegistry } from "../devtools/providers.js";
import { createNodeMessageBus } from "../runtime/message-bus.js";

vi.mock("../bilibili/devtools/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../bilibili/devtools/index.js")>();
	return { ...actual, createBiliDevtools: vi.fn(actual.createBiliDevtools) };
});

function makeSub(
	sourceKey: string,
	externalId: string,
	over: { enabled?: boolean; specialUsers?: { uid: string }[] } = {},
): Subscription {
	return {
		id: `${sourceKey}-${externalId}`,
		identity: { sourceKey, externalId },
		enabled: over.enabled ?? true,
		specialUsers: over.specialUsers ?? [],
	} as unknown as Subscription;
}

function compose(opts: { subs?: Subscription[]; dynamic?: () => DynamicEngine | undefined } = {}) {
	const subs = opts.subs ?? [];
	return composeBuiltinIntegrations({
		api: overridableApi({} as Api),
		auth: overridableApi({ status: () => ({ status: 0, msg: "" }) }),
		bus: createNodeMessageBus(),
		subscriptions: { list: () => subs },
		subscriptionRuntime: {
			get: (id) =>
				id === "bilibili-100"
					? ({
							roomId: "5050",
							cachedProfile: { name: "甲", avatarUrl: "https://a/1.png" },
						} as never)
					: undefined,
		},
		dynamic: opts.dynamic ?? (() => undefined),
		live: () => undefined,
		fans: () => undefined,
		loginFlow: () => undefined,
	});
}

beforeEach(() => {
	vi.mocked(createBiliDevtools).mockClear();
});

afterEach(() => {
	// 工厂会装全局的直播连接观察钩子;测完摘掉,别漏给同进程里的别的测试。
	observeLiveConnections(null);
});

describe("composeBuiltinIntegrations · 开发场景", () => {
	it("认领用的是 B 站的来源键:汇总出来的场景 id 全带 bilibili. 前缀", () => {
		const providers = createDevtoolsProviderRegistry();
		compose().provideDevtools(providers);
		const ids = providers.scenarios().map((s) => s.id);
		expect(ids.length).toBeGreaterThan(0);
		expect(ids.every((id) => id.startsWith(`${BILIBILI_SOURCE_KEY}.`))).toBe(true);
	});

	it("挑订阅只留 B 站订阅,七个字段照旧", () => {
		const providers = createDevtoolsProviderRegistry();
		compose({
			subs: [
				makeSub("bilibili", "100", { specialUsers: [{ uid: "777" }] }),
				makeSub("e0000000-0000-4000-8000-000000000001", "x1"),
				makeSub("bilibili", "200", { enabled: false }),
			],
		}).provideDevtools(providers);
		const picked = vi.mocked(createBiliDevtools).mock.calls[0]?.[0].subs();
		expect(picked).toEqual([
			{
				id: "bilibili-100",
				uid: "100",
				name: "甲",
				enabled: true,
				roomId: "5050",
				specialUsers: ["777"],
				avatar: "https://a/1.png",
			},
			{
				id: "bilibili-200",
				uid: "200",
				name: "200",
				enabled: false,
				roomId: undefined,
				specialUsers: [],
				avatar: undefined,
			},
		]);
	});

	it("provideDevtools 没被调时,B 站的工厂一次都没被调(门没开的性质)", () => {
		compose();
		expect(createBiliDevtools).not.toHaveBeenCalled();
	});
});

describe("composeBuiltinIntegrations · bilibili 那一面", () => {
	it("bilibili.dynamic() 交回的就是入参 dynamic 给的那个,每次现取", () => {
		let engine: DynamicEngine | undefined;
		const builtins = compose({ dynamic: () => engine });
		expect(builtins.bilibili.dynamic()).toBeUndefined();
		engine = { lastFetchAt: () => 1 } as unknown as DynamicEngine;
		expect(builtins.bilibili.dynamic()).toBe(engine);
	});
});
