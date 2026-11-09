/**
 * 派发器把连接递给适配器之前,先按适配器的 `settingsSchema` 解 `settings`。
 *
 * 盘上存的是原文(不补默认值),适配器**不再自己解**、只认键 —— 所以递过去的必须是解过的:
 * 漏一个入口,症状是超时变成 `undefined`、重试次数 `NaN` 这类只在真机上才露的毛病。
 * 这里钉两件事:
 *   - 过不了规则的连接被隔离:发送回 `not_configured`、适配器没被调到;
 *   - 三个内置适配器,各用一条**只填了必填项**的连接经派发器发一次,适配器手上拿到的是规则里的默认值。
 */

import type {
	Connection,
	DeliveryResult,
	Logger,
	NotificationPayload,
	PlatformAdapter,
	PushTarget,
	ServiceContext,
} from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { registryOf } from "../../__tests__/support/adapter-ctx.js";
import { placeholderDescriptor } from "../../__tests__/support/adapter-descriptor.js";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import type { ConfigStore } from "../../config/store.js";
import { i18n } from "../../i18n/index.js";
import { createOnebotAdapter } from "../../platforms/onebot.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "../../platforms/qq-official.js";
import { createWebhookAdapter } from "../../platforms/webhook.js";
import { createTargetDispatcher } from "../target-dispatcher.js";

const PAYLOAD: NotificationPayload = { kind: "text", text: "hi" };
const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

afterEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

const logger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

function serviceCtx(): ServiceContext {
	return {
		logger: logger(),
		setTimeout(fn, ms) {
			const h = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(h) };
		},
		setInterval(fn, ms) {
			const h = setInterval(fn, ms);
			return { dispose: () => clearInterval(h) };
		},
		onDispose() {},
		signal: new AbortController().signal,
		track: () => {},
	};
}

function connectionOf(adapterKey: string, platform: string, settings: unknown): Connection {
	return {
		id: CONNECTION_ID,
		name: "连接",
		enabled: true,
		adapterKey,
		platform,
		settings,
		platformSnapshot: snapshotFor(platform),
	};
}

function targetFor(kind: "session" | "endpoint"): PushTarget {
	return kind === "endpoint"
		? { id: TARGET_ID, name: "端点", connectionId: CONNECTION_ID, enabled: true, kind: "endpoint" }
		: {
				id: TARGET_ID,
				name: "群",
				connectionId: CONNECTION_ID,
				enabled: true,
				kind: "session",
				scope: "group",
				address: "12345",
			};
}

function storeOf(connection: Connection, target: PushTarget): ConfigStore {
	return {
		getConnections: () => [connection],
		getConnection: (id: string) => [connection].find((c) => c.id === id),
		getTargets: () => [target],
	} as unknown as ConfigStore;
}

