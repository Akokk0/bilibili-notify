/**
 * 单元测试 — `createTargetDispatcher`(独立端 TargetDispatcher 的 targetId → adapter 路由核心)。
 *
 * 守护契约:
 *   - 构造期 adapter.platforms → adapter 注册表;同一 platform 被两个 adapter 声明 → warn + 后者覆盖
 *   - resolve(targetId)            → PushTarget | undefined
 *   - isAvailable                  → target 缺 / Connection 缺 / platformAdapter 缺 任一为 false;否则透传
 *   - send / sendPrivate(dispatch) → 四条分支:target 缺(早退,不触发 onDelivery)/
 *                                    Connection 缺(warn + onDelivery)/ platformAdapter 缺(warn + onDelivery)/
 *                                    happy(委派 platformAdapter.send + onDelivery,private 透传)
 *   - probeConnection                 → adapter 缺 / platformAdapter 缺 / happy 委派 platformAdapter.probe
 *
 * 纯单元:ConfigStore / PlatformAdapter / Logger 全部用最小 fake,无任何 I/O。
 */

import type {
	Connection,
	DeliveryResult,
	Logger,
	NotificationPayload,
	PlatformAdapter,
	ProbeResult,
	PushTarget,
} from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, type Mock, vi } from "vite-plus/test";
import type { ConfigStore } from "../../config/store.js";
import { createPlatformAdapterRegistry } from "../registry.js";
import { createTargetDispatcher } from "../target-dispatcher.js";

const PAYLOAD: NotificationPayload = { kind: "text", text: "hi" };

// Test fakes use a deliberately loose `platform` (e.g. "telegram") to exercise
// the "no platform adapter" branch, so we bypass the strict union via `unknown`.
function makeConnection(
	over: { id: string; platform: string } & Record<string, unknown>,
): Connection {
	return {
		name: `adapter-${over.id}`,
		enabled: true,
		// 盘上的连接一定带 `kind`(迁移补的);夹具漏了它,按 kind 分岔的读点会当它不是直连。
		kind: "direct",
		config: { url: "https://example.com/hook", headers: {} },
		...over,
	} as unknown as Connection;
}

function makeTarget(
	over: { id: string; connectionId: string } & Record<string, unknown>,
): PushTarget {
	return {
		name: `target-${over.id}`,
		platform: "feishu",
		scope: "group",
		enabled: true,
		session: {},
		...over,
	} as unknown as PushTarget;
}

function makeStore(connections: Connection[], targets: PushTarget[]): ConfigStore {
	return {
		getConnections: () => connections,
		getTargets: () => targets,
	} as unknown as ConfigStore;
}

type LogFn = (msg: string, ...args: unknown[]) => void;
function makeLogger(): Logger & { warn: Mock<LogFn> } {
	return {
		info: vi.fn<LogFn>(),
		warn: vi.fn<LogFn>(),
		error: vi.fn<LogFn>(),
		debug: vi.fn<LogFn>(),
	} as unknown as Logger & { warn: Mock<LogFn> };
}

function makePlatformAdapter(
	platforms: string[],
	over: Partial<PlatformAdapter> = {},
): PlatformAdapter {
	const sendResult: DeliveryResult = { ok: true, latencyMs: 12 };
	const probeResult: ProbeResult = { ok: true, latencyMs: 8 };
	return {
		platforms,
		isAvailable: vi.fn(() => true),
		send: vi.fn(async () => sendResult),
		probe: vi.fn(async () => probeResult),
		...over,
	};
}

describe("createTargetDispatcher — adapter 注册表", () => {
	it("一个 adapter 声明多 platform:全部进表", () => {
		const pa = makePlatformAdapter(["onebot", "feishu"]);
		const dispatcher = createTargetDispatcher({
			store: makeStore(
				[makeConnection({ id: "a1", platform: "onebot" })],
				[makeTarget({ id: "t1", connectionId: "a1", platform: "onebot" })],
			),
			adapters: createPlatformAdapterRegistry([pa]),
			logger: makeLogger(),
		});
		expect(dispatcher.isAvailable("t1")).toBe(true);
	});

	it("同一 platform 被两个 adapter 声明 → **注册那一步就抛**,轮不到这一层", () => {
		// 从前这里是「warn 一行 + 后者覆盖」。悄悄顶掉意味着推送全走了另一个实现,
		// 而两边都不报错 —— 现在这道门挪进了注册表,而且从「提醒」变成了「拒绝」。
		const first = makePlatformAdapter(["feishu"], { isAvailable: vi.fn(() => false) });
		const second = makePlatformAdapter(["feishu"], { isAvailable: vi.fn(() => true) });
		expect(() => createPlatformAdapterRegistry([first, second])).toThrow(/feishu/);
	});
});

