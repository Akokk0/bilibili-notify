/**
 * 单元测试 — `createTargetDispatcher`(独立端 TargetDispatcher 的 targetId → adapter 路由核心)。
 *
 * 守护契约:
 *   - 构造期 adapter.adapterKey → adapter 注册表;同一个键被两个 adapter 声明 → warn + 后者覆盖
 *   - resolve(targetId)            → PushTarget | undefined
 *   - isAvailable                  → target 缺 / Connection 缺 / platformAdapter 缺 任一为 false;否则透传
 *   - send(dispatch)               → 四条分支:target 缺(早退,不触发 onDelivery)/
 *                                    Connection 缺(warn + onDelivery)/ platformAdapter 缺(warn + onDelivery)/
 *                                    happy(委派 platformAdapter.send + onDelivery)
 *   - probeConnection                 → adapter 缺 / platformAdapter 缺 / happy 委派 platformAdapter.probe
 *   - 自己造的失败的码(ADR-0026):目标 / 连接找不到 `not_found`,没有适配器 `unavailable`;
 *                                    适配器抛错算 bug,在这里接住 + error 日志:`send` 抛了回 `indeterminate`
 *                                    (可能已经发出去了),探测与列地址抛了回 `unavailable`
 *
 * 纯单元:ConfigStore / PlatformAdapter / Logger 全部用最小 fake,无任何 I/O。
 */

import type {
	Connection,
	ConnectionCapabilities,
	DeliveryResult,
	Logger,
	NotificationPayload,
	PlatformAdapter,
	ProbeResult,
	PushTarget,
} from "@bilibili-notify/internal";
import { fail, platformDescriptor } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, type Mock, vi } from "vite-plus/test";
import { z } from "zod";
import { registryOf } from "../../__tests__/support/adapter-ctx.js";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import type { ConfigStore } from "../../config/store.js";
import { createTargetDispatcher, type SendInterceptHandler } from "../target-dispatcher.js";

const PAYLOAD: NotificationPayload = { kind: "text", text: "hi" };

// Test fakes use a deliberately loose `platform` (e.g. "telegram") to exercise
// the "no platform adapter" branch, so we bypass the strict union via `unknown`.
function makeConnection(
	over: { id: string; platform: string } & Record<string, unknown>,
): Connection {
	return {
		name: `adapter-${over.id}`,
		enabled: true,
		// 认领它的适配器键:内置平台取注册表那一行,认不出的(桥借来的)就是平台名本身。
		adapterKey: platformDescriptor(over.platform)?.adapterKey ?? over.platform,
		platformSnapshot: snapshotFor(over.platform),
		settings: { url: "https://example.com/hook", headers: {} },
		...over,
	} as unknown as Connection;
}

function makeTarget(
	over: { id: string; connectionId: string } & Record<string, unknown>,
): PushTarget {
	return {
		name: `target-${over.id}`,
		scope: "group",
		enabled: true,
		session: {},
		...over,
	} as unknown as PushTarget;
}

function makeStore(connections: Connection[], targets: PushTarget[]): ConfigStore {
	return {
		getConnections: () => connections,
		getConnection: (id: string) => connections.find((c) => c.id === id),
		getTargets: () => targets,
	} as unknown as ConfigStore;
}

type LogFn = (msg: string, ...args: unknown[]) => void;
function makeLogger(): Logger & { warn: Mock<LogFn>; error: Mock<LogFn> } {
	return {
		info: vi.fn<LogFn>(),
		warn: vi.fn<LogFn>(),
		error: vi.fn<LogFn>(),
		debug: vi.fn<LogFn>(),
	} as unknown as Logger & { warn: Mock<LogFn>; error: Mock<LogFn> };
}

function makePlatformAdapter(
	adapterKey: string,
	over: Partial<PlatformAdapter> = {},
): PlatformAdapter {
	const sendResult: DeliveryResult = { ok: true, latencyMs: 12 };
	const probeResult: ProbeResult = { ok: true, latencyMs: 8 };
	return {
		adapterKey,
		// 派发器按它解 settings 再递给适配器;测试里的适配器不挑设置形状。
		settingsSchema: z.unknown(),
		isAvailable: vi.fn(() => true),
		send: vi.fn(async () => sendResult),
		probe: vi.fn(async () => probeResult),
		listConnectionCandidates: async () => [],
		start: vi.fn(),
		stop: vi.fn(),
		...over,
	};
}

describe("createTargetDispatcher — adapter 注册表", () => {
	it("adapter 声明的键进表,连接按 adapterKey 找到它", () => {
		const pa = makePlatformAdapter("onebot");
		const dispatcher = createTargetDispatcher({
			store: makeStore(
				[makeConnection({ id: "a1", platform: "onebot" })],
				[makeTarget({ id: "t1", connectionId: "a1" })],
			),
			adapters: registryOf([pa]),
			logger: makeLogger(),
		});
		expect(dispatcher.isAvailable("t1")).toBe(true);
	});

	it("同一个键被两个 adapter 声明 → **注册那一步就抛**,轮不到这一层", () => {
		// 从前这里是「warn 一行 + 后者覆盖」。悄悄顶掉意味着推送全走了另一个实现,
		// 而两边都不报错 —— 现在这道门挪进了注册表,而且从「提醒」变成了「拒绝」。
		const first = makePlatformAdapter("webhook", { isAvailable: vi.fn(() => false) });
		const second = makePlatformAdapter("webhook", { isAvailable: vi.fn(() => true) });
		expect(() => registryOf([first, second])).toThrow(/webhook/);
	});
});