describe("被隔离的连接(settings 过不了适配器的规则)", () => {
	const schema = z.object({ url: z.string() });

	function setup() {
		const send = vi.fn(async (): Promise<DeliveryResult> => ({ ok: true, latencyMs: 1 }));
		const probe = vi.fn(async () => ({ ok: true as const, latencyMs: 1 }));
		const isAvailable = vi.fn(() => true);
		const adapter: PlatformAdapter = {
			adapterKey: "webhook",
			settingsSchema: schema,
			descriptor: placeholderDescriptor(),
			isAvailable,
			send,
			probe,
			listConnectionCandidates: async () => [],
			start() {},
			stop() {},
		};
		const dispatcher = createTargetDispatcher({
			store: storeOf(connectionOf("webhook", "generic", { url: 123 }), targetFor("endpoint")),
			adapters: registryOf([adapter]),
			logger: logger(),
		});
		return { dispatcher, send, probe, isAvailable };
	}

	it.each([
		["en", "Connection: Invalid settings: url: Invalid input: expected string, received number"],
		["ja", "接続の設定が無効です：url：Invalid input: expected string, received number"],
		["zh-TW", "連線設定無效：url：Invalid input: expected string, received number"],
	] as const)("%s:隔离原因及路径标点本地化,原始校验原因不翻译且不发送", async (locale, message) => {
		i18n.set({ locale, voice: "plain" });
		const { dispatcher, send, probe, isAvailable } = setup();
		expect(await dispatcher.send(TARGET_ID, PAYLOAD)).toEqual({
			ok: false,
			code: "not_configured",
			message,
			issues: [{ path: ["url"], message: "Invalid input: expected string, received number" }],
		});
		expect(send).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
		expect(isAvailable).not.toHaveBeenCalled();
	});

	it("经目标发送:回 not_configured、话里带原因,适配器没被调到", async () => {
		const { dispatcher, send, isAvailable } = setup();
		const result = await dispatcher.send(TARGET_ID, PAYLOAD);
		expect(result).toMatchObject({ ok: false, code: "not_configured" });
		expect(result.ok ? "" : result.message).toContain("连接设置不合法");
		expect(result.ok ? "" : result.message).toContain("url");
		expect(send).not.toHaveBeenCalled();
		expect(isAvailable).not.toHaveBeenCalled();
	});

	it("isAvailable 为假、探测回 not_configured,适配器都没被调到", async () => {
		const { dispatcher, probe, isAvailable } = setup();
		expect(dispatcher.isAvailable(TARGET_ID)).toBe(false);
		expect(await dispatcher.probeConnection(CONNECTION_ID)).toMatchObject({
			ok: false,
			code: "not_configured",
		});
		expect(probe).not.toHaveBeenCalled();
		expect(isAvailable).not.toHaveBeenCalled();
	});

	it("按坐标发(sendToAddress)同样被拒", async () => {
		const { dispatcher, send } = setup();
		const result = await dispatcher.sendToAddress(
			CONNECTION_ID,
			{ scope: "group", address: "1" },
			PAYLOAD,
		);
		expect(result).toMatchObject({ ok: false, code: "not_configured" });
		expect(send).not.toHaveBeenCalled();
	});
});

/**
 * 「停用」与「设置不合法」的先后:适配器不在 → 停用 → 设置不合法。停用的连接设置合不合法都无关紧要,
 * 回的得是停用那句,`onDelivery` 也不该把目标记成不通。三条路(send / isAvailable / sendToAddress)一致。
 */
describe("停用排在设置不合法之前", () => {
	const schema = z.object({ url: z.string() });

	function setup(opts: { enabled: boolean; settings: unknown; withAdapter?: boolean }) {
		const send = vi.fn(async (): Promise<DeliveryResult> => ({ ok: true, latencyMs: 1 }));
		const adapter: PlatformAdapter = {
			adapterKey: "webhook",
			settingsSchema: schema,
			descriptor: placeholderDescriptor(),
			isAvailable: () => true,
			send,
			probe: async () => ({ ok: true as const, latencyMs: 1 }),
			listConnectionCandidates: async () => [],
			start() {},
			stop() {},
		};
		const onDelivery = vi.fn();
		const connection = {
			...connectionOf("webhook", "generic", opts.settings),
			enabled: opts.enabled,
		};
		const dispatcher = createTargetDispatcher({
			store: storeOf(connection, targetFor("endpoint")),
			adapters: registryOf(opts.withAdapter === false ? [] : [adapter]),
			logger: logger(),
			onDelivery,
		});
		return { dispatcher, send, onDelivery };
	}

	it("停用且设置不合法:send 回停用那句,不是设置不合法", async () => {
		const { dispatcher, send, onDelivery } = setup({ enabled: false, settings: { url: 123 } });
		const result = await dispatcher.send(TARGET_ID, PAYLOAD);
		expect(result).toMatchObject({ ok: false, code: "not_configured" });
		expect(result.ok ? "" : result.message).toContain("connection disabled");
		expect(result.ok ? "" : result.message).not.toContain("设置不合法");
		expect(send).not.toHaveBeenCalled();
		expect(onDelivery.mock.calls[0]?.[2]).toMatchObject({
			message: expect.stringContaining("disabled"),
		});
	});

	it("sendToAddress 与 send 同序:停用且设置不合法也回停用那句", async () => {
		const { dispatcher } = setup({ enabled: false, settings: { url: 123 } });
		const result = await dispatcher.sendToAddress(
			CONNECTION_ID,
			{ scope: "group", address: "1" },
			PAYLOAD,
		);
		expect(result.ok ? "" : result.message).toContain("connection disabled");
	});

	it("isAvailable 为假(停用且设置不合法)", () => {
		const { dispatcher } = setup({ enabled: false, settings: { url: 123 } });
		expect(dispatcher.isAvailable(TARGET_ID)).toBe(false);
	});

	it("启用但设置不合法:仍回 not_configured + 设置不合法", async () => {
		const { dispatcher } = setup({ enabled: true, settings: { url: 123 } });
		const result = await dispatcher.send(TARGET_ID, PAYLOAD);
		expect(result).toMatchObject({ ok: false, code: "not_configured" });
		expect(result.ok ? "" : result.message).toContain("连接设置不合法");
	});

	it("适配器不在场的停用连接:仍回没有适配器那句(unavailable)", async () => {
		const { dispatcher } = setup({ enabled: false, settings: { url: 123 }, withAdapter: false });
		const result = await dispatcher.send(TARGET_ID, PAYLOAD);
		expect(result).toMatchObject({ ok: false, code: "unavailable" });
		expect(result.ok ? "" : result.message).toContain("no platform adapter");
	});
});

