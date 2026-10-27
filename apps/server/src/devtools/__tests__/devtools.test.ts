import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { fail, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { fakeAdapterContext, registryOf } from "../../__tests__/support/adapter-ctx.js";
import type { ExtensionEntry } from "../../extensions/loader.js";
import type { Marketplace } from "../../extensions/marketplace.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import { createTargetDispatcher } from "../../push/target-dispatcher.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import type { UpdateService } from "../../update/service.js";
import { createDevtools } from "../index.js";

/**
 * devtools 那道门 = **载荷版本号是不是开发版**。不是环境变量:环境变量能在生产镜像里被
 * 设上,版本号不能;alpha 也不给 —— 它是发出去给人用的构建。
 */

const REAL: UpdateStatusDTO = {
	currentVersion: "0.0.0-dev",
	rollbackTarget: null,
	pinnedVersion: null,
	state: { phase: "disabled", reason: "dev-build" },
};

const updateService: UpdateService = {
	getStatus: () => REAL,
	check: async () => REAL,
	download: async () => REAL,
	rollback: async () => REAL,
	probeMirrors: async () => [],
};

/** 真市场的替身:什么都不列,装只记账 —— 装饰那一层的规矩在 marketplace-update-scenario 里钉。 */
const REAL_MARKET: Marketplace = {
	list: async () => ({ available: true, sources: [], extensions: [], fetchedAt: 0 }),
	install: async () => fail("unavailable", "真市场的替身不装东西"),
};

const BARE = {
	updateService,
	marketplace: REAL_MARKET,
	adapters: createPlatformAdapterRegistry(),
	historyStore: { deleteRange: async () => 0 },
	provide: () => {},
	inbound: () => undefined,
	commands: () => ({ prefix: "/" }),
	connectionConfigs: () => [],
	// 还没起监听 —— 拓展开发入口的 `mountUrl()` 据此回 undefined,而不是去连一个 undefined。
	address: () => undefined,
	targets: () => [],
	bus: createNodeMessageBus(),
	puppeteer: () => null,
	mute: () => undefined,
	profileRefresh: () => undefined,
	// 仓里那个目录在测试里指向一个不存在的路径 → 拓展那三条场景没有可选项,不注册。
	// 它们自己的规矩在 `devtools-extensions.test.ts` 里钉。
	extensions: { repoDir: "/nope/extensions", installRoot: "/nope/data", loaded: () => undefined },
	sourceRun: true,
};

describe("createDevtools", () => {
	it.each(["0.0.0-dev", "dev"])("源码上跑的开发版 %s → 给", (payloadVersion) => {
		expect(createDevtools({ ...BARE, payloadVersion })).not.toBeNull();
	});

	it.each(["0.10.0", "0.11.0-alpha.1", "1.0.0-rc.1"])("发出去的版本 %s → 不给", (v) => {
		expect(createDevtools({ ...BARE, payloadVersion: v })).toBeNull();
	});

	/**
	 * 版本号这道门是**失败即敞开**的:`0.0.0-dev` 是仓库里的常驻值(只有发版 workflow 才临时
	 * 同步成真版本号),而版本号读不出来时兜底也正是 `"dev"` —— 于是任何**没走发版流程**的
	 * 构建产物都会自认开发版,把 `/api/dev` 挂出去。`:test` 镜像就是这么来的:它公开推,
	 * 构建前不同步版本。所以还要一道构建产物身上不可能成立的门:跑的是不是 TypeScript 源码。
	 */
	it.each(["0.0.0-dev", "dev"])("版本号是 %s 但跑的是构建产物 → 不给", (payloadVersion) => {
		expect(createDevtools({ ...BARE, payloadVersion, sourceRun: false })).toBeNull();
	});

	it("给的那份:更新服务换成了可注入的装饰器,注册表里有 update.state", async () => {
		const dev = createDevtools({ ...BARE, payloadVersion: "0.0.0-dev" });
		if (dev === null) throw new Error("unreachable");

		expect(dev.registry.list().map((s) => s.id)).toContain("update.state");
		await dev.registry.run("update.state", { phase: "idle" });
		expect(dev.updateService.getStatus().state).toEqual({ phase: "idle" });
		// 真服务没被动过。
		expect(updateService.getStatus().state).toEqual({ phase: "disabled", reason: "dev-build" });
	});

	/**
	 * 门没开(发出去的版本 / 跑的是构建产物)时登记回调一次都不调 —— B 站的场景工厂会装直播连接的
	 * 观察钩子,这是行为:关着的 devtools 不许有副作用。门开着则恰好调一次。
	 */
	it.each([
		["发出去的版本", { payloadVersion: "0.10.0", sourceRun: true }],
		["构建产物", { payloadVersion: "0.0.0-dev", sourceRun: false }],
	])("门没开(%s)→ provide 一次都不调;开着 → 恰好一次", (_name, gate) => {
		const provide = vi.fn();
		expect(createDevtools({ ...BARE, ...gate, provide })).toBeNull();
		expect(provide).not.toHaveBeenCalled();

		createDevtools({ ...BARE, payloadVersion: "0.0.0-dev", provide });
		expect(provide).toHaveBeenCalledOnce();
	});

	/** 登记表接线:建组合注册表时不传 `providers`,这条就红(别家登记的场景进不了注册表)。 */
	it("登记表里各家交的场景汇进注册表,id 带来源前缀", async () => {
		const run = vi.fn(() => ok({ summary: "跑了" }));
		const dev = createDevtools({
			...BARE,
			payloadVersion: "0.0.0-dev",
			provide: (providers) =>
				providers.claim("demo", {
					scenarios: [{ id: "hello", group: "event", title: "你好", params: [], run }],
				}),
		});
		if (dev === null) throw new Error("unreachable");

		const ids = dev.registry.list().map((s) => s.id);
		expect(ids).toContain("demo.hello");
		expect(ids).not.toContain("hello");
		expect(await dev.registry.run("demo.hello", {})).toMatchObject({
			ok: true,
			summary: "跑了",
		});
	});
});

describe("createDevtools · 截流接线", () => {
	const CONNECTION = {
		id: "ad",
		name: "A",
		adapterKey: "onebot",
		platform: "onebot",
		settings: {},
		enabled: true,
	} as never;
	const TARGET = {
		id: "t",
		name: "群",
		connectionId: "ad",
		kind: "session",
		scope: "group",
		address: "1",
		enabled: true,
	} as never;
	const LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

	function onebotAdapter(send = vi.fn(async () => ok({ latencyMs: 1 }))) {
		return {
			adapterKey: "onebot",
			settingsSchema: z.unknown(),
			isAvailable: () => true,
			send,
			probe: async () => ok({ latencyMs: 1 }),
			listConnectionCandidates: async () => [],
			start() {},
			stop() {},
		};
	}

	/** 真派发器接在 devtools 交回去的读口与截流口上 —— 接线剪断哪一头这里都会红。 */
	function setup(registry = registryOf([onebotAdapter()])) {
		const deleteRange = vi.fn(async () => 2);
		const dev = createDevtools({
			...BARE,
			payloadVersion: "0.0.0-dev",
			adapters: registry,
			historyStore: { deleteRange } as never,
		});
		if (dev === null) throw new Error("unreachable");
		const dispatcher = createTargetDispatcher({
			store: {
				getConnections: () => [CONNECTION],
				getConnection: (id: string) => (id === "ad" ? CONNECTION : undefined),
				getTargets: () => [TARGET],
			} as never,
			adapters: registry,
			injectedCapabilities: dev.injectedCapabilities,
			interceptSend: dev.interceptSend,
			logger: LOGGER,
		});
		return { dev, dispatcher, deleteRange };
	}

	/**
	 * 🔴 devtools 不拷注册表、也不包一层;派发器拿到的就是那张活表。
	 *
	 * 拷一份的话,拓展后注册进来的出口在开发版里根本不存在 —— 而生产是好的。那是
	 * 「本地一跑就不生效、两边都不报错」那类假绿(ADR-0012 决策 29)。
	 */
	it("createDevtools 之后**才注册**的出口,派发器照样发得到、照样被截流口拦住", async () => {
		const send = vi.fn(async () => ok({ latencyMs: 1 }));
		const registry = createPlatformAdapterRegistry();
		const { dev, dispatcher } = setup(registry);
		expect(registry.list()).toEqual([]);

		// 拓展在 activate 里注册的那一刻 —— 比 devtools 晚得多。
		registry.register(onebotAdapter(send), fakeAdapterContext().ctx);

		expect(registry.list()).toHaveLength(1);
		await dispatcher.send("t", { kind: "text", text: "0" });
		expect(send).toHaveBeenCalledTimes(1);
		await dev.registry.run("push.capture", {});
		await dispatcher.send("t", { kind: "text", text: "1" });
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("截流开着:send / sendToAddress 两条路都不出网,各记恰好一条;收摊后又真发", async () => {
		const send = vi.fn(async () => ok({ latencyMs: 1 }));
		const { dev, dispatcher } = setup(registryOf([onebotAdapter(send)]));

		await dispatcher.send("t", { kind: "text", text: "0" });
		expect(send).toHaveBeenCalledTimes(1);

		const res = await dev.registry.run("push.capture", {});
		expect(res).toMatchObject({
			ok: true,
			active: [{ scenarioId: "push.capture", label: "推送截流中 · 拦下 0 条" }],
		});
		await dispatcher.send("t", { kind: "text", text: "a" });
		await dispatcher.sendToAddress(
			"ad",
			{ scope: "group", address: "777" },
			{ kind: "text", text: "c" },
		);

		expect(send).toHaveBeenCalledTimes(1);
		expect(dev.captures.status().entries.map((e) => [e.text, e.private, e.targetName])).toEqual([
			["a", false, "群"],
			["c", false, "群 777"],
		]);
		expect(dev.registry.active()[0]?.label).toBe("推送截流中 · 拦下 2 条");

		dev.registry.reset("push.capture");
		await dispatcher.send("t", { kind: "text", text: "3" });
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("截流开着时结果仍是合成的 ok —— 上游凭 isSynthetic 不写 reachability", async () => {
		const { dev, dispatcher } = setup();
		await dev.registry.run("push.capture", {});
		expect(await dispatcher.send("t", { kind: "text", text: "x" })).toEqual({
			ok: true,
			latencyMs: 0,
			isSynthetic: true,
		});
	});

	it("清掉截流期间历史行:按每一段窗调 deleteRange,开着的那段截到现在,清完窗从头记", async () => {
		vi.useFakeTimers();
		try {
			const { dev, deleteRange } = setup();
			vi.setSystemTime(new Date("2026-09-06T08:00:00.000Z"));
			await dev.registry.run("push.capture", {});
			vi.setSystemTime(new Date("2026-09-06T08:10:00.000Z"));
			dev.registry.reset("push.capture");
			vi.setSystemTime(new Date("2026-09-06T08:20:00.000Z"));
			await dev.registry.run("push.capture", {});
			vi.setSystemTime(new Date("2026-09-06T08:25:00.000Z"));

			const deleted = await dev.captures.purgeHistory();

			expect(deleted).toBe(4);
			expect(deleteRange.mock.calls).toEqual([
				[
					{
						fromMs: Date.parse("2026-09-06T08:00:00.000Z"),
						toMs: Date.parse("2026-09-06T08:10:00.000Z"),
					},
				],
				[
					{
						fromMs: Date.parse("2026-09-06T08:20:00.000Z"),
						toMs: Date.parse("2026-09-06T08:25:00.000Z"),
					},
				],
			]);
			// 清完:开着的那段从现在起算,再清一次不会把同一段又删一遍。
			deleteRange.mockClear();
			vi.setSystemTime(new Date("2026-09-06T08:30:00.000Z"));
			await dev.captures.purgeHistory();
			expect(deleteRange.mock.calls).toEqual([
				[
					{
						fromMs: Date.parse("2026-09-06T08:25:00.000Z"),
						toMs: Date.parse("2026-09-06T08:30:00.000Z"),
					},
				],
			]);
		} finally {
			vi.useRealTimers();
		}
	});
});

/**
 * 市场那一层的接线:零件(装饰器、场景)各自的测试全绿,证明不了 `createDevtools` 真把
 * 包好的那份交了出去、真把装载器名单接进了装饰器。剪断任何一头这条就红。
 */
describe("createDevtools · 市场接线", () => {
	it("交回去的 marketplace 是装饰过的:ext.updatable 之后那张卡有新版,装它不走真市场", async () => {
		const install = vi.fn(REAL_MARKET.install);
		const bridge: ExtensionEntry = {
			id: "bridge",
			state: "running",
			dir: "/data/extensions/bridge",
			identity: { id: "bridge", name: "机器人桥", description: "桥", version: "0.4.0" },
		};
		const dev = createDevtools({
			...BARE,
			payloadVersion: "0.0.0-dev",
			marketplace: { ...REAL_MARKET, install },
			extensions: {
				...BARE.extensions,
				loaded: () => ({ reload: async () => {}, rescan: async () => {}, list: () => [bridge] }),
			},
		});
		if (dev === null) throw new Error("unreachable");

		await dev.registry.run("ext.updatable", { ext: "bridge" });
		const [made] = (await dev.marketplace.list()).extensions;
		expect(made).toMatchObject({ id: "bridge", state: "updatable", version: "0.4.1" });
		expect(await dev.marketplace.install("official", "bridge")).toMatchObject({
			ok: true,
			name: "机器人桥",
			version: "0.4.1",
		});
		expect(install).not.toHaveBeenCalled();
	});
});