describe("createTargetDispatcher — resolve / isAvailable", () => {
	it("resolve:命中返回 target,未命中 undefined", () => {
		const target = makeTarget({ id: "t1", connectionId: "a1" });
		const dispatcher = createTargetDispatcher({
			store: makeStore([makeConnection({ id: "a1", platform: "feishu" })], [target]),
			adapters: createPlatformAdapterRegistry([makePlatformAdapter(["feishu"])]),
			logger: makeLogger(),
		});
		expect(dispatcher.resolve("t1")).toBe(target);
		expect(dispatcher.resolve("nope")).toBeUndefined();
	});

	it("isAvailable:target 缺 / Connection 缺 / platformAdapter 缺 → false", () => {
		const targetNoConnection = makeTarget({ id: "t1", connectionId: "ghost" });
		const targetNoPA = makeTarget({ id: "t2", connectionId: "a2" });
		const dispatcher = createTargetDispatcher({
			store: makeStore(
				[makeConnection({ id: "a2", platform: "telegram" })],
				[targetNoConnection, targetNoPA],
			),
			adapters: createPlatformAdapterRegistry([makePlatformAdapter(["feishu"])]),
			logger: makeLogger(),
		});
		expect(dispatcher.isAvailable("missing")).toBe(false); // target 缺
		expect(dispatcher.isAvailable("t1")).toBe(false); // connectionId 指向不存在的 adapter
		expect(dispatcher.isAvailable("t2")).toBe(false); // connection.platform 无对应 platformAdapter
	});

	it("isAvailable:链路齐全时透传 platformAdapter.isAvailable", () => {
		const paFalse = makePlatformAdapter(["feishu"], { isAvailable: vi.fn(() => false) });
		const dispatcher = createTargetDispatcher({
			store: makeStore(
				[makeConnection({ id: "a1", platform: "feishu" })],
				[makeTarget({ id: "t1", connectionId: "a1" })],
			),
			adapters: createPlatformAdapterRegistry([paFalse]),
			logger: makeLogger(),
		});
		expect(dispatcher.isAvailable("t1")).toBe(false);
		expect(paFalse.isAvailable).toHaveBeenCalledTimes(1);
	});
});

