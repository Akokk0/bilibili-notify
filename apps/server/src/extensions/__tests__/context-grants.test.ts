/**
 * ctx 上那几格「与核心打交道」的口(ADR-0012 决策 29 / 30 / 31 / 36)。
 *
 * 每一格都带着一条**宿主不信拓展的自述**的规矩:
 * - 注册出口时**分发键由宿主填**,拓展说了不算 —— 自报就能声明 `"onebot"` 把内置连接截走
 * - 喂入站时 `connectionId` 宿主**校验归属** —— 冒充别人的连接就等于绕开主人身份比对
 * - 读连接给的是**全部**(带 `enabled`),config **已经过拓展自己那份 zod**
 */

import { EventEmitter } from "node:events";
import type { Server as HttpServer } from "node:http";
import type {
	Connection,
	Disposable,
	Logger,
	PlatformAdapter,
	ServiceContext,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { adapterForConnection } from "../../platforms/dispatch.js";
import { createAdapterRegistry } from "../../platforms/registry.js";
import { createExtensionContext } from "../context.js";
import { createExtensionMounts } from "../mount.js";
import { createExtensionUpgrades } from "../upgrade.js";

const CONFIG = z.object({ token: z.string(), bridgeKind: z.enum(["koishi", "astrbot"]) });

function connection(over: Partial<Record<string, unknown>> = {}): Connection {
	return {
		id: "c1",
		name: "家里那台",
		enabled: true,
		kind: "extension",
		extensionId: "bridge",
		// 一条连接 = 一个借来的 bot,平台是它的身份轴之一(ADR-0012 决策 45)。
		platform: "onebot",
		config: { token: "t0ken", bridgeKind: "koishi" },
		...over,
	} as Connection;
}

function harness(opts: { connections?: Connection[]; settings?: unknown } = {}) {
	let statusChanges = 0;
	const lines: string[] = [];
	const logger: Logger = {
		info: (m) => lines.push(`info ${m}`),
		warn: (m) => lines.push(`warn ${m}`),
		error: (m) => lines.push(`error ${m}`),
		debug: (m) => lines.push(`debug ${m}`),
	};
	const host: ServiceContext = {
		logger,
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose() {},
	} as unknown as ServiceContext;

	let connections = opts.connections ?? [connection()];
	let settings: unknown = opts.settings;
	const listeners = new Set<() => void>();
	const settingsListeners = new Set<() => void>();
	const inboundSeen: Array<{
		route: "private" | "group";
		connectionId: string;
		platform: string;
	}> = [];
	/** `settings()` 被问了几次 —— 宿主那头每问一次就 deepClone 一整份 globals。 */
	let settingsReads = 0;
	const adapters = createAdapterRegistry();

	const runtime = createExtensionContext({
		id: "bridge",
		host,
		mounts: createExtensionMounts(),
		adapters,
		connections: () => connections,
		onConnectionsChanged: (fn): Disposable => {
			listeners.add(fn);
			return { dispose: () => listeners.delete(fn) };
		},
		// ⚠️ 与生产同形状:宿主那头是 `getGlobals().extensions[id]?.settings`,而 `getGlobals()`
		// **每次都 deepClone**,所以每问一次拿到的都是一个新对象。直接把闭包变量交出去的话,
		// 「按原始值的身份缓存」这种写法在测试里恒命中、在真机上恒不命中。
		settings: () => {
			settingsReads += 1;
			return structuredClone(settings);
		},
		onStatusChanged: () => {
			statusChanges += 1;
		},
		onSettingsChanged: (fn): Disposable => {
			settingsListeners.add(fn);
			return { dispose: () => settingsListeners.delete(fn) };
		},
		upgrades: createExtensionUpgrades(),
		inbound: {
			onInboundPrivate: (_msg, meta) =>
				inboundSeen.push({
					route: "private",
					connectionId: meta.connectionId,
					platform: meta.platform,
				}),
			onInboundGroup: (_msg, meta) =>
				inboundSeen.push({
					route: "group",
					connectionId: meta.connectionId,
					platform: meta.platform,
				}),
		},
	});

	return {
		statusChanges: () => statusChanges,
		runtime,
		ctx: runtime.ctx,
		adapters,
		lines,
		inboundSeen,
		settingsReads: () => settingsReads,
		setConnections(next: Connection[]) {
			connections = next;
			for (const fn of [...listeners]) fn();
		},
		/** 模拟「globals 落了一次盘」—— 宿主那头是整个 globals 的变更通知,内容变没变由 ctx 自己判。 */
		setSettings(next: unknown) {
			settings = next;
			for (const fn of [...settingsListeners]) fn();
		},
	};
}

function fakeAdapter(): PlatformAdapter {
	return { platforms: ["谁都不是"], isAvailable: () => true } as unknown as PlatformAdapter;
}

function def() {
	return {
		adapter: fakeAdapter(),
		descriptor: { label: "桥接", shortLabel: "桥" } as never,
		configSchema: CONFIG,
		configFields: [
			{ kind: "text" as const, code: "token", label: "长期 token", secret: true },
			{
				kind: "select" as const,
				code: "bridgeKind",
				label: "哪一种桥",
				options: [
					{ value: "koishi", label: "koishi" },
					{ value: "astrbot", label: "AstrBot" },
				],
			},
		],
	};
}

describe("注册推送源", () => {
	it("分发键由宿主按 id 填 —— 拓展自报的那份被覆盖掉", () => {
		const h = harness();
		h.ctx.registerPushSource(def());
		const registered = h.adapters.list()[0];
		expect(registered?.platforms).toEqual(["bridge"]);
		expect(adapterForConnection(h.adapters.list(), connection())).toBe(registered);
	});

	it("卸载之后出口就没了", async () => {
		const h = harness();
		h.ctx.registerPushSource(def());
		await h.runtime.dispose();
		expect(h.adapters.list()).toEqual([]);
	});

	it("两份 config 声明对不上 → 注册那一刻就抛,不等到面板上才发现", () => {
		const h = harness();
		expect(() => h.ctx.registerPushSource({ ...def(), configFields: [] })).toThrow(
			/必填键 "token"/,
		);
	});

	/**
	 * 🔴 **descriptor 交上来是为了被画出来。** 收下就扔的话,面板只能自己手抄一份短名与
	 * 标识色 —— 而手抄的副本迟早跟拓展自己报的漂开,且门禁全绿(`platform-meta.tsx` 里
	 * 就躺过这么一行,躺了整整一片)。
	 */
	it("交上来的 descriptor 留得住 —— 面板要拿它画那张脸", () => {
		const h = harness();
		h.ctx.registerPushSource(def());
		expect(h.runtime.descriptor()).toMatchObject({ shortLabel: "桥" });
	});

	it("没注册推送源的拓展没有 descriptor,而不是一份空壳", () => {
		expect(harness().runtime.descriptor()).toBeUndefined();
	});

	/**
	 * 🔴 **字段表交上来也是为了被画出来**(决策 33)—— 它此前只用来对表与找密钥键,面板
	 * 从没拿到过,于是推送目标页建不出拓展连接。同一族的洞:收下就扔,门禁全绿。
	 */
	it("交上来的字段表留得住 —— 面板照它画新建连接的表单", () => {
		const h = harness();
		h.ctx.registerPushSource(def());
		expect(h.runtime.configFields()?.map((f) => f.code)).toEqual(["token", "bridgeKind"]);
		expect(harness().runtime.configFields()).toBeUndefined();
	});

	/**
	 * 哪些 bot 能借来当连接,只有拓展知道(桥后面挂着什么是握手时才知道的)。`listBots`
	 * 是可选的:endpoint 形态的推送源压根没有 bot 这回事。
	 */
	it("给了 listBots 就查得到 bot(连它交的那份 config);没给的查不到,不是空数组", () => {
		const h = harness();
		const bot = {
			config: { token: "t0ken", bridgeKind: "koishi" as const },
			platform: "onebot",
			name: "阿库娅",
		};
		h.ctx.registerPushSource({ ...def(), listBots: () => [bot] });
		expect(h.runtime.bots()).toEqual([bot]);
		const bare = harness();
		bare.ctx.registerPushSource(def());
		expect(bare.runtime.bots()).toBeUndefined();
	});

	it("注册两次 → 抛。一个拓展一个推送源(决策 28)", () => {
		const h = harness();
		h.ctx.registerPushSource(def());
		expect(() => h.ctx.registerPushSource(def())).toThrow();
	});
});

describe("读到属于自己的连接", () => {
	it("只给自己的那些,config 已经过自己那份 zod", () => {
		const h = harness({
			connections: [
				connection(),
				connection({ id: "c2", extensionId: "别人家的" }),
				{ id: "c3", name: "直连", enabled: true, kind: "direct" } as Connection,
			],
		});
		const source = h.ctx.registerPushSource(def());
		const mine = source.connections();
		expect(mine.map((c) => c.id)).toEqual(["c1"]);
		expect(mine[0]?.config.token).toBe("t0ken");
	});

	it("**给全部,不只给启用的** —— 桥要认得出停用那条的 token 才能回 503 而不是 401", () => {
		const h = harness({ connections: [connection({ enabled: false })] });
		const source = h.ctx.registerPushSource(def());
		expect(source.connections()).toEqual([expect.objectContaining({ id: "c1", enabled: false })]);
	});

	it("config 形状不对的那条**根本不出现**,而且留一行", () => {
		const h = harness({ connections: [connection({ config: { token: 42 } })] });
		const source = h.ctx.registerPushSource(def());
		expect(source.connections()).toEqual([]);
		expect(h.lines.some((l) => l.startsWith("warn") && l.includes("c1"))).toBe(true);
	});

	it("是**现读**不是快照 —— 配置变了下一次问就是新的", () => {
		const h = harness();
		const source = h.ctx.registerPushSource(def());
		expect(source.connections()).toHaveLength(1);
		h.setConnections([]);
		expect(source.connections()).toEqual([]);
	});

	it("变更通知叫得到,卸载之后不再叫", async () => {
		const h = harness();
		const source = h.ctx.registerPushSource(def());
		let calls = 0;
		source.onConnectionsChanged(() => {
			calls++;
		});
		h.setConnections([connection()]);
		expect(calls).toBe(1);

		await h.runtime.dispose();
		h.setConnections([connection()]);
		expect(calls).toBe(1);
	});
});

describe("喂入站", () => {
	const meta = (connectionId: string) => ({ connectionId, platform: "telegram" });

	it("私聊与群消息都送得到下一层", () => {
		const h = harness();
		h.ctx.inbound.private({ userId: "u", text: "hi" }, meta("c1"));
		h.ctx.inbound.group(
			{ groupId: "g", userId: "u", text: "hi", cardLinks: [], miniAppCardLinks: [] },
			meta("c1"),
		);
		expect(h.inboundSeen).toEqual([
			{ route: "private", connectionId: "c1", platform: "onebot" },
			{ route: "group", connectionId: "c1", platform: "onebot" },
		]);
	});

	/**
	 * 🔴 **平台以连接上那一格为准,拓展报的说了不算。**
	 *
	 * `meta.platform` 是主人身份比对的一半(`inboundIdentity` → `sameChatIdentity`,那条
	 * 「绝不能跨平台比对」的纪律就靠它)。归属只校验了 `connectionId`,平台却照抄拓展报的 ——
	 * 于是桥那边报错一格(或者作恶)就能让一条 telegram 私聊顶着 onebot 的平台进来,和主人
	 * 的 QQ 号比对上。连接现在**有** platform(决策 45),宿主自己答得出来,不必信它。
	 */
	it("🔴 拓展报的平台与连接对不上 → 以连接为准,并且每条连接只记一行", () => {
		const h = harness();
		h.ctx.inbound.private({ userId: "u", text: "hi" }, meta("c1"));
		h.ctx.inbound.private({ userId: "u", text: "hi" }, meta("c1"));
		expect(h.inboundSeen).toEqual([
			{ route: "private", connectionId: "c1", platform: "onebot" },
			{ route: "private", connectionId: "c1", platform: "onebot" },
		]);
		expect(h.lines.filter((l) => l.includes("平台"))).toHaveLength(1);
	});

	it("🔴 冒充别人的连接 → 丢掉并留一行", () => {
		const h = harness();
		h.ctx.inbound.private({ userId: "u", text: "hi" }, meta("别人家的连接"));
		expect(h.inboundSeen).toEqual([]);
		expect(h.lines.some((l) => l.startsWith("warn"))).toBe(true);
	});
});

describe("给面板看的数据", () => {
	it("交上来的现取,没交过就是 undefined", () => {
		const h = harness();
		expect(h.runtime.status()).toBeUndefined();
		let n = 0;
		h.ctx.publishStatus(() => ({ n: ++n }));
		expect(h.runtime.status()).toEqual({ n: 1 });
		expect(h.runtime.status()).toEqual({ n: 2 });
	});

	/**
	 * 现取的数据有个盲点:**什么时候该再取一次**面板不知道。桥那头 koishi 已经握完手,
	 * 面板上那张卡还灰着,得切一下页才刷新。所以拓展要能喊一声「变了」,宿主把这声推到面板。
	 */
	it("statusChanged 转给宿主 —— 面板据此当场重取,不用切页", () => {
		const h = harness();
		h.ctx.statusChanged();
		h.ctx.statusChanged();
		expect(h.statusChanges()).toBe(2);
	});

	it("卸载之后 statusChanged 被拒绝并留一行", async () => {
		const h = harness();
		await h.runtime.dispose();
		h.ctx.statusChanged();
		expect(h.statusChanges()).toBe(0);
		expect(h.lines.some((l) => l.startsWith("warn") && l.includes("statusChanged"))).toBe(true);
	});
});

describe("认领 WS upgrade", () => {
	it("卸载之后 upgrade 不再打到它 —— 裸 socket 是 ctx 管不着的资源,这道回收更要紧", async () => {
		const upgrades = createExtensionUpgrades();
		const host = new EventEmitter();
		upgrades.attach(host as unknown as HttpServer);

		const lines: string[] = [];
		const logger: Logger = {
			info: () => {},
			warn: (m) => lines.push(m),
			error: () => {},
			debug: () => {},
		};
		const runtime = createExtensionContext({
			id: "bridge",
			host: {
				logger,
				setInterval: () => ({ dispose() {} }),
				setTimeout: () => ({ dispose() {} }),
				onDispose() {},
			} as unknown as ServiceContext,
			mounts: createExtensionMounts(),
			adapters: createAdapterRegistry(),
			connections: () => [],
			onConnectionsChanged: () => ({ dispose() {} }),
			settings: () => undefined,
			onSettingsChanged: () => ({ dispose() {} }),
			inbound: {},
			upgrades,
		});

		const seen: string[] = [];
		runtime.ctx.onUpgrade((u) => seen.push(u.path));
		const fire = () => {
			const socket = { write: () => {}, destroy: () => {} };
			host.emit("upgrade", { url: "/ext/bridge/x", headers: {} }, socket, Buffer.alloc(0));
		};
		fire();
		expect(seen).toEqual(["/x"]);

		await runtime.dispose();
		fire();
		expect(seen).toEqual(["/x"]);
	});
});

describe("读自己的设置", () => {
	const LINKS = z.object({ links: z.array(z.object({ id: z.string(), token: z.string() })) });

	it("已经过自己那份 zod;没设过就是 undefined,而不是一个空壳", () => {
		const h = harness({ settings: { links: [{ id: "a", token: "t" }] } });
		expect(h.ctx.settings(LINKS).get()).toEqual({ links: [{ id: "a", token: "t" }] });
		h.setSettings(undefined);
		expect(h.ctx.settings(LINKS).get()).toBeUndefined();
	});

	it("形状不对 → undefined 并留一行;同一份坏设置**只记一次**,握手一次问一次不该刷屏", () => {
		const h = harness({ settings: { links: "not-a-list" } });
		const settings = h.ctx.settings(LINKS);
		expect(settings.get()).toBeUndefined();
		expect(settings.get()).toBeUndefined();
		expect(h.lines.filter((l) => l.includes("设置"))).toHaveLength(1);
	});

	it("是**现读**:面板改了下一次问就是新的", () => {
		const h = harness({ settings: { links: [] } });
		const settings = h.ctx.settings(LINKS);
		expect(settings.get()?.links).toHaveLength(0);
		h.setSettings({ links: [{ id: "a", token: "t" }] });
		expect(settings.get()?.links).toHaveLength(1);
	});

	/**
	 * 🔴 **同一份 globals 连问两次只解析一次。**
	 *
	 * 缓存从前挂在「原始值的身份」上(WeakMap 的键),而宿主那头每问一次 `settings()` 都是
	 * `getGlobals()` 现 deepClone 出来的**新对象** —— 键永远不同,缓存永远不命中。代价有二:
	 * 每次 `get()` 都克隆一整份 globals 再 parse 一遍,以及下面那条「坏形状只记一次」实际上
	 * 每次都记(桥每握一次手就刷一行)。
	 */
	it("同一份 globals 连问两次:只去问宿主一次", () => {
		const h = harness({ settings: { links: [{ id: "a", token: "t" }] } });
		const settings = h.ctx.settings(LINKS);
		// ctx 建起来时自己读过一次(去重游标的基线),从那之后开始数。
		const before = h.settingsReads();
		settings.get();
		settings.get();
		settings.get();
		expect(h.settingsReads() - before).toBe(1);

		// 落了一次盘 = 缓存作废,下一次问是真去问的(落盘那一下自己也要读一次去比内容)。
		h.setSettings({ links: [] });
		const afterWrite = h.settingsReads();
		settings.get();
		settings.get();
		expect(h.settingsReads() - afterWrite).toBe(1);
	});

	/**
	 * 🔴 去重游标从前是整个 ctx 一个闭包变量,而每个订阅者各自比一次 —— 第一个订阅者把
	 * 游标推到最新,轮到第二个时 `now === lastSettingsSeen`,于是**第二个订阅者永远收不到**。
	 */
	it("两个订阅者都要收到", () => {
		const h = harness({ settings: { links: [] } });
		const seen: string[] = [];
		h.ctx.settings(LINKS).onChange(() => seen.push("a"));
		h.ctx.settings(LINKS).onChange(() => seen.push("b"));
		h.setSettings({ links: [{ id: "a", token: "t" }] });
		expect(seen).toEqual(["a", "b"]);
	});

	it("变更通知只在**内容真的变了**时叫 —— globals 别处动一下不该踢一遍所有桥;卸载后不再叫", async () => {
		const h = harness({ settings: { links: [{ id: "a", token: "t" }] } });
		let calls = 0;
		h.ctx.settings(LINKS).onChange(() => {
			calls++;
		});
		// 同样的内容再落一次盘(别的全局项变了)→ 不叫
		h.setSettings({ links: [{ id: "a", token: "t" }] });
		expect(calls).toBe(0);
		h.setSettings({ links: [{ id: "a", token: "t2" }] });
		expect(calls).toBe(1);

		await h.runtime.dispose();
		h.setSettings({ links: [] });
		expect(calls).toBe(1);
	});
});
