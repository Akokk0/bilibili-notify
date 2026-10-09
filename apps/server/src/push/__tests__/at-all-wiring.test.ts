/**
 * @全体 的接线:真派发器(`createTargetDispatcher`)+ 真推送路由(`PushRouter`)接在一起。
 *
 * `packages/push` 的假派发器 `supportsAtAll` 一律回 `true`,「QQ 官方机器人不单发 @全体」
 * 因而是两段各测各的 —— 路由那头问派发器、派发器那头按连接的平台答,中间这根线没人钉过。
 * 这里一条订阅同时路由到 OneBot 连接上的目标与 QQ 官方连接上的目标,@全体 默认开:
 * OneBot 那个收到单发的 @全体 再收本体,QQ 官方那个只收到本体。
 */

import {
	type Connection,
	FEATURE_KEYS,
	type GlobalDefaults,
	type Logger,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	type NotificationPayload,
	ok,
	type PlatformAdapter,
	type PushTarget,
	type ServiceContext,
	type Subscription,
	sameIdentity,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { PushRouter } from "@bilibili-notify/push";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it } from "vite-plus/test";
import { registryOf } from "../../__tests__/support/adapter-ctx.js";
import type { ConfigStore } from "../../config/store.js";
import { createTargetDispatcher } from "../target-dispatcher.js";

const LOGGER: Logger = { info() {}, warn() {}, error() {}, debug() {} };
const BODY: NotificationPayload = { kind: "text", text: "动态本体" };

function connection(id: string, platform: string): Connection {
	return {
		id,
		name: id,
		kind: "direct",
		connector: platform === "onebot" ? "http" : "ws",
		platform,
		enabled: true,
		config: {},
	} as unknown as Connection;
}

function target(id: string, connectionId: string): PushTarget {
	return {
		id,
		name: id,
		connectionId,
		kind: "session",
		scope: "group",
		enabled: true,
		address: "10001",
	} as unknown as PushTarget;
}

/** 记下每次 `send` 收到的 payload 的假适配器。 */
function recordingAdapter(adapterKey: string): {
	adapter: PlatformAdapter;
	payloads: NotificationPayload[];
} {
	const payloads: NotificationPayload[] = [];
	const adapter: PlatformAdapter = {
		adapterKey,
		isAvailable: () => true,
		send: async (_connection, _destination, payload) => {
			payloads.push(payload);
			return ok({ latencyMs: 1 });
		},
		probe: async () => ok({ latencyMs: 1 }),
		start() {},
		stop() {},
	};
	return { adapter, payloads };
}

function isAtAll(payload: NotificationPayload): boolean {
	return (
		payload.kind === "composite" && payload.segments.some((segment) => segment.kind === "at-all")
	);
}

function makeStore(subs: Subscription[]): SubscriptionStore {
	return {
		list: () => [...subs],
		findByIdentity: (identity) =>
			subs.find((s) => sameIdentity(subscriptionIdentityOf(s), identity)),
		findById: (id) => subs.find((s) => s.id === id),
		upsert: () => {},
		removeById: () => undefined,
		replaceAll: () => {},
	};
}

function openDefaults(): GlobalDefaults {
	const g = makeDefaultGlobalConfig();
	for (const k of FEATURE_KEYS) g.defaults.features[k] = true;
	g.defaults.schedule.quietHours = [];
	return g.defaults;
}

describe("@全体:真派发器 + 真推送路由", () => {
	it("同一条订阅路由到 OneBot 与 QQ 官方两个目标:OneBot 先收单发 @全体再收本体,QQ 官方只收本体", async () => {
		const onebot = recordingAdapter("onebot");
		const qq = recordingAdapter("qq-official");
		const connections = [connection("c-onebot", "onebot"), connection("c-qq", "qq-official")];
		const targets = [target("t-onebot", "c-onebot"), target("t-qq", "c-qq")];
		const dispatcher = createTargetDispatcher({
			store: {
				getConnections: () => connections,
				getTargets: () => targets,
			} as unknown as ConfigStore,
			adapters: registryOf([onebot.adapter, qq.adapter]),
			logger: LOGGER,
		});

		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "u1" },
		});
		sub.routing.post = ["t-onebot", "t-qq"];
		sub.overrides = { features: { extras: { atAllPost: true } } };

		const tracked: Promise<unknown>[] = [];
		const defaults = openDefaults();
		const serviceCtx = {
			logger: LOGGER,
			setInterval: () => ({ dispose() {} }),
			setTimeout: (fn: () => void, ms: number) => {
				const id = setTimeout(fn, ms);
				return { dispose: () => clearTimeout(id) };
			},
			onDispose: () => {},
			signal: new AbortController().signal,
			track: (task: Promise<unknown>) => void tracked.push(task),
		} as unknown as ServiceContext;
		const push = new PushRouter({
			dispatcher,
			store: makeStore([sub]),
			logger: LOGGER,
			serviceCtx,
			defaults: () => defaults,
			muted: () => false,
		});
		push.start();

		await push.push({
			subscriptionId: "s1",
			feature: "post",
			anchors: [{ role: "main", messages: [BODY] }],
		});
		await Promise.all(tracked);

		expect(onebot.payloads).toHaveLength(2);
		expect(isAtAll(onebot.payloads[0] as NotificationPayload)).toBe(true);
		expect(onebot.payloads[1]).toEqual(BODY);

		expect(qq.payloads).toEqual([BODY]);
		expect(qq.payloads.some(isAtAll)).toBe(false);
	});
});