describe("createTargetDispatcher — resolve / isAvailable", () => {
	it("resolve:命中返回 target,未命中 undefined", () => {
		const target = makeTarget({ id: "t1", connectionId: "a1" });
		const dispatcher = createTargetDispatcher({
			store: makeStore([makeConnection({ id: "a1", platform: "feishu" })], [target]),
			adapters: registryOf([makePlatformAdapter("webhook")]),
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
			adapters: registryOf([makePlatformAdapter("webhook")]),
			logger: makeLogger(),
		});
		expect(dispatcher.isAvailable("missing")).toBe(false); // target 缺
		expect(dispatcher.isAvailable("t1")).toBe(false); // connectionId 指向不存在的 adapter
		expect(dispatcher.isAvailable("t2")).toBe(false); // connection.platform 无对应 platformAdapter
	});

	it("isAvailable:链路齐全时透传 platformAdapter.isAvailable", () => {
		const paFalse = makePlatformAdapter("webhook", { isAvailable: vi.fn(() => false) });
		const dispatcher = createTargetDispatcher({
			store: makeStore(
				[makeConnection({ id: "a1", platform: "feishu" })],
				[makeTarget({ id: "t1", connectionId: "a1" })],
			),
			adapters: registryOf([paFalse]),
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
) => void;
describe("createTargetDispatcher — dispatch (send)", () => {
	let onDelivery: Mock<OnDeliveryFn>;
	beforeEach(() => {
		onDelivery = vi.fn<OnDeliveryFn>();
	});

	it("target 缺:返回 target not found,不触发 onDelivery", async () => {
		const dispatcher = createTargetDispatcher({
			store: makeStore([], []),
			adapters: registryOf([makePlatformAdapter("webhook")]),
			logger: makeLogger(),
			onDelivery,
		});
		const r = await dispatcher.send("ghost", PAYLOAD);
		expect(r).toEqual({ ok: false, code: "not_found", message: "target not found" });
		expect(onDelivery).not.toHaveBeenCalled();
	});

	it("Connection 缺:返回带 connectionId 的错误 + warn + onDelivery", async () => {
		const logger = makeLogger();
		const dispatcher = createTargetDispatcher({
			store: makeStore([], [makeTarget({ id: "t1", connectionId: "ghost" })]),
			adapters: registryOf([makePlatformAdapter("webhook")]),
			logger,
			onDelivery,
		});
		const r = await dispatcher.send("t1", PAYLOAD);
		expect(r).toEqual({
			ok: false,
			code: "not_found",
			message: "connection not found: connectionId=ghost",
		});
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("connection not found"));
		expect(onDelivery).toHaveBeenCalledTimes(1);
		expect(onDelivery.mock.calls[0]?.[2]).toBe(r);
	});

	it("platformAdapter 缺:返回 no platform adapter + warn + onDelivery", async () => {
		const logger = makeLogger();
		const dispatcher = createTargetDispatcher({
			store: makeStore(
				[makeConnection({ id: "a1", platform: "telegram" })],
				[makeTarget({ id: "t1", connectionId: "a1" })],
			),
			adapters: registryOf([makePlatformAdapter("webhook")]),
			logger,
			onDelivery,
		});
		const r = await dispatcher.send("t1", PAYLOAD);
		// 拓展可能晚到(热装载):等一会儿可能就好,所以是 unavailable。
		expect(r).toEqual({
			ok: false,
			code: "unavailable",
			message: "no platform adapter for telegram",
		});
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("no platform adapter for telegram"),
		);
		expect(onDelivery).toHaveBeenCalledTimes(1);
	});

	it("happy:委派 platformAdapter.send(只带连接、去向、载荷),回传其 result,onDelivery 带同一份 result", async () => {
		const target = makeTarget({ id: "t1", connectionId: "a1" });
		const connection = makeConnection({ id: "a1", platform: "feishu" });
		const pa = makePlatformAdapter("webhook");
		const dispatcher = createTargetDispatcher({
			store: makeStore([connection], [target]),
			adapters: registryOf([pa]),
			logger: makeLogger(),
			onDelivery,
		});
		const r = await dispatcher.send("t1", PAYLOAD);
		expect(r).toEqual({ ok: true, latencyMs: 12 });
		expect(pa.send).toHaveBeenCalledWith(
			connection,
			{ kind: "session", scope: "group", address: undefined, parentAddress: undefined },
			PAYLOAD,
		);
		expect(onDelivery).toHaveBeenCalledWith(target, PAYLOAD, r);
	});

	it("没有「强制私聊」那条路了:派发器上没有 sendPrivate", () => {
		const dispatcher = createTargetDispatcher({
			store: makeStore([], []),
			adapters: registryOf([]),
			logger: makeLogger(),
		});
		expect("sendPrivate" in dispatcher).toBe(false);
	});
});

describe("createTargetDispatcher — 适配器抛错算 bug,在边界接住", () => {
	it("send 抛错 → indeterminate(帧可能已经出去了,不能让人重发)+ error 日志,onDelivery 照样收到这条失败", async () => {
		const logger = makeLogger();
		const onDelivery = vi.fn<OnDeliveryFn>();
		const target = makeTarget({ id: "t1", connectionId: "a1" });
		const pa = makePlatformAdapter("webhook", {
			send: vi.fn(async () => {
				throw new Error("adapter exploded");
			}),
		});
		const dispatcher = createTargetDispatcher({
			store: makeStore([makeConnection({ id: "a1", platform: "feishu" })], [target]),
			adapters: registryOf([pa]),
			logger,
			onDelivery,
		});
		const r = await dispatcher.send("t1", PAYLOAD);
		expect(r).toEqual({ ok: false, code: "indeterminate", message: "adapter exploded" });
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("adapter exploded"));
		expect(onDelivery).toHaveBeenCalledWith(target, PAYLOAD, r);
	});

	it("probe 抛错 → unavailable + error 日志", async () => {
		const logger = makeLogger();
		const pa = makePlatformAdapter("webhook", {
			probe: vi.fn(async () => {
				throw new Error("probe exploded");
			}),
		});
		const dispatcher = createTargetDispatcher({
			store: makeStore([makeConnection({ id: "a1", platform: "feishu" })], []),
			adapters: registryOf([pa]),
			logger,
		});
		expect(await dispatcher.probeConnection("a1")).toEqual({
			ok: false,
			code: "unavailable",
			message: "probe exploded",
		});
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("probe exploded"));
	});

	it("适配器回的失败原样透出(码与 upstreamCode 不动)", async () => {
		const failure = fail("rate_limited", "慢点", { upstreamCode: 22009 });
		const pa = makePlatformAdapter("webhook", { send: vi.fn(async () => failure) });
		const dispatcher = createTargetDispatcher({
			store: makeStore(
				[makeConnection({ id: "a1", platform: "feishu" })],
				[makeTarget({ id: "t1", connectionId: "a1" })],
			),
			adapters: registryOf([pa]),
			logger: makeLogger(),
		});
		expect(await dispatcher.send("t1", PAYLOAD)).toBe(failure);
	});
});

describe("createTargetDispatcher — probeConnection", () => {
	it("连接缺:connection not found", async () => {
		const dispatcher = createTargetDispatcher({
			store: makeStore([], []),
			adapters: registryOf([makePlatformAdapter("webhook")]),
			logger: makeLogger(),
		});
		expect(await dispatcher.probeConnection("ghost")).toEqual({
			ok: false,
			code: "not_found",
			message: "connection not found",
		});
	});

	it("platformAdapter 缺:no platform adapter for <platform>", async () => {
		const dispatcher = createTargetDispatcher({
			store: makeStore([makeConnection({ id: "a1", platform: "telegram" })], []),
			adapters: registryOf([makePlatformAdapter("webhook")]),
			logger: makeLogger(),
		});
		expect(await dispatcher.probeConnection("a1")).toEqual({
			ok: false,
			code: "unavailable",
			message: "no platform adapter for telegram",
		});
	});

	it("happy:委派 platformAdapter.probe(adapter) 并回传其 ProbeResult", async () => {
		const connection = makeConnection({ id: "a1", platform: "feishu" });
		// 没有探测协议的适配器回 unsupported:原样透出,由调用方决定不改连接状态。
		const unsupported = fail("unsupported", "no probe");
		const pa = makePlatformAdapter("webhook", { probe: vi.fn(async () => unsupported) });
		const dispatcher = createTargetDispatcher({
			store: makeStore([connection], []),
			adapters: registryOf([pa]),
			logger: makeLogger(),
		});
		const r = await dispatcher.probeConnection("a1");
		expect(pa.probe).toHaveBeenCalledWith(connection);
		expect(r).toBe(unsupported);
	});
});

describe("createTargetDispatcher — listAddressCandidates(挑地址)", () => {
	const SIGNAL = new AbortController().signal;
	const FOUND = { ok: true, candidates: [{ address: "G1", name: "群甲" }] } as const;

	function dispatcherOf(connections: Connection[], pa: PlatformAdapter) {
		return createTargetDispatcher({
			store: makeStore(connections, []),
			adapters: registryOf([pa]),
			logger: makeLogger(),
		});
	}

	it("连接不在:not_found", async () => {
		const dispatcher = dispatcherOf([], makePlatformAdapter("qq-official"));
		expect(await dispatcher.listAddressCandidates("ghost", "group", SIGNAL)).toEqual({
			ok: false,
			code: "not_found",
			message: "connection not found",
		});
	});

	it("适配器不在:unavailable", async () => {
		const dispatcher = dispatcherOf(
			[makeConnection({ id: "a1", platform: "telegram" })],
			makePlatformAdapter("qq-official"),
		);
		expect(await dispatcher.listAddressCandidates("a1", "group", SIGNAL)).toMatchObject({
			ok: false,
			code: "unavailable",
		});
	});

	it("设置不合法:not_configured,适配器没被调到", async () => {
		const listAddressCandidates = vi.fn(async () => FOUND);
		const dispatcher = dispatcherOf(
			[makeConnection({ id: "a1", platform: "qq-official" })],
			makePlatformAdapter("qq-official", {
				settingsSchema: z.object({ appId: z.string() }),
				listAddressCandidates,
			}),
		);
		expect(await dispatcher.listAddressCandidates("a1", "group", SIGNAL)).toMatchObject({
			ok: false,
			code: "not_configured",
		});
		expect(listAddressCandidates).not.toHaveBeenCalled();
	});

	it("适配器没有这个成员:unsupported", async () => {
		const dispatcher = dispatcherOf(
			[makeConnection({ id: "a1", platform: "onebot" })],
			makePlatformAdapter("onebot"),
		);
		expect(await dispatcher.listAddressCandidates("a1", "group", SIGNAL)).toEqual({
			ok: false,
			code: "unsupported",
			message: "这种连接没有可列的地址",
		});
	});

	it("成功:原样回适配器给的候选,连接 / scope / signal 都递下去", async () => {
		const connection = makeConnection({ id: "a1", platform: "qq-official" });
		const listAddressCandidates = vi.fn(async () => FOUND);
		const dispatcher = dispatcherOf(
			[connection],
			makePlatformAdapter("qq-official", { listAddressCandidates }),
		);
		const r = await dispatcher.listAddressCandidates("a1", "channel", SIGNAL);
		expect(r).toBe(FOUND);
		expect(listAddressCandidates).toHaveBeenCalledWith(connection, "channel", SIGNAL);
	});

	it("停用的连接照样能列", async () => {
		const listAddressCandidates = vi.fn(async () => FOUND);
		const dispatcher = dispatcherOf(
			[makeConnection({ id: "a1", platform: "qq-official", enabled: false })],
			makePlatformAdapter("qq-official", { listAddressCandidates }),
		);
		expect(await dispatcher.listAddressCandidates("a1", "group", SIGNAL)).toBe(FOUND);
		expect(listAddressCandidates).toHaveBeenCalledTimes(1);
	});

	it("适配器抛错算 bug:接住 → unavailable", async () => {
		const dispatcher = dispatcherOf(
			[makeConnection({ id: "a1", platform: "qq-official" })],
			makePlatformAdapter("qq-official", {
				listAddressCandidates: vi.fn(async () => {
					throw new Error("boom");
				}),
			}),
		);
		expect(await dispatcher.listAddressCandidates("a1", "group", SIGNAL)).toEqual({
			ok: false,
			code: "unavailable",
			message: "boom",
		});
	});
});

describe("isEnabled — 配置层面能不能推(与运行时健康 isAvailable 分开)", () => {
	function dispatcherWith(connections: Connection[], targets: PushTarget[]) {
		return createTargetDispatcher({
			store: makeStore(connections, targets),
			adapters: registryOf([makePlatformAdapter("webhook", { isAvailable: vi.fn(() => false) })]),
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
	const CAPS: ConnectionCapabilities = {
		atAll: { state: "supported", checkedAt: 1 },
		inbound: { state: "supported", checkedAt: 1 },
		miniAppCard: { state: "supported", checkedAt: 1 },
	};

	it("委派给平台实现的 capabilities / probeCapabilities,把 Connection 递过去", async () => {
		const capabilities = vi.fn(() => CAPS);
		const probeCapabilities = vi.fn(async () => CAPS);
		const pa = makePlatformAdapter("onebot", { capabilities, probeCapabilities });
		const connection = makeConnection({ id: "a1", platform: "onebot" });
		const dispatcher = createTargetDispatcher({
			store: makeStore([connection], []),
			adapters: registryOf([pa]),
			logger: makeLogger(),
		});
		expect(dispatcher.connectionCapabilities("a1")).toEqual(CAPS);
		expect(capabilities).toHaveBeenCalledWith(connection);
		expect(await dispatcher.probeConnectionCapabilities("a1")).toEqual(CAPS);
		expect(probeCapabilities).toHaveBeenCalledWith(connection);
	});

	it("连接缺 / 平台实现缺 / 平台没有能力概念 → undefined", async () => {
		const pa = makePlatformAdapter("webhook");
		const dispatcher = createTargetDispatcher({
			store: makeStore(
				[
					makeConnection({ id: "w1", platform: "feishu" }),
					makeConnection({ id: "t1", platform: "telegram" }),
				],
				[],
			),
			adapters: registryOf([pa]),
			logger: makeLogger(),
		});
		expect(dispatcher.connectionCapabilities("nope")).toBeUndefined();
		expect(dispatcher.connectionCapabilities("t1")).toBeUndefined();
		expect(dispatcher.connectionCapabilities("w1")).toBeUndefined();
		expect(await dispatcher.probeConnectionCapabilities("w1")).toBeUndefined();
	});
});

describe("createTargetDispatcher — sendToAddress(不经目标表,按连接 + 会话坐标发)", () => {
	const SESSION = { scope: "group", address: "123456" } as const;
	const connection = makeConnection({ id: "a1", platform: "feishu" });

	function setup(over: { connection?: Connection; pa?: PlatformAdapter } = {}) {
		const pa = over.pa ?? makePlatformAdapter("webhook");
		const logger = makeLogger();
		const onDelivery = vi.fn<OnDeliveryFn>();
		const dispatcher = createTargetDispatcher({
			store: makeStore([over.connection ?? connection], []),
			adapters: registryOf([pa]),
			logger,
			onDelivery,
		});
		return { dispatcher, pa, logger, onDelivery };
	}

	it("正常:适配器收到 {kind:'session', scope, address},scope / address 取自会话坐标", async () => {
		const { dispatcher, pa } = setup();

		const r = await dispatcher.sendToAddress("a1", SESSION, PAYLOAD);

		expect(r).toEqual({ ok: true, latencyMs: 12 });
		expect(pa.send).toHaveBeenCalledTimes(1);
		expect(pa.send).toHaveBeenCalledWith(
			connection,
			{ kind: "session", scope: "group", address: "123456" },
			PAYLOAD,
		);
	});

	it("私聊坐标也照搬:scope 不被写死成 group", async () => {
		const { dispatcher, pa } = setup();
		await dispatcher.sendToAddress("a1", { scope: "private", address: "42" }, PAYLOAD);
		expect(pa.send).toHaveBeenCalledWith(
			connection,
			{ kind: "session", scope: "private", address: "42" },
			PAYLOAD,
		);
	});

	it("连接不存在 → not_found + warn(带 connectionId),不碰适配器", async () => {
		const { dispatcher, pa, logger } = setup();
		const r = await dispatcher.sendToAddress("ghost", SESSION, PAYLOAD);
		expect(r).toMatchObject({ ok: false, code: "not_found" });
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ghost"));
		expect(pa.send).not.toHaveBeenCalled();
	});

	it("连接被停用 → not_configured + warn(带 connectionId),不碰适配器", async () => {
		const { dispatcher, pa, logger } = setup({
			connection: makeConnection({ id: "a1", platform: "feishu", enabled: false }),
		});
		const r = await dispatcher.sendToAddress("a1", SESSION, PAYLOAD);
		expect(r).toMatchObject({ ok: false, code: "not_configured" });
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("a1"));
		expect(pa.send).not.toHaveBeenCalled();
	});

	it("没有适配器管这条连接 → unavailable + warn", async () => {
		const { dispatcher, logger } = setup({
			connection: makeConnection({ id: "a1", platform: "telegram" }),
		});
		const r = await dispatcher.sendToAddress("a1", SESSION, PAYLOAD);
		expect(r).toEqual({
			ok: false,
			code: "unavailable",
			message: "no platform adapter for telegram",
		});
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("a1"));
	});

	it("适配器说不可达(isAvailable 假)→ unavailable + warn,不发", async () => {
		const pa = makePlatformAdapter("webhook", { isAvailable: vi.fn(() => false) });
		const { dispatcher, logger } = setup({ pa });
		const r = await dispatcher.sendToAddress("a1", SESSION, PAYLOAD);
		expect(r).toMatchObject({ ok: false, code: "unavailable" });
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("a1"));
		expect(pa.send).not.toHaveBeenCalled();
	});

	it("适配器抛错 → indeterminate + error 日志(同 send 那一条)", async () => {
		const pa = makePlatformAdapter("webhook", {
			send: vi.fn(async () => {
				throw new Error("adapter exploded");
			}),
		});
		const { dispatcher, logger } = setup({ pa });
		const r = await dispatcher.sendToAddress("a1", SESSION, PAYLOAD);
		expect(r).toEqual({ ok: false, code: "indeterminate", message: "adapter exploded" });
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("adapter exploded"));
	});

	it("不触发 onDelivery(临时目标不在表里,它会去写 reachability):成功与失败都不", async () => {
		const failing = makePlatformAdapter("webhook", {
			send: vi.fn(async () => fail("rate_limited", "slow down")),
		});
		const ok = setup();
		const bad = setup({ pa: failing });
		await ok.dispatcher.sendToAddress("a1", SESSION, PAYLOAD);
		await bad.dispatcher.sendToAddress("a1", SESSION, PAYLOAD);
		await ok.dispatcher.sendToAddress("ghost", SESSION, PAYLOAD);
		expect(ok.onDelivery).not.toHaveBeenCalled();
		expect(bad.onDelivery).not.toHaveBeenCalled();
	});
});