/**
 * 只填了必填项的连接 → 经派发器 → 适配器手上拿到的 settings 是规则里的默认值。
 * 在真适配器外面套一层只记「递过来的连接」的壳(`send` 不往下走,免得出网)。
 */
describe("每个内置适配器:递到手上的 settings 是解过的(补了默认值)", () => {
	function seenBy(real: PlatformAdapter, connection: Connection, target: PushTarget) {
		const seen: Connection[] = [];
		const spy: PlatformAdapter = {
			...real,
			isAvailable: () => true,
			async send(c): Promise<DeliveryResult> {
				seen.push(c);
				return { ok: true, latencyMs: 1 };
			},
		};
		const dispatcher = createTargetDispatcher({
			store: storeOf(connection, target),
			adapters: registryOf([spy]),
			logger: logger(),
		});
		return { dispatcher, seen };
	}

	it("onebot:http 只填 baseUrl → 超时 / 重试 / 协议版本都是默认值", async () => {
		const real = createOnebotAdapter({ logger: logger(), serviceCtx: serviceCtx() });
		const { dispatcher, seen } = seenBy(
			real,
			connectionOf("onebot", "onebot", { transport: "http", baseUrl: "http://127.0.0.1:3000" }),
			targetFor("session"),
		);
		expect(await dispatcher.send(TARGET_ID, PAYLOAD)).toMatchObject({ ok: true });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.settings).toEqual({
			transport: "http",
			baseUrl: "http://127.0.0.1:3000",
			headers: {},
			protocolVersion: "v11",
			timeoutMs: 15_000,
			imageMinTimeoutMs: 30_000,
			mergeForwardMinTimeoutMs: 60_000,
			maxRetries: 0,
			retryIntervalMs: 1_000,
		});
		await real.stop();
	});

	it("qq-official:只填 appId / appSecret → sandbox / botType / logReconnects 是默认值", async () => {
		const real = createQQOfficialAdapter({
			logger: logger(),
			serviceCtx: serviceCtx(),
			registry: createQQSessionRegistry(),
			locale: fixedLocale(),
		});
		const { dispatcher, seen } = seenBy(
			real,
			connectionOf("qq-official", "qq-official", { appId: "1", appSecret: "s" }),
			targetFor("session"),
		);
		expect(await dispatcher.send(TARGET_ID, PAYLOAD)).toMatchObject({ ok: true });
		expect(seen[0]?.settings).toEqual({
			appId: "1",
			appSecret: "s",
			sandbox: false,
			botType: "public",
			logReconnects: false,
		});
		await real.stop();
	});

	it("webhook:只填 url → headers 是默认的空对象", async () => {
		const real = createWebhookAdapter({ logger: logger() });
		const { dispatcher, seen } = seenBy(
			real,
			connectionOf("webhook", "generic", { url: "https://example.com/hook" }),
			targetFor("endpoint"),
		);
		expect(await dispatcher.send(TARGET_ID, PAYLOAD)).toMatchObject({ ok: true });
		expect(seen[0]?.settings).toEqual({ url: "https://example.com/hook", headers: {} });
	});

	it("盘上的原文不被改动(解出来的是新对象)", async () => {
		const real = createWebhookAdapter({ logger: logger() });
		const connection = connectionOf("webhook", "generic", { url: "https://example.com/hook" });
		const { dispatcher } = seenBy(real, connection, targetFor("endpoint"));
		await dispatcher.send(TARGET_ID, PAYLOAD);
		expect(connection.settings).toEqual({ url: "https://example.com/hook" });
	});
});
