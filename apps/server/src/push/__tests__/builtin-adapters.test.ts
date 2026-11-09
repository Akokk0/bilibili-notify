import { fixedTimezone } from "../../__tests__/support/integration-io.js";
/**
 * 内置适配器的「登记即启动、注销即停止」装配。
 *
 * 用假适配器钉:每个都被 `start` 一次并拿到只含自己连接的名单;连接变更的一声叫到每个适配器登记的回调;
 * 收尾时每个 `stop` 一次、各自上下文的 `signal` 已中止、订阅摘掉。
 * (引擎不再替适配器对账 / 收尾 —— 这条行为搬到了这里。)
 */

import {
	type Connection,
	type Disposable,
	ok,
	type PlatformAdapter,
	type PlatformAdapterContext,
} from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { ignoredProblems } from "../../__tests__/support/ignored-problems.js";
import { inertSettingsOf } from "../../__tests__/support/inert-settings.js";
import { inertTransitImages, realTimeout } from "../../__tests__/support/integration-io.js";
import {
	memoryIntegrationStore,
	memoryStoreHandle,
} from "../../__tests__/support/memory-key-value-store.js";
import { i18n } from "../../i18n/index.js";
import { createValueRedactor } from "../../logs/value-redactor.js";
import { createProblemTable, type ProblemChange } from "../../problems/problem-table.js";
import { registerBuiltinAdapters } from "../builtin-adapters.js";
import { createPlatformAdapterRegistry } from "../registry.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

afterEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

function direct(id: string, platform: string): Connection {
	return {
		id,
		name: id,
		enabled: true,
		adapterKey: platform === "onebot" || platform === "qq-official" ? platform : "webhook",
		platform,
		settings: {},
		platformSnapshot: snapshotFor(platform),
	};
}

interface FakeAdapter extends PlatformAdapter {
	ctx?: PlatformAdapterContext;
	seen: string[][];
	changed: () => void;
}

function fakeAdapter(adapterKey: string): FakeAdapter {
	const fake = {
		adapterKey,
		settingsSchema: z.unknown(),
		descriptor: () => ({
			label: `${adapterKey} 的全名`,
			shortLabel: adapterKey,
			color: "#000000",
			settingsFields: [],
		}),
		seen: [] as string[][],
		changed: vi.fn() as unknown as () => void,
		isAvailable: () => true,
		send: async () => ({ ok: true, latencyMs: 1 }),
		start: vi.fn((ctx: PlatformAdapterContext) => {
			fake.ctx = ctx;
			fake.seen.push(ctx.connections().map((c) => c.id));
			ctx.onConnectionsChanged(() => fake.changed());
		}),
		stop: vi.fn(),
	} as unknown as FakeAdapter;
	return fake;
}

async function setup() {
	const stores = memoryIntegrationStore();
	const list: Connection[] = [
		direct("ob1", "onebot"),
		direct("qq1", "qq-official"),
		direct("wh1", "feishu"),
		direct("ob2", "onebot"),
	];
	const listeners = new Set<() => void>();
	const onConnectionsChanged = (fn: () => void): Disposable => {
		listeners.add(fn);
		return { dispose: () => listeners.delete(fn) };
	};
	const emit = () => {
		for (const fn of [...listeners]) fn();
	};
	const registry = createPlatformAdapterRegistry();
	const problems = createProblemTable({ logger });
	const onebot = fakeAdapter("onebot");
	const qq = fakeAdapter("qq-official");
	const webhook = fakeAdapter("webhook");
	const inboundSeen: Array<{ route: string; meta: unknown }> = [];
	/** 各适配器的集成上下文向 `settingsOf` 要过的键,按要的先后。 */
	const settingsKeys: string[] = [];
	const builtin = await registerBuiltinAdapters({
		timezoneReader: fixedTimezone("Asia/Shanghai"),
		transitImages: inertTransitImages,
		setTimeout: realTimeout,
		registry,
		adapters: [onebot, qq, webhook],
		loggerOf: () => logger,
		inbound: {
			private: (_msg, meta) => inboundSeen.push({ route: "private", meta }),
			group: (_msg, meta) => inboundSeen.push({ route: "group", meta }),
		},
		stores,
		problems,
		settingsOf: (key) => {
			settingsKeys.push(key);
			// 读到的设置带着是哪个键要的,好看出每个适配器读的是自己那一段。
			return { read: () => ok({ settings: { key } }), onChanged: () => ({ dispose() {} }) };
		},
		connections: () => list,
		onConnectionsChanged,
	});
	return {
		registry,
		onebot,
		qq,
		webhook,
		builtin,
		emit,
		listeners,
		stores,
		problems,
		inboundSeen,
		settingsKeys,
	};
}