describe("createTargetDispatcher — interceptSend(出口咽喉的截流口,两条发送路共用)", () => {
	const target = makeTarget({ id: "t1", connectionId: "a1" });
	const connection = makeConnection({ id: "a1", platform: "feishu" });
	const SYNTHETIC: DeliveryResult = { ok: true, latencyMs: 0, isSynthetic: true };

	function setup(interceptSend: SendInterceptHandler) {
		const pa = makePlatformAdapter("webhook");
		const onDelivery = vi.fn<OnDeliveryFn>();
		const dispatcher = createTargetDispatcher({
			store: makeStore([connection], [target]),
			adapters: registryOf([pa]),
			logger: makeLogger(),
			interceptSend,
			onDelivery,
		});
		return { dispatcher, pa, onDelivery };
	}

	const paths: [string, (d: ReturnType<typeof setup>["dispatcher"]) => Promise<DeliveryResult>][] =
		[
			["send", (d) => d.send("t1", PAYLOAD)],
			["sendToAddress", (d) => d.sendToAddress("a1", { scope: "group", address: "9" }, PAYLOAD)],
		];

	it.each(paths)("%s:回了结果就用那个结果,不调适配器", async (_name, run) => {
		const { dispatcher, pa } = setup(() => SYNTHETIC);
		expect(await run(dispatcher)).toBe(SYNTHETIC);
		expect(pa.send).not.toHaveBeenCalled();
	});

	it.each(paths)("%s:回 undefined 就照常调适配器", async (_name, run) => {
		const { dispatcher, pa } = setup(() => undefined);
		expect(await run(dispatcher)).toEqual({ ok: true, latencyMs: 12 });
		expect(pa.send).toHaveBeenCalledTimes(1);
	});

	it("回调拿到的信息:连接、去向、目标(按会话坐标发的是 undefined)、载荷", async () => {
		const seen: Parameters<SendInterceptHandler>[0][] = [];
		const { dispatcher } = setup((send) => {
			seen.push(send);
			return undefined;
		});
		await dispatcher.send("t1", PAYLOAD);
		await dispatcher.sendToAddress("a1", { scope: "group", address: "9" }, PAYLOAD);
		expect(seen.map((s) => s.target)).toEqual([target, undefined]);
		expect(seen[0]).toMatchObject({ connection, target, payload: PAYLOAD });
		expect(seen[0]?.destination).toMatchObject({
			kind: "session",
			scope: (target as Extract<PushTarget, { kind: "session" }>).scope,
		});
		expect(seen[1]?.destination).toEqual({ kind: "session", scope: "group", address: "9" });
	});

	it("按目标发的两条路,截流时 onDelivery 行为照旧(带合成结果触发);按坐标发的不触发", async () => {
		const { dispatcher, onDelivery } = setup(() => SYNTHETIC);
		await dispatcher.send("t1", PAYLOAD);
		expect(onDelivery).toHaveBeenCalledWith(target, PAYLOAD, SYNTHETIC);
		await dispatcher.sendToAddress("a1", { scope: "group", address: "9" }, PAYLOAD);
		expect(onDelivery).toHaveBeenCalledTimes(1);
	});
});