type OnDeliveryFn = (
	target: PushTarget,
	payload: NotificationPayload,
	result: DeliveryResult,
	opts: { private: boolean },
) => void;
describe("createTargetDispatcher — dispatch (send / sendPrivate)", () => {
	let onDelivery: Mock<OnDeliveryFn>;
	beforeEach(() => {
		onDelivery = vi.fn<OnDeliveryFn>();
	});

	it("target 缺:返回 target not found,不触发 onDelivery", async () => {
		const dispatcher = createTargetDispatcher({
			store: makeStore([], []),
			adapters: createPlatformAdapterRegistry([makePlatformAdapter(["feishu"])]),
			logger: makeLogger(),
			onDelivery,
		});
		const r = await dispatcher.send("ghost", PAYLOAD);
		expect(r).toEqual({ ok: false, latencyMs: 0, err: "target not found" });
		expect(onDelivery).not.toHaveBeenCalled();
	});

	it("Connection 缺:返回带 connectionId 的错误 + warn + onDelivery", async () => {
		const logger = makeLogger();
		const dispatcher = createTargetDispatcher({
			store: makeStore([], [makeTarget({ id: "t1", connectionId: "ghost" })]),
			adapters: createPlatformAdapterRegistry([makePlatformAdapter(["feishu"])]),
			logger,
			onDelivery,
		});
		const r = await dispatcher.send("t1", PAYLOAD);
		expect(r.ok).toBe(false);
		expect(r.err).toBe("connection not found: connectionId=ghost");
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("connection not found"));
		expect(onDelivery).toHaveBeenCalledTimes(1);
	});

	it("platformAdapter 缺:返回 no platform adapter + warn + onDelivery", async () => {
		const logger = makeLogger();
		const dispatcher = createTargetDispatcher({
			store: makeStore(
				[makeConnection({ id: "a1", platform: "telegram" })],
				[makeTarget({ id: "t1", connectionId: "a1", platform: "telegram" })],
			),
			adapters: createPlatformAdapterRegistry([makePlatformAdapter(["feishu"])]),
			logger,
			onDelivery,
		});
		const r = await dispatcher.send("t1", PAYLOAD);
		expect(r.ok).toBe(false);
		expect(r.err).toBe("no platform adapter for telegram");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("no platform adapter for telegram"),
		);
		expect(onDelivery).toHaveBeenCalledTimes(1);
	});

	it("happy:委派 platformAdapter.send(opts 留空),回传其 result,onDelivery 带 {private:false}", async () => {
		// adapter 不传 `private: false` —— 否则 OneBot adapter 内 `?? scope` 会把
		// scope:"private" 的 target 吃掉(回归守卫见 platforms/__tests__/adapters.test.ts)。
		// onDelivery 仍带 `{ private: false }` 作为 metadata,与 sendPrivate 区分。
		const target = makeTarget({ id: "t1", connectionId: "a1" });
		const connection = makeConnection({ id: "a1", platform: "feishu" });
		const pa = makePlatformAdapter(["feishu"]);
		const dispatcher = createTargetDispatcher({
			store: makeStore([connection], [target]),
			adapters: createPlatformAdapterRegistry([pa]),
			logger: makeLogger(),
			onDelivery,
		});
		const r = await dispatcher.send("t1", PAYLOAD);
		expect(r).toEqual({ ok: true, latencyMs: 12 });
		expect(pa.send).toHaveBeenCalledWith(connection, target, PAYLOAD, {});
		expect(onDelivery).toHaveBeenCalledWith(target, PAYLOAD, r, { private: false });
	});

	it("sendPrivate:private:true 透传到 platformAdapter.send 与 onDelivery", async () => {
		const target = makeTarget({ id: "t1", connectionId: "a1" });
		const connection = makeConnection({ id: "a1", platform: "feishu" });
		const pa = makePlatformAdapter(["feishu"]);
		const dispatcher = createTargetDispatcher({
			store: makeStore([connection], [target]),
			adapters: createPlatformAdapterRegistry([pa]),
			logger: makeLogger(),
			onDelivery,
		});
		await dispatcher.sendPrivate("t1", PAYLOAD);
		expect(pa.send).toHaveBeenCalledWith(connection, target, PAYLOAD, { private: true });
		expect(onDelivery).toHaveBeenCalledWith(
			target,
			PAYLOAD,
			expect.objectContaining({ ok: true }),
			{ private: true },
		);
	});
});

describe("createTargetDispatcher — probeConnection", () => {
	it("连接缺:connection not found", async () => {
		const dispatcher = createTargetDispatcher({
			store: makeStore([], []),
			adapters: createPlatformAdapterRegistry([makePlatformAdapter(["feishu"])]),
			logger: makeLogger(),
		});
		expect(await dispatcher.probeConnection("ghost")).toEqual({
			ok: false,
			latencyMs: 0,
			err: "connection not found",
		});
	});

	it("platformAdapter 缺:no platform adapter for <platform>", async () => {
		const dispatcher = createTargetDispatcher({
			store: makeStore([makeConnection({ id: "a1", platform: "telegram" })], []),
			adapters: createPlatformAdapterRegistry([makePlatformAdapter(["feishu"])]),
			logger: makeLogger(),
		});
		expect(await dispatcher.probeConnection("a1")).toEqual({
			ok: false,
			latencyMs: 0,
			err: "no platform adapter for telegram",
		});
	});

	it("happy:委派 platformAdapter.probe(adapter) 并回传其 ProbeResult", async () => {
		const connection = makeConnection({ id: "a1", platform: "feishu" });
		const pa = makePlatformAdapter(["feishu"], {
			probe: vi.fn(async () => ({ ok: null as boolean | null, latencyMs: 0 })),
		});
		const dispatcher = createTargetDispatcher({
			store: makeStore([connection], []),
			adapters: createPlatformAdapterRegistry([pa]),
			logger: makeLogger(),
		});
		const r = await dispatcher.probeConnection("a1");
		expect(pa.probe).toHaveBeenCalledWith(connection);
		expect(r).toEqual({ ok: null, latencyMs: 0 });
	});
});