describe("registerBuiltinAdapters", () => {
	it.each([
		["en", "BN is shutting down"],
		["ja", "BNを終了しています"],
		["zh-TW", "BN 正在關閉"],
	] as const)("%s：启动后换语，关停原因取新语言且各自只停一次", async (locale, message) => {
		const { onebot, qq, webhook, builtin, registry } = await setup();
		i18n.set({ locale, voice: "plain" });
		await builtin.dispose();
		for (const adapter of [onebot, qq, webhook]) {
			expect(adapter.ctx?.signal.reason).toMatchObject({ name: "AbortError", message });
			expect(adapter.stop).toHaveBeenCalledTimes(1);
		}
		expect(registry.list()).toEqual([]);
	});

	// 验红:`registerBuiltinAdapters` 里按别的键(例如写死 "onebot")向 `settingsOf` 要读法,这条红。
	it("每个适配器的集成上下文按自己的适配器键要设置的读法", async () => {
		const { settingsKeys, builtin } = await setup();
		expect(settingsKeys).toEqual(["onebot", "qq-official", "webhook"]);
		await builtin.dispose();
	});

	// 验红:`adapter-context.ts` 里 `settings` 那一行不转发 `integration.settings`(换成另造一份),这条红。
	it("适配器 start 拿到的 ctx.settings 读的是自己那一段:各读各的键", async () => {
		const { onebot, qq, webhook, builtin } = await setup();
		const Schema = z.object({ key: z.string() });
		expect(onebot.ctx?.settings(Schema).get()).toEqual({ ok: true, settings: { key: "onebot" } });
		expect(qq.ctx?.settings(Schema).get()).toEqual({ ok: true, settings: { key: "qq-official" } });
		expect(webhook.ctx?.settings(Schema).get()).toEqual({ ok: true, settings: { key: "webhook" } });
		await builtin.dispose();
	});

	// 验红:`registerBuiltinAdapters` 不把 `inbound` 递给 `createPlatformAdapterContext`(换成空表),这条红。
	it("适配器 start 拿到的 ctx 带 inbound:交一条消息,宿主的下一层收到,平台是连接上的;别家的连接被丢", async () => {
		const { onebot, builtin, inboundSeen } = await setup();
		const msg = { address: "u", text: "hi" };
		onebot.ctx?.inbound.private(msg, { connectionId: "ob1" });
		onebot.ctx?.inbound.private(msg, { connectionId: "qq1" });
		expect(inboundSeen).toEqual([
			{ route: "private", meta: { connectionId: "ob1", platform: "onebot" } },
		]);
		await builtin.dispose();
	});

	// 验红:建集成上下文时把 `opts.loggerOf(adapter.adapterKey)` 改成 `opts.loggerOf("onebot")`(或别的写死的键),这条红。
	it("每个适配器的集成上下文拿的是按它自己的适配器键要来的日志器", async () => {
		const loggers = new Map<string, typeof logger>();
		const loggerOf = vi.fn((key: string) => {
			const made = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
			loggers.set(key, made);
			return made;
		});
		const onebot = fakeAdapter("onebot");
		const qq = fakeAdapter("qq-official");
		const webhook = fakeAdapter("webhook");
		const builtin = await registerBuiltinAdapters({
			timezoneReader: fixedTimezone("Asia/Shanghai"),
			transitImages: inertTransitImages,
			setTimeout: realTimeout,
			registry: createPlatformAdapterRegistry(),
			adapters: [onebot, qq, webhook],
			loggerOf,
			inbound: {},
			stores: memoryIntegrationStore(),
			problems: ignoredProblems,
			settingsOf: inertSettingsOf,
			connections: () => [],
			onConnectionsChanged: () => ({ dispose() {} }),
		});
		expect(loggerOf.mock.calls.map(([key]) => key)).toEqual(["onebot", "qq-official", "webhook"]);
		expect(onebot.ctx?.logger).toBe(loggers.get("onebot"));
		expect(qq.ctx?.logger).toBe(loggers.get("qq-official"));
		expect(webhook.ctx?.logger).toBe(loggers.get("webhook"));
		await builtin.dispose();
	});

	it("每个适配器被 start 一次,拿到只含自己连接的名单,并进了登记表", async () => {
		const { registry, onebot, qq, webhook } = await setup();
		expect(onebot.start).toHaveBeenCalledTimes(1);
		expect(qq.start).toHaveBeenCalledTimes(1);
		expect(webhook.start).toHaveBeenCalledTimes(1);
		expect(onebot.seen).toEqual([["ob1", "ob2"]]);
		expect(qq.seen).toEqual([["qq1"]]);
		expect(webhook.seen).toEqual([["wh1"]]);
		expect(registry.list().map((a) => a.adapterKey)).toEqual(["onebot", "qq-official", "webhook"]);
	});

	it("适配器在 start 之后报一条连接问题进表(报的人是适配器键);撤掉登记之后它名下的全清", async () => {
		const { onebot, qq, builtin, problems } = await setup();
		onebot.ctx?.reportProblem({ connectionId: "ob1", code: "gateway_down", message: "连不上" });
		// 别人的连接:被宿主拒收。
		onebot.ctx?.reportProblem({ connectionId: "qq1", code: "gateway_down", message: "越界" });
		qq.ctx?.reportProblem({ connectionId: "qq1", code: "gateway_down", message: "官机的" });
		expect(problems.list().map((p) => [p.reporter, p.about])).toEqual([
			["onebot", { connectionId: "ob1" }],
			["qq-official", { connectionId: "qq1" }],
		]);
		await builtin.dispose();
		expect(problems.list()).toEqual([]);
	});

	it("适配器报的问题,写者名取描述的全名(私聊引子「刚刚 xxx 报告」用它),不是适配器键", async () => {
		const { onebot, problems } = await setup();
		const changes: ProblemChange[] = [];
		problems.subscribe((change) => changes.push(change));
		onebot.ctx?.reportProblem({ connectionId: "ob1", code: "gateway_down", message: "连不上" });
		onebot.ctx?.reportProblem({ code: "adapter_down", message: "整个适配器出事了" });
		expect(changes.map((c) => c.writtenBy)).toEqual(["onebot 的全名", "onebot 的全名"]);
	});

	it("适配器的 ctx.redact 经它自己那份存储把手登记(归属是适配器键);撤掉登记之后撤干净", async () => {
		const redactor = createValueRedactor();
		const onebot = fakeAdapter("onebot");
		const qq = fakeAdapter("qq-official");
		const builtin = await registerBuiltinAdapters({
			timezoneReader: fixedTimezone("Asia/Shanghai"),
			transitImages: inertTransitImages,
			setTimeout: realTimeout,
			registry: createPlatformAdapterRegistry(),
			adapters: [onebot, qq],
			loggerOf: () => logger,
			inbound: {},
			// 与真存储宿主同形状:把手的 `redact` 归属是它开的那个键,同一种整批换。
			stores: {
				open: async (key) =>
					memoryStoreHandle({}, (kind, values) => redactor.replace(key, kind, values)).handle,
			},
			problems: ignoredProblems,
			settingsOf: inertSettingsOf,
			connections: () => [],
			onConnectionsChanged: () => ({ dispose() {} }),
		});
		onebot.ctx?.redact("FAKE-ONEBOT-TOKEN-1");
		onebot.ctx?.redact("FAKE-ONEBOT-TOKEN-2");
		qq.ctx?.redact("FAKE-QQ-SECRET-0001");
		expect(redactor.scrub("FAKE-ONEBOT-TOKEN-1 FAKE-ONEBOT-TOKEN-2 FAKE-QQ-SECRET-0001")).toBe(
			"*** *** ***",
		);
		await builtin.dispose();
		expect(redactor.scrub("FAKE-ONEBOT-TOKEN-1 FAKE-QQ-SECRET-0001")).toBe(
			"FAKE-ONEBOT-TOKEN-1 FAKE-QQ-SECRET-0001",
		);
	});

	it("订阅发一声,每个适配器登记的回调都被叫到", async () => {
		const { onebot, qq, webhook, emit } = await setup();
		emit();
		expect(onebot.changed).toHaveBeenCalledTimes(1);
		expect(qq.changed).toHaveBeenCalledTimes(1);
		expect(webhook.changed).toHaveBeenCalledTimes(1);
	});

	it("dispose() 之后每个都 stop 一次、各自上下文的 signal 已中止、再发一声没人被叫", async () => {
		const { registry, onebot, qq, webhook, builtin, emit, listeners } = await setup();
		await builtin.dispose();
		expect(onebot.stop).toHaveBeenCalledTimes(1);
		expect(qq.stop).toHaveBeenCalledTimes(1);
		expect(webhook.stop).toHaveBeenCalledTimes(1);
		for (const fake of [onebot, qq, webhook]) expect(fake.ctx?.signal.aborted).toBe(true);
		expect(registry.list()).toEqual([]);
		expect(listeners.size).toBe(0);
		emit();
		expect(onebot.changed).not.toHaveBeenCalled();
		expect(qq.changed).not.toHaveBeenCalled();
		expect(webhook.changed).not.toHaveBeenCalled();
	});

	it("dispose() 之后用 start 时存下的 ctx 再订连接变更 → 当场撤掉,订阅发一声回调不被叫", async () => {
		const { onebot, builtin, emit, listeners } = await setup();
		await builtin.dispose();
		const late = vi.fn();
		onebot.ctx?.onConnectionsChanged(late);
		expect(listeners.size).toBe(0);
		emit();
		expect(late).not.toHaveBeenCalled();
	});

	it("登记到一半失败(第二个与第一个键相同)→ 抛出,第一个被 stop、signal 已中止、登记表空、第三个没 start", async () => {
		const registry = createPlatformAdapterRegistry();
		const first = fakeAdapter("onebot");
		const dup = fakeAdapter("onebot");
		const third = fakeAdapter("qq-official");
		// 每次 open 都给一份独立的内存存储:这一条要走到的是登记表的「键重复」,不是存储的「同键已开」。
		await expect(
			registerBuiltinAdapters({
				timezoneReader: fixedTimezone("Asia/Shanghai"),
				transitImages: inertTransitImages,
				setTimeout: realTimeout,
				registry,
				adapters: [first, dup, third],
				loggerOf: () => logger,
				inbound: {},
				stores: { open: (key) => memoryIntegrationStore().open(key) },
				problems: ignoredProblems,
				settingsOf: inertSettingsOf,
				connections: () => [],
				onConnectionsChanged: () => ({ dispose() {} }),
			}),
		).rejects.toThrow(/already registered/);
		expect(first.start).toHaveBeenCalledTimes(1);
		expect(first.stop).toHaveBeenCalledTimes(1);
		expect(first.ctx?.signal.aborted).toBe(true);
		expect(registry.list()).toEqual([]);
		expect(dup.start).not.toHaveBeenCalled();
		expect(third.start).not.toHaveBeenCalled();
	});

	it("存储打不开 → 抛出,已登记的回滚、开着的把手都关了", async () => {
		const stores = memoryIntegrationStore();
		const registry = createPlatformAdapterRegistry();
		const first = fakeAdapter("onebot");
		const second = fakeAdapter("qq-official");
		await expect(
			registerBuiltinAdapters({
				timezoneReader: fixedTimezone("Asia/Shanghai"),
				transitImages: inertTransitImages,
				setTimeout: realTimeout,
				registry,
				adapters: [first, second],
				problems: ignoredProblems,
				settingsOf: inertSettingsOf,
				loggerOf: () => logger,
				inbound: {},
				stores: {
					open: async (key) => {
						if (key === "qq-official") throw new Error("打不开");
						return stores.open(key);
					},
				},
				connections: () => [],
				onConnectionsChanged: () => ({ dispose() {} }),
			}),
		).rejects.toThrow("打不开");
		expect(first.stop).toHaveBeenCalledTimes(1);
		expect(registry.list()).toEqual([]);
		expect(second.start).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(stores.openKeys()).toEqual([]));
	});

	it("每个适配器按自己的键开存储;dispose() 之后各把手都关了(能再开)", async () => {
		const { builtin, stores } = await setup();
		expect(stores.openKeys().sort()).toEqual(["onebot", "qq-official", "webhook"]);
		await builtin.dispose();
		expect(stores.openKeys()).toEqual([]);
	});

	it("适配器 start 里拿到的 state / secrets 是这个适配器那一份,互不相干", async () => {
		const { onebot, qq } = await setup();
		await onebot.ctx?.state.set("k", "onebot");
		await qq.ctx?.state.set("k", "qq");
		expect(onebot.ctx?.state.get("k")).toBe("onebot");
		expect(qq.ctx?.state.get("k")).toBe("qq");
		expect(onebot.ctx?.secrets.get("k")).toBeUndefined();
	});

	it("dispose() 幂等 —— 再调不重复 stop", async () => {
		const { onebot, builtin } = await setup();
		await builtin.dispose();
		await builtin.dispose();
		expect(onebot.stop).toHaveBeenCalledTimes(1);
	});
});