/**
 * 3a-20a:开关与平台的检查只在派发器留一份,适配器的发送口只收窄类型 `DestinationRef`。
 * 下面用的假适配器**自己不做任何开关 / 平台检查**(`isAvailable` 恒真、`send` 记入参回成功)。
 */
describe("createTargetDispatcher — 检查收在派发器,适配器只收 DestinationRef", () => {
	const CONNECTION = makeConnection({ id: "a1", platform: "feishu" });

	function setup(connections: Connection[], targets: PushTarget[]) {
		const pa = makePlatformAdapter("webhook");
		const onDelivery = vi.fn<OnDeliveryFn>();
		const logger = makeLogger();
		const dispatcher = createTargetDispatcher({
			store: makeStore(connections, targets),
			adapters: registryOf([pa]),
			logger,
			onDelivery,
		});
		return { dispatcher, pa, onDelivery, logger };
	}

	it("目标停用:send 回 not_configured、不调适配器 send、onDelivery 照调;isAvailable 为假", async () => {
		const target = makeTarget({ id: "t1", connectionId: "a1", enabled: false });
		const { dispatcher, pa, onDelivery } = setup([CONNECTION], [target]);
		const r = await dispatcher.send("t1", PAYLOAD);
		expect(r).toMatchObject({ ok: false, code: "not_configured" });
		expect(pa.send).not.toHaveBeenCalled();
		expect(onDelivery).toHaveBeenCalledWith(target, PAYLOAD, r);
		expect(dispatcher.isAvailable("t1")).toBe(false);
		expect(pa.isAvailable).not.toHaveBeenCalled();
	});

	it("连接停用:send 回 not_configured、不调适配器 send、onDelivery 照调;isAvailable 为假", async () => {
		const target = makeTarget({ id: "t1", connectionId: "a1" });
		const off = makeConnection({ id: "a1", platform: "feishu", enabled: false });
		const { dispatcher, pa, onDelivery } = setup([off], [target]);
		const r = await dispatcher.send("t1", PAYLOAD);
		expect(r).toMatchObject({ ok: false, code: "not_configured" });
		expect(pa.send).not.toHaveBeenCalled();
		expect(onDelivery).toHaveBeenCalledWith(target, PAYLOAD, r);
		expect(dispatcher.isAvailable("t1")).toBe(false);
		expect(pa.isAvailable).not.toHaveBeenCalled();
	});

	it("经会话目标发送:适配器收到的是 {kind, scope, address, parentAddress?},没有 id / name / enabled / platform / connectionId", async () => {
		const target = makeTarget({
			id: "t1",
			connectionId: "a1",
			kind: "session",
			scope: "channel",
			address: "chan-1",
			parentAddress: "guild-9",
		});
		const { dispatcher, pa } = setup([CONNECTION], [target]);
		await dispatcher.send("t1", PAYLOAD);
		expect(pa.send).toHaveBeenCalledWith(
			CONNECTION,
			{ kind: "session", scope: "channel", address: "chan-1", parentAddress: "guild-9" },
			PAYLOAD,
		);
		const given = vi.mocked(pa.send).mock.calls[0]?.[1] as unknown as Record<string, unknown>;
		expect(Object.keys(given).sort()).toEqual(["address", "kind", "parentAddress", "scope"]);
		dispatcher.isAvailable("t1");
		expect(pa.isAvailable).toHaveBeenCalledWith(CONNECTION, {
			kind: "session",
			scope: "channel",
			address: "chan-1",
			parentAddress: "guild-9",
		});
	});

	it("经端点目标发送:适配器收到的是 {kind, id, name},只有这三格(端点目标没有 scope)", async () => {
		const target = makeTarget({ id: "t1", connectionId: "a1", kind: "endpoint", name: "钉钉群" });
		const { dispatcher, pa } = setup([CONNECTION], [target]);
		await dispatcher.send("t1", PAYLOAD);
		expect(pa.send).toHaveBeenCalledWith(
			CONNECTION,
			{ kind: "endpoint", id: "t1", name: "钉钉群" },
			PAYLOAD,
		);
		const given = vi.mocked(pa.send).mock.calls[0]?.[1] as unknown as Record<string, unknown>;
		expect(Object.keys(given).sort()).toEqual(["id", "kind", "name"]);
	});

	it("sendToAddress:适配器收到 {kind:'session', scope, address},截流回调的 target 是 undefined", async () => {
		const seen: Parameters<SendInterceptHandler>[0][] = [];
		const pa = makePlatformAdapter("webhook");
		const dispatcher = createTargetDispatcher({
			store: makeStore([CONNECTION], []),
			adapters: registryOf([pa]),
			logger: makeLogger(),
			interceptSend: (send) => {
				seen.push(send);
				return undefined;
			},
		});
		await dispatcher.sendToAddress("a1", { scope: "group", address: "123456" }, PAYLOAD);
		expect(pa.send).toHaveBeenCalledWith(
			CONNECTION,
			{ kind: "session", scope: "group", address: "123456" },
			PAYLOAD,
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.target).toBeUndefined();
		expect(seen[0]?.destination).toEqual({ kind: "session", scope: "group", address: "123456" });
	});
});