describe("isEnabled — 配置层面能不能推(与运行时健康 isAvailable 分开)", () => {
	function dispatcherWith(connections: Connection[], targets: PushTarget[]) {
		return createTargetDispatcher({
			store: makeStore(connections, targets),
			adapters: createPlatformAdapterRegistry([
				makePlatformAdapter(["feishu"], { isAvailable: vi.fn(() => false) }),
			]),
			logger: makeLogger(),
		});
	}

	it("目标启用、连接启用 → true,哪怕此刻不可达", () => {
		const dispatcher = dispatcherWith(
			[makeConnection({ id: "a1", platform: "feishu" })],
			[makeTarget({ id: "t1", connectionId: "a1" })],
		);
		expect(dispatcher.isEnabled("t1")).toBe(true);
		expect(dispatcher.isAvailable("t1")).toBe(false);
	});

	it("目标停用 → false", () => {
		const dispatcher = dispatcherWith(
			[makeConnection({ id: "a1", platform: "feishu" })],
			[makeTarget({ id: "t1", connectionId: "a1", enabled: false })],
		);
		expect(dispatcher.isEnabled("t1")).toBe(false);
	});

	it("所属连接停用 → false", () => {
		const dispatcher = dispatcherWith(
			[makeConnection({ id: "a1", platform: "feishu", enabled: false })],
			[makeTarget({ id: "t1", connectionId: "a1" })],
		);
		expect(dispatcher.isEnabled("t1")).toBe(false);
	});

	it("目标不存在 / 连接不存在 → false", () => {
		const dispatcher = dispatcherWith([], [makeTarget({ id: "t1", connectionId: "gone" })]);
		expect(dispatcher.isEnabled("t1")).toBe(false);
		expect(dispatcher.isEnabled("nope")).toBe(false);
	});
});

/**
 * 平台能力(能不能签小程序卡)从 platform adapter 透出来:连接缺、平台实现缺、平台没有
 * 能力概念(没实现 capabilities)都是 undefined —— 调用方按「什么都不支持」处理。
 */
describe("createTargetDispatcher — connectionCapabilities / probeConnectionCapabilities", () => {
	const CAPS = { miniAppCard: { state: "supported" as const, checkedAt: 1 } };

	it("委派给平台实现的 capabilities / probeCapabilities,把 Connection 递过去", async () => {
		const capabilities = vi.fn(() => CAPS);
		const probeCapabilities = vi.fn(async () => CAPS);
		const pa = makePlatformAdapter(["onebot"], { capabilities, probeCapabilities });
		const connection = makeConnection({ id: "a1", platform: "onebot" });
		const dispatcher = createTargetDispatcher({
			store: makeStore([connection], []),
			adapters: createPlatformAdapterRegistry([pa]),
			logger: makeLogger(),
		});
		expect(dispatcher.connectionCapabilities("a1")).toEqual(CAPS);
		expect(capabilities).toHaveBeenCalledWith(connection);
		expect(await dispatcher.probeConnectionCapabilities("a1")).toEqual(CAPS);
		expect(probeCapabilities).toHaveBeenCalledWith(connection);
	});

	it("连接缺 / 平台实现缺 / 平台没有能力概念 → undefined", async () => {
		const pa = makePlatformAdapter(["feishu"]);
		const dispatcher = createTargetDispatcher({
			store: makeStore(
				[
					makeConnection({ id: "w1", platform: "feishu" }),
					makeConnection({ id: "t1", platform: "telegram" }),
				],
				[],
			),
			adapters: createPlatformAdapterRegistry([pa]),
			logger: makeLogger(),
		});
		expect(dispatcher.connectionCapabilities("nope")).toBeUndefined();
		expect(dispatcher.connectionCapabilities("t1")).toBeUndefined();
		expect(dispatcher.connectionCapabilities("w1")).toBeUndefined();
		expect(await dispatcher.probeConnectionCapabilities("w1")).toBeUndefined();
	});
});
