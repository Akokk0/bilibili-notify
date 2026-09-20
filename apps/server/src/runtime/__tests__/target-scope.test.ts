/**
 * 路由 + 目标启停的**快照表**(`target-scope.ts`)。
 *
 * 它存在的理由是钱:ConfigStore 的 `getSubscriptions` / `getTargets` / `getConnections`
 * 三个 getter 全是整份 `deepClone`,而人工重推那道闸要为**每一行**失败的历史各问一次。
 * 重推要解的场景(bot 离线一段时间)恰恰是「一整页全红」—— 面板一次拿 200 行,现问
 * 就是 600 份订阅 / 目标 / 连接副本,订阅里还装着 per-UP 的 templates / cardStyle / extras。
 *
 * 所以这里钉三件事:
 *   1. 答案与从前那两句现问的写法**一字不差**(先出现的订阅说了算、停用一律不算);
 *   2. 🔴 `targetEnabled` 与真 `sink.isEnabled` **对得上**(那是同一条判定的第二份手抄,
 *      `isEnabled` 将来多一个条件而这儿没跟上时,重推的闸会静默留在旧口径上);
 *   3. 问 N 次只折一次,而 `config-changed` 一来就重折(不失效 = 停用了目标还能补,
 *      失效得太勤 = 白付那 600 份副本)。
 */

import type {
	Connection,
	FeatureKey,
	Logger,
	PushTarget,
	Subscription,
} from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ConfigStore } from "../../config/store.js";
import { createAdapterRegistry } from "../../platforms/registry.js";
import { createMultiplexSink } from "../../sink/multiplex.js";
import { createNodeMessageBus } from "../message-bus.js";
import { createTargetScope, resolveTargetScope } from "../target-scope.js";

const CONN_ON = "11111111-1111-4111-8111-111111111111";
const CONN_OFF = "22222222-2222-4222-8222-222222222222";
const T_OK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T_PAUSED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T_ON_DEAD_CONN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T_ON_GHOST_CONN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T_UNKNOWN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function connection(id: string, enabled: boolean): Connection {
	return { id, name: id, enabled, kind: "direct", platform: "onebot", config: {} } as Connection;
}

function target(id: string, connectionId: string, enabled = true): PushTarget {
	return {
		id,
		name: id,
		connectionId,
		scope: "group",
		enabled,
		kind: "session",
		platform: "onebot",
		address: "1",
	} as PushTarget;
}

function sub(uid: string, routing: Partial<Record<FeatureKey, string[]>>): Subscription {
	return { uid, routing } as unknown as Subscription;
}

const CONNECTIONS = [connection(CONN_ON, true), connection(CONN_OFF, false)];
const TARGETS = [
	target(T_OK, CONN_ON),
	target(T_PAUSED, CONN_ON, false),
	target(T_ON_DEAD_CONN, CONN_OFF),
	target(T_ON_GHOST_CONN, "99999999-9999-4999-8999-999999999999"),
];

const logger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

describe("resolveTargetScope — 答案", () => {
	const table = resolveTargetScope({
		subscriptions: [sub("u1", { dynamic: [T_OK, T_PAUSED] }), sub("u1", { dynamic: [T_UNKNOWN] })],
		targets: TARGETS,
		connections: CONNECTIONS,
	});

	it("routedTargets:按 uid + 特性键查,没配过的键是空", () => {
		expect(table.routedTargets("u1", "dynamic")).toEqual([T_OK, T_PAUSED]);
		expect(table.routedTargets("u1", "live")).toEqual([]);
	});

	it("没有这条订阅 → 空(闸据此说「路由里把它去掉了」)", () => {
		expect(table.routedTargets("u404", "dynamic")).toEqual([]);
	});

	it("同一个 uid 两条订阅:先出现的那条说了算(照搬从前那句 find)", () => {
		expect(table.routedTargets("u1", "dynamic")).not.toContain(T_UNKNOWN);
	});

	it("targetEnabled:目标停用 / 连接停用 / 连接不存在 / 目标不存在,一律不算", () => {
		expect(table.targetEnabled(T_OK)).toBe(true);
		expect(table.targetEnabled(T_PAUSED)).toBe(false);
		expect(table.targetEnabled(T_ON_DEAD_CONN)).toBe(false);
		expect(table.targetEnabled(T_ON_GHOST_CONN)).toBe(false);
		expect(table.targetEnabled(T_UNKNOWN)).toBe(false);
	});
});