/**
 * 路由只问结论「这个目标能不能 @全体」,答案由这条连接的适配器给:三态里「不支持」才不发,
 * 「还不知道」(适配器答还不知道 / 没实现 capabilities / 没有适配器)一律发 —— 发错只是多一条消息。
 */
describe("createTargetDispatcher — supportsAtAll(问适配器)", () => {
	const supported = { state: "supported", checkedAt: 1 } as const;
	const unsupported = { state: "unsupported", reason: "不行", checkedAt: 1 } as const;
	const unknown = { state: "unknown" } as const;
	const capsWithAtAll = (atAll: ConnectionCapabilities["atAll"]): ConnectionCapabilities => ({
		atAll,
		inbound: unknown,
		miniAppCard: unknown,
	});

	function dispatcherOf(
		connections: readonly Connection[],
		targets: readonly PushTarget[],
		adapters: PlatformAdapter[],
	) {
		return createTargetDispatcher({
			store: makeStore([...connections], [...targets]),
			adapters: registryOf(adapters),
			logger: makeLogger(),
		});
	}
	const oneTarget = (platform: string, kind?: string) =>
		[
			[makeConnection({ id: "a1", platform, ...(kind ? { kind } : {}) })],
			[makeTarget({ id: "t1", connectionId: "a1" })],
		] as const;

	it("适配器答不支持 → false", () => {
		const [c, t] = oneTarget("onebot");
		const pa = makePlatformAdapter("onebot", { capabilities: () => capsWithAtAll(unsupported) });
		expect(dispatcherOf(c, t, [pa]).supportsAtAll("t1")).toBe(false);
	});

	it("适配器答支持 → true", () => {
		const [c, t] = oneTarget("onebot");
		const pa = makePlatformAdapter("onebot", { capabilities: () => capsWithAtAll(supported) });
		expect(dispatcherOf(c, t, [pa]).supportsAtAll("t1")).toBe(true);
	});

	it("适配器答还不知道 → true(试试看)", () => {
		const [c, t] = oneTarget("onebot");
		const pa = makePlatformAdapter("onebot", { capabilities: () => capsWithAtAll(unknown) });
		expect(dispatcherOf(c, t, [pa]).supportsAtAll("t1")).toBe(true);
	});

	it("适配器没实现 capabilities → true", () => {
		const [c, t] = oneTarget("onebot");
		expect(dispatcherOf(c, t, [makePlatformAdapter("onebot")]).supportsAtAll("t1")).toBe(true);
	});

	it("这条连接没有适配器管 → true(按还不知道算)", () => {
		const [c, t] = oneTarget("telegram", "extension");
		expect(dispatcherOf(c, t, [makePlatformAdapter("webhook")]).supportsAtAll("t1")).toBe(true);
	});

	it("问的是目标所挂那条连接的适配器,不看目标自己那一格", () => {
		const connections = [
			makeConnection({ id: "a-ob", platform: "onebot" }),
			makeConnection({ id: "a-qq", platform: "qq-official" }),
		];
		const targets = [
			makeTarget({ id: "t-ob", connectionId: "a-ob", platform: "qq-official" }),
			makeTarget({ id: "t-qq", connectionId: "a-qq", platform: "onebot" }),
		];
		const d = dispatcherOf(connections, targets, [
			makePlatformAdapter("onebot", { capabilities: () => capsWithAtAll(supported) }),
			makePlatformAdapter("qq-official", { capabilities: () => capsWithAtAll(unsupported) }),
		]);
		expect(d.supportsAtAll("t-ob")).toBe(true);
		expect(d.supportsAtAll("t-qq")).toBe(false);
	});

	it("目标不存在 → false", () => {
		const d = dispatcherOf([makeConnection({ id: "a1", platform: "onebot" })], [], []);
		expect(d.supportsAtAll("ghost")).toBe(false);
	});

	it("连接不存在 → false", () => {
		const d = dispatcherOf([], [makeTarget({ id: "t1", connectionId: "ghost" })], []);
		expect(d.supportsAtAll("t1")).toBe(false);
	});
});

