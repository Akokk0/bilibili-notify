/**
 * `createLiveRuntime` 的接线守卫:场次 / 推送 / 互动三处读直播设置的地方共用**同一个缓存读口**,
 * 不再各自 `(sub) => liveSettingsOf(sub, options.globals())`。
 *
 * 判据是 globals 的读取次数:`globals()` 每次都是整份深拷贝,互动上报又是每条弹幕一次。
 * 一条弹幕把所有设置折一遍的话,50 条就是 50 次深拷贝 —— 修前正是这样。
 */

import {
	fail,
	makeDefaultGlobalConfig,
	type ServiceContext,
	type Subscription,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createSourceGates } from "../../subscriptions/call-source.js";
import { createLiveRuntime } from "../live-runtime.js";
import { createLiveTable } from "../live-table.js";

const SUB: Subscription = makeExtensionSubscription({
	extensionId: "acme",
	externalId: "room-1",
});

function setup() {
	const bus = createNodeMessageBus();
	const globals = vi.fn(() => makeDefaultGlobalConfig());
	const runtime = createLiveRuntime({
		bus,
		serviceCtx: {
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			signal: new AbortController().signal,
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose() {},
			track() {},
		} as unknown as ServiceContext,
		table: createLiveTable({ bus }),
		subscriptionStore: {
			findById: (id) => (id === SUB.id ? SUB : undefined),
			list: () => [SUB],
		},
		subscriptionStateStore: { get: () => undefined },
		sources: { get: () => undefined },
		sourceGates: createSourceGates(),
		hasLiveStatus: () => false,
		sourceStatus: { running: () => true },
		labelDeps: { sources: { get: () => undefined } },
		globals,
		targetIds: () => [],
		commentary: null,
		imageRenderer: () => null,
		pickExistingCardBg: () => undefined,
		imageFetcher: { fetchImage: async () => fail("invalid", "这条守卫不抓图") },
		readImage: async () => undefined,
		sendFor: () => async () => {},
	});
	return { bus, globals, runtime };
}

describe("createLiveRuntime — 直播设置读口的接线", () => {
	it("连发 50 条 viewerChat,globals 至多读 1 次", () => {
		const { globals, runtime } = setup();
		// 构造时词云的停用词读了一次 globals;此后 50 条互动只该折一次设置。
		const before = globals.mock.calls.length;
		for (let i = 0; i < 50; i++) {
			runtime.applyInteraction(SUB.id, {
				kind: "viewerChat",
				viewer: { id: String(i), name: `观众${i}` },
				text: "来了",
			});
		}
		expect(globals.mock.calls.length - before).toBeLessThanOrEqual(1);
		runtime.dispose();
	});
});