/**
 * 🔴 **同一条判定的两份实现,拿真的那份来对答案。**
 *
 * `NotificationSink.isEnabled`(`sink/multiplex.ts`)与这张表都在回答「这个目标现在还
 * 该不该收」。两边各写各的时,`isEnabled` 多一个条件不会让任何东西红 —— 重推的闸就
 * 静默留在旧口径上,症状是「面板说能补,发出去却被推送层自己挡了」(或者反过来)。
 *
 * 这条守卫把两边喂同一份配置、逐个目标对一遍。sink 的实现改了口径而这儿没跟上就红。
 */
describe("targetEnabled ≡ sink.isEnabled", () => {
	it("同一份配置下,逐个目标两边答案一样", () => {
		const store = {
			getTargets: () => TARGETS,
			getConnections: () => CONNECTIONS,
		} as unknown as ConfigStore;
		const sink = createMultiplexSink({
			store,
			adapters: createAdapterRegistry(),
			logger: logger(),
		});
		const table = resolveTargetScope({
			subscriptions: [],
			targets: TARGETS,
			connections: CONNECTIONS,
		});
		const ids = [...TARGETS.map((t) => t.id), T_UNKNOWN];
		expect(ids.map((id) => table.targetEnabled(id))).toEqual(ids.map((id) => sink.isEnabled(id)));
		// 全 true / 全 false 的矩阵对上了也说明不了什么 —— 确认这一把里两种答案都有。
		expect(new Set(ids.map((id) => sink.isEnabled(id)))).toEqual(new Set([true, false]));
	});
});

describe("createTargetScope — 什么时候重折", () => {
	let bus: ReturnType<typeof createNodeMessageBus>;
	let subscriptions: Subscription[];
	let targets: PushTarget[];
	let getSubscriptions: ReturnType<typeof vi.fn>;
	let getTargets: ReturnType<typeof vi.fn>;
	let getConnections: ReturnType<typeof vi.fn>;
	let scope: ReturnType<typeof createTargetScope>;

	beforeEach(() => {
		bus = createNodeMessageBus();
		subscriptions = [sub("u1", { dynamic: [T_OK] })];
		targets = [...TARGETS];
		getSubscriptions = vi.fn(() => subscriptions);
		getTargets = vi.fn(() => targets);
		getConnections = vi.fn(() => CONNECTIONS);
		scope = createTargetScope({
			configStore: { getSubscriptions, getTargets, getConnections } as unknown as ConfigStore,
			bus,
		});
	});

	it("一页 200 行各问一次闸 → 三个 getter 各只被问一次", () => {
		for (let i = 0; i < 200; i++) {
			scope.routedTargets("u1", "dynamic");
			scope.targetEnabled(T_OK);
		}
		expect(getSubscriptions).toHaveBeenCalledTimes(1);
		expect(getTargets).toHaveBeenCalledTimes(1);
		expect(getConnections).toHaveBeenCalledTimes(1);
	});

	it("一次都没人问 → 一份深拷贝都不要(而且建表时不能抢在 load 之前算)", () => {
		expect(getSubscriptions).not.toHaveBeenCalled();
		expect(getTargets).not.toHaveBeenCalled();
		expect(getConnections).not.toHaveBeenCalled();
	});

	it("config-changed:targets → 整张作废,答案跟着新配置变", () => {
		expect(scope.targetEnabled(T_OK)).toBe(true);
		targets = [target(T_OK, CONN_ON, false)];
		bus.emit("config-changed", "targets");
		expect(scope.targetEnabled(T_OK)).toBe(false);
		expect(getTargets).toHaveBeenCalledTimes(2);
	});

	it("config-changed:subscriptions → 路由跟着变", () => {
		expect(scope.routedTargets("u1", "dynamic")).toEqual([T_OK]);
		subscriptions = [sub("u1", { dynamic: [] })];
		bus.emit("config-changed", "subscriptions");
		expect(scope.routedTargets("u1", "dynamic")).toEqual([]);
	});

	it("config-changed:connections → 连接停用立刻算数", () => {
		expect(scope.targetEnabled(T_OK)).toBe(true);
		targets = [target(T_OK, CONN_OFF)];
		bus.emit("config-changed", "connections");
		expect(scope.targetEnabled(T_OK)).toBe(false);
	});

	it("config-changed:globals 不作废这张表(改个 AI 人设也重折就是白付那 600 份副本)", () => {
		scope.targetEnabled(T_OK);
		bus.emit("config-changed", "globals");
		scope.targetEnabled(T_OK);
		expect(getTargets).toHaveBeenCalledTimes(1);
	});

	it("dispose 之后不再跟着 config-changed 走", () => {
		scope.targetEnabled(T_OK);
		scope.dispose();
		bus.emit("config-changed", "targets");
		scope.targetEnabled(T_OK);
		expect(getTargets).toHaveBeenCalledTimes(1);
	});
});