/**
 * 连接表的读法:一次推送对一个目标要问好几处(`isAvailable` / `supportsAtAll` / `send`),
 * 每处都只要**目标所挂的那一条**。配置仓的「全表」那口每问一次就深拷整张连接表,所以只许按 id 取单条。
 */
describe("createTargetDispatcher — 连接按 id 取单条,不读全表", () => {
	// 验红:把 `findConnection` 或 `refusal` / `isEnabled` 里的检查改回读 `getConnections()`,这条红。
	it("一次推送走完 isAvailable / supportsAtAll / send:全表那口一次都不调", async () => {
		const connection = makeConnection({ id: "a1", platform: "onebot" });
		const target = makeTarget({ id: "t1", connectionId: "a1" });
		const getConnections = vi.fn(() => [connection]);
		const getConnection = vi.fn((id: string) => (id === "a1" ? connection : undefined));
		const dispatcher = createTargetDispatcher({
			store: {
				getConnections,
				getConnection,
				getTargets: () => [target],
			} as unknown as ConfigStore,
			adapters: registryOf([makePlatformAdapter("onebot")]),
			logger: makeLogger(),
		});
		expect(dispatcher.isEnabled("t1")).toBe(true);
		expect(dispatcher.isAvailable("t1")).toBe(true);
		dispatcher.supportsAtAll("t1");
		expect(await dispatcher.send("t1", { kind: "text", text: "hi" } as never)).toMatchObject({
			ok: true,
		});
		expect(getConnection).toHaveBeenCalled();
		expect(getConnections).not.toHaveBeenCalled();
	});

	it("连接停用的目标照样拒(开关的判断复用已经取到的那一条)", async () => {
		const connection = makeConnection({ id: "a1", platform: "onebot", enabled: false });
		const getConnections = vi.fn(() => [connection]);
		const dispatcher = createTargetDispatcher({
			store: {
				getConnections,
				getConnection: (id: string) => (id === "a1" ? connection : undefined),
				getTargets: () => [makeTarget({ id: "t1", connectionId: "a1" })],
			} as unknown as ConfigStore,
			adapters: registryOf([makePlatformAdapter("onebot")]),
			logger: makeLogger(),
		});
		expect(dispatcher.isEnabled("t1")).toBe(false);
		expect(await dispatcher.send("t1", { kind: "text", text: "hi" } as never)).toMatchObject({
			ok: false,
			code: "not_configured",
		});
		expect(getConnections).not.toHaveBeenCalled();
	});
});
