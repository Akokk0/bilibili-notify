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
import type { ExtensionPanelView } from "@bilibili-notify/contract";
import type {
	ExtensionConfigField,
	ExtensionDescriptor,
	ExtensionView,
} from "@bilibili-notify/extension";
import type {
	Connection,
	Disposable,
	ExtensionManifest,
	Logger,
	PlatformAdapter,
	ServiceContext,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ZodType, z } from "zod";
import { adapterForConnection } from "../../platforms/dispatch.js";
import { createAdapterRegistry } from "../../platforms/registry.js";
import { createExtensionContext, STATUS_CHANGED_COALESCE_MS } from "../context.js";
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

/** 桥今天那份:v1,只开推送源。 */
const V1_PUSH: ExtensionManifest = {
	id: "bridge",
	name: "机器人框架桥接",
	description: "测试用",
	version: "1.0.0",
	apiVersion: 1,
	provides: ["push"],
};

function harness(
	opts: { connections?: Connection[]; settings?: unknown; manifest?: ExtensionManifest } = {},
) {
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
	/** 全表 / 单条各被问了几次 —— 全表那口在宿主那头是 deepClone 整张连接表。 */
	let connectionsReads = 0;
	let connectionReads = 0;
	const adapters = createAdapterRegistry();

	const runtime = createExtensionContext({
		id: "bridge",
		manifest: opts.manifest ?? V1_PUSH,
		host,
		mounts: createExtensionMounts(),
		adapters,
		connections: () => {
			connectionsReads += 1;
			return connections;
		},
		connection: (connectionId) => {
			connectionReads += 1;
			return connections.find((c) => c.id === connectionId);
		},
		onConnectionsChanged: (fn): Disposable => {
			listeners.add(fn);
			return { dispose: () => listeners.delete(fn) };
		},
		// 订阅源那一口钉在 `subscription-source.test.ts`(装载器那一层)。
		subscriptions: () => [],
		onSubscriptionsChanged: () => ({ dispose() {} }),
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
		connectionsReads: () => connectionsReads,
		connectionReads: () => connectionReads,
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

function descriptor(): ExtensionDescriptor {
	return { label: "桥接", shortLabel: "桥", tint: "#a855f7" };
}

function def() {
	return {
		adapter: fakeAdapter(),
		descriptor: descriptor(),
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

/**
 * 按清单注册(ADR-0019 决策 16 / 17):v2 的外观与连接配置项**只住清单**,代码只交行为与
 * zod;v1 的留在代码里、收下时翻译。不管哪一档,**注册的口必须是清单开了的口** —— 今天
 * 「声明订阅却去注册推送」没人拦,面板按清单把它归在订阅那一栏,推送目标页却多出一档。
 */
describe("按清单注册推送源", () => {
	const DISPLAY = { label: "桥接", shortLabel: "桥", color: "#a855f7" };
	const V2_FIELDS = [
		{ type: "string" as const, key: "token", label: "长期 token", secret: true, required: true },
		{
			type: "enum" as const,
			key: "bridgeKind",
			label: "哪一种桥",
			required: true,
			options: [
				{ value: "koishi", label: "koishi" },
				{ value: "astrbot", label: "AstrBot" },
			],
		},
	];
	function v2(over: Record<string, unknown> = {}): ExtensionManifest {
		return {
			id: "bridge",
			name: "机器人框架桥接",
			description: "测试用",
			version: "2.0.0",
			apiVersion: 2,
			contributes: { push: { display: DISPLAY, connection: { fields: V2_FIELDS } } },
			...over,
		} as ExtensionManifest;
	}
	const v2Def = () => ({ adapter: fakeAdapter(), configSchema: CONFIG });

	it("v2:外观与连接配置项取自清单,代码只交行为与 zod", () => {
		const h = harness({ manifest: v2() });
		h.ctx.registerPushSource(v2Def());
		expect(h.runtime.pushSource()).toEqual({ display: DISPLAY, connectionFields: V2_FIELDS });
		// 密钥照清单里的声明抹 —— 备份脱敏那一格。
		expect(h.runtime.secretConfigCodes()).toEqual(["token"]);
		expect(h.adapters.list()).toHaveLength(1);
	});

	it("v2 的清单没写 connection:连接是挑出来的那种,连接配置项就是空表", () => {
		const h = harness({ manifest: v2({ contributes: { push: { display: DISPLAY } } }) });
		h.ctx.registerPushSource({ ...v2Def(), listBots: () => [] });
		expect(h.runtime.pushSource()?.connectionFields).toEqual([]);
	});

	it("v2 的代码里还交外观 / 字段表 —— 抛:两份声明会打架,以清单为准", () => {
		const h = harness({ manifest: v2() });
		expect(() => h.ctx.registerPushSource(def())).toThrow(/contributes\.push/);
		expect(h.adapters.list()).toEqual([]);
	});

	it("v1 的代码里没交外观 —— 抛:老格式的外观只在代码里", () => {
		const h = harness();
		expect(() => h.ctx.registerPushSource(v2Def())).toThrow(/descriptor/);
	});

	it("v2 清单里的连接配置项与代码的 zod 对不上 —— 抛,点名那一格", () => {
		const h = harness({
			manifest: v2({
				contributes: {
					push: {
						display: DISPLAY,
						connection: {
							fields: [V2_FIELDS[0], { type: "string", key: "bridgeKind", label: "哪一种桥" }],
						},
					},
				},
			}),
		});
		expect(() => h.ctx.registerPushSource(v2Def())).toThrow(/"bridgeKind"/);
	});

	it.each<[string, ExtensionManifest, RegExp]>([
		["v1 只声明了订阅源", { ...V1_PUSH, provides: ["subscription"] }, /provides/],
		[
			"v2 只开了订阅源",
			v2({
				contributes: {
					subscription: { display: DISPLAY, events: ["post"] },
				},
			}),
			/contributes\.push/,
		],
	])("%s —— 注册推送源当场抛,出口一个都不进表", (_label, manifest, message) => {
		const h = harness({ manifest });
		const register =
			manifest.apiVersion === 1
				? () => h.ctx.registerPushSource(def())
				: () => h.ctx.registerPushSource(v2Def());
		expect(register).toThrow(message);
		expect(h.adapters.list()).toEqual([]);
	});

	/**
	 * 🔴 **v1 的对表停在冻结那天**(`ExtensionManifestV1Schema`:格式已冻结,已经发出去的 v1 包
	 * 不能因为宿主升级就加载不了)。冻结时只对四样:第一层是对象、键不重复、键在 zod 里、zod
	 * 的必填键都有栏。类型 / 选项 / 默认值、读 zod 4 的 `_zod.def` 是 v2 才加的,不往 v1 身上加。
	 */
	describe("v1 的连接配置项只对冻结那天的四样", () => {
		const v1Def = (configSchema: ZodType, configFields: ExtensionConfigField[]) => ({
			adapter: fakeAdapter(),
			descriptor: descriptor(),
			configSchema,
			configFields,
		});

		it.each<[string, ZodType, ExtensionConfigField[]]>([
			[
				"zod 里有默认值、字段表没写",
				z.object({ port: z.number().default(8080) }),
				[{ kind: "number", code: "port", label: "端口" }],
			],
			[
				"下拉的选项与 zod 的取值对不上",
				z.object({ mode: z.enum(["a", "b"]) }),
				[{ kind: "select", code: "mode", label: "模式", options: [{ value: "a", label: "A" }] }],
			],
			[
				"字段表的类型与 zod 不一样",
				z.object({ port: z.string() }),
				[{ kind: "number", code: "port", label: "端口" }],
			],
			[
				"schema 不是 zod 4 造的(没有 _zod.def)",
				{
					shape: { port: { safeParse: (v: unknown) => ({ success: v !== undefined }) } },
				} as unknown as ZodType,
				[{ kind: "text", code: "port", label: "端口" }],
			],
		])("%s —— 照常注册", (_label, configSchema, configFields) => {
			const h = harness();
			h.ctx.registerPushSource(v1Def(configSchema, configFields));
			expect(h.adapters.list()).toHaveLength(1);
		});

		it.each<[string, ZodType, ExtensionConfigField[], RegExp]>([
			["第一层不是对象", z.string(), [], /对象/],
			[
				"同一个键摆了两栏",
				z.object({ token: z.string() }),
				[
					{ kind: "text", code: "token", label: "A" },
					{ kind: "text", code: "token", label: "B" },
				],
				/"token" 摆了两栏/,
			],
			[
				"字段表里有一格 zod 不认识",
				z.object({ token: z.string().optional() }),
				[{ kind: "text", code: "typoo", label: "手滑" }],
				/"typoo" 不是 config schema 的键/,
			],
			["zod 的必填键没有栏", z.object({ token: z.string() }), [], /必填键 "token"/],
		])("%s —— 照旧拒", (_label, configSchema, configFields, message) => {
			const h = harness();
			expect(() => h.ctx.registerPushSource(v1Def(configSchema, configFields))).toThrow(message);
			expect(h.adapters.list()).toEqual([]);
		});
	});

	/**
	 * v2 的设置项也是两份声明(清单一份、`ctx.settings(schema)` 交一份 zod),一样在拿设置的
	 * 那一刻对表。v1 没有这回事:桥的设置是手写页,清单里什么都没声明。
	 */
	describe("设置项对表", () => {
		const SETTINGS = z.object({ cookie: z.string(), interval: z.number().default(60) });
		const fields = (interval: Record<string, unknown>) => ({
			settings: {
				fields: [
					{ type: "string", key: "cookie", label: "Cookie", secret: true, required: true },
					{ type: "number", key: "interval", label: "间隔", ...interval },
				],
			},
		});

		it("对得上 —— 照常拿得到设置", () => {
			const h = harness({ manifest: v2(fields({ default: 60 })), settings: { cookie: "c" } });
			expect(h.ctx.settings(SETTINGS).get()).toEqual({ cookie: "c", interval: 60 });
		});

		it("对不上 —— 拿设置那一刻就抛,点名那一格", () => {
			const h = harness({ manifest: v2(fields({ default: 30 })) });
			expect(() => h.ctx.settings(SETTINGS)).toThrow(/"interval"/);
		});

		it("清单一栏设置都没声明,而 zod 有必填键 —— 抛(面板上根本没地方填)", () => {
			const h = harness({ manifest: v2() });
			expect(() => h.ctx.settings(SETTINGS)).toThrow(/"cookie"/);
		});

		it("v1 不对表 —— 桥的设置是手写页,清单里什么都没声明", () => {
			const h = harness({ settings: { cookie: "c" } });
			expect(h.ctx.settings(SETTINGS).get()).toEqual({ cookie: "c", interval: 60 });
		});
	});
});

/**
 * v2 交的视图是一组封闭的积木(ADR-0019 决策 20),宿主**先校验再下发**,不合规矩的**按块 / 按项**
 * 降级(决策 40)—— 怎么降级见 `view-check.test.ts`;这里钉 ctx 那一层:v2 走 `publishView`、交回
 * Promise 当场报错(不静默变成空视图)、同一个错只记一行、v1 的老口原样留着。
 */
describe("交给面板的视图", () => {
	/** 一格列表设置 —— 视图里 `items` 的键要对得上它与存着的项。 */
	const V2: ExtensionManifest = {
		...V1_PUSH,
		apiVersion: 2,
		settings: {
			fields: [
				{
					key: "links",
					type: "list",
					label: "桥接入",
					title: "name",
					fields: [{ key: "name", type: "string", label: "名字", required: true }],
				},
			],
		},
		contributes: { push: { display: { label: "桥", shortLabel: "桥", color: "#a855f7" } } },
	} as unknown as ExtensionManifest;
	const SETTINGS = { links: [{ id: "a", name: "家里那台" }] };

	/** 回调交回 Promise —— 类型上 `publishView` 不收,真拓展(没过类型检查的、JS 写的)照样交得出来。 */
	const asView = (fn: () => unknown) => fn as () => ExtensionView;

	const viewWarnings = (lines: string[]) =>
		lines.filter((line) => line.startsWith("warn") && line.includes("画不出来"));

	it("合规矩 —— 积木包在 { block } 里、项包在 { view } 里交出去", () => {
		const h = harness({ manifest: V2, settings: SETTINGS });
		const notice = { type: "notice", tone: "info", text: "照常" } as const;
		h.ctx.publishView(() => ({
			summary: { tone: "ok", text: [{ b: "2" }, " 个 bot 在线"] },
			page: [notice],
			items: { links: { a: { status: { tone: "ok", text: "已连接" } } } },
		}));
		expect(h.runtime.status()).toEqual({
			summary: { tone: "ok", text: [{ b: "2" }, " 个 bot 在线"] },
			page: [{ block: notice }],
			items: { links: { a: { view: { status: { tone: "ok", text: "已连接" } } } } },
		});
	});

	it("坏一块只换掉那一块,点名哪一格;同一个错只记一行", () => {
		const h = harness({ manifest: V2 });
		const notice = { type: "notice", tone: "info", text: "照常" } as const;
		h.ctx.publishView(
			asView(() => ({ page: [{ type: "notice", tone: "success", text: "好了" }, notice] })),
		);
		const shown = h.runtime.status() as ExtensionPanelView;
		expect(shown.page?.[0]).toMatchObject({
			fault: { where: "页上第 1 块(提示条)", reason: expect.stringContaining("tone") },
		});
		expect(shown.page?.[1]).toEqual({ block: notice });
		h.runtime.status();
		expect(viewWarnings(h.lines)).toHaveLength(1);
	});

	/**
	 * 接线:核视图时拿的是**这份清单**声明的动作(决策 42)—— 声明过的按钮照画,没声明的那一块换成
	 * 提示。零件(`view-check`)各自的测试证明不了 ctx 真把清单那一串交过去了。
	 */
	it("调拓展的按钮照清单的 actions 核:声明过的照画,没声明的那一块画不出来", () => {
		const h = harness({ manifest: { ...V2, actions: ["poll.now"] } as ExtensionManifest });
		const button = (action: string) =>
			({ type: "button", button: { kind: "action", label: "按我", action } }) as const;
		h.ctx.publishView(() => ({ page: [button("poll.now"), button("secret.backdoor")] }));
		const shown = h.runtime.status() as ExtensionPanelView;
		expect(shown.page?.[0]).toEqual({ block: button("poll.now") });
		expect(shown.page?.[1]).toMatchObject({
			fault: { reason: expect.stringContaining("secret.backdoor") },
		});
	});

	/** `items` 的第二层键认的是**现在**存着的项 —— 删掉一条之后,拓展还交它的样子就丢掉。 */
	it("items 的键照存着的设置核:删掉的那一项丢掉并记一行", () => {
		const h = harness({ manifest: V2, settings: SETTINGS });
		h.ctx.publishView(() => ({ items: { links: { a: {} } } }));
		expect((h.runtime.status() as ExtensionPanelView).items).toEqual({
			links: { a: { view: {} } },
		});
		h.setSettings({ links: [] });
		expect((h.runtime.status() as ExtensionPanelView).items).toEqual({ links: {} });
		expect(h.lines.some((line) => line.startsWith("warn") && line.includes("「a」"))).toBe(true);
	});

	/**
	 * 🔴 旧口 `publishStatus(() => unknown)` 对 async 回调静默给出一份空视图(决策 39)。v2 的专口当场
	 * 报错:那一口画成一条说清原因的提示,现存的项各写「状态未知」,日志记一行 —— 同一个错不每次都记。
	 */
	it("回调交回 Promise —— 当场一条提示说清要同步交,不当成空视图;只记一行", () => {
		const h = harness({ manifest: V2, settings: SETTINGS });
		h.ctx.publishView(asView(async () => ({ summary: { text: "迟到的" } })));
		const shown = h.runtime.status() as ExtensionPanelView;
		expect(shown.page).toEqual([
			{
				fault: {
					where: "整份视图",
					reason: expect.stringContaining("publishView 的回调要同步交回视图"),
				},
			},
		]);
		expect(shown.items?.links?.a).toMatchObject({ fault: { where: "这一项" } });
		expect(shown.summary).toBeUndefined();
		h.runtime.status();
		expect(viewWarnings(h.lines)).toHaveLength(1);
	});

	/** 交回的 Promise 后来 reject 了:没人接的话就是一条未处理的 rejection —— Node 默认会让进程退出。 */
	it("async 回调抛了 —— 同样一条提示,不留下未处理的 rejection", async () => {
		const h = harness({ manifest: V2 });
		h.ctx.publishView(
			asView(async () => {
				throw new Error("算视图时炸了");
			}),
		);
		expect(JSON.stringify(h.runtime.status())).toContain("publishView 的回调要同步交回视图");
		// 让那一发 rejection 落地 —— 没接住的话 vitest 会把它报成一条错误。
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it("回调同步抛了 —— 一条提示带着原话", () => {
		const h = harness({ manifest: V2 });
		h.ctx.publishView(() => {
			throw new Error("算视图时炸了");
		});
		expect(JSON.stringify(h.runtime.status())).toContain("算视图时炸了");
	});

	it("v2 叫 publishStatus —— 不受理,记一行说走 publishView", () => {
		const h = harness({ manifest: V2 });
		h.ctx.publishStatus(() => ({ summary: { text: "x" } }));
		expect(h.runtime.status()).toBeUndefined();
		expect(h.lines.some((line) => line.startsWith("warn") && line.includes("publishView"))).toBe(
			true,
		);
	});

	it("v1 叫 publishView —— 不受理(v1 的状态走 publishStatus)", () => {
		const h = harness();
		h.ctx.publishView(() => ({ summary: { text: "x" } }));
		expect(h.runtime.status()).toBeUndefined();
		expect(h.lines.some((line) => line.startsWith("warn") && line.includes("publishStatus"))).toBe(
			true,
		);
	});

	it("v1 —— 任意 JSON 原样下发(v1 的页是手写的)", () => {
		const h = harness();
		const status = { sessions: [{ linkId: "a", connected: false }] };
		h.ctx.publishStatus(() => status);
		expect(h.runtime.status()).toEqual(status);
	});
});

/**
 * 面板上的「调拓展」按钮(ADR-0019 决策 22):清单 `actions` 声明、代码 `ctx.onAction` 接。
 * 没声明的名字注册不上 —— 清单是面板能按哪些钮的全集,代码里多接一个等于开了一个清单里看
 * 不见的口。
 */
describe("动作", () => {
	const V2: ExtensionManifest = {
		...V1_PUSH,
		apiVersion: 2,
		actions: ["poll.now", "login.start"],
		contributes: { push: { display: { label: "桥", shortLabel: "桥", color: "#a855f7" } } },
	} as unknown as ExtensionManifest;

	it("声明了、接了 —— 跑得到", async () => {
		const h = harness({ manifest: V2 });
		let ran = 0;
		h.ctx.onAction("poll.now", () => {
			ran += 1;
		});
		expect(await h.runtime.runAction("poll.now")).toEqual({ ok: true });
		expect(ran).toBe(1);
	});

	it("清单里没声明的名字 —— 注册当场抛;同一个名字接两次也抛", () => {
		const h = harness({ manifest: V2 });
		expect(() => h.ctx.onAction("secret.backdoor", () => {})).toThrow(/secret\.backdoor/);
		h.ctx.onAction("poll.now", () => {});
		expect(() => h.ctx.onAction("poll.now", () => {})).toThrow(/poll\.now/);
	});

	/**
	 * 🔴 「声明过没有」只认清单那一串里的名字 —— 哪天退回拿普通对象按下标查,`constructor` /
	 * `toString` 会顺着原型链被判成「声明了」。清单校验那头已经拒这些名字,这里是第二道。
	 */
	it("Object.prototype 上的名字不算声明过:注册当场抛,跑是 undeclared", async () => {
		const h = harness({ manifest: V2 });
		expect(() => h.ctx.onAction("constructor", () => {})).toThrow(/没有 constructor/);
		expect(await h.runtime.runAction("toString")).toMatchObject({
			ok: false,
			reason: "undeclared",
		});
	});

	it("v1 清单没有 actions —— 注册就抛", () => {
		expect(() => harness().ctx.onAction("poll.now", () => {})).toThrow(/actions/);
	});

	it("跑的结果分清四种:没声明 / 声明了没接 / 抛了(带原话)/ 超时", async () => {
		const h = harness({ manifest: V2 });
		expect(await h.runtime.runAction("nope")).toMatchObject({ ok: false, reason: "undeclared" });
		expect(await h.runtime.runAction("login.start")).toMatchObject({
			ok: false,
			reason: "unhandled",
		});
		h.ctx.onAction("poll.now", async () => {
			throw new Error("抖音网关回了 403");
		});
		expect(await h.runtime.runAction("poll.now")).toEqual({
			ok: false,
			reason: "failed",
			message: "抖音网关回了 403",
		});
		const slow = harness({ manifest: V2 });
		slow.ctx.onAction("poll.now", () => new Promise(() => {}));
		expect(await slow.runtime.runAction("poll.now", { timeoutMs: 20 })).toMatchObject({
			ok: false,
			reason: "timeout",
		});
	});

	/**
	 * handler 收一个 `AbortSignal`(决策 42):超时那一刻宿主已经不等了,还让它接着跑,它做完的
	 * 事主人那头只看见一句「超时」—— 扫码登录这种会在背后多存下一份账号。
	 */
	it("超时 —— handler 拿到的 signal 当场中止(TimeoutError),之前没中止", async () => {
		const h = harness({ manifest: V2 });
		let seen: AbortSignal | undefined;
		h.ctx.onAction("poll.now", (signal) => {
			seen = signal;
			return new Promise(() => {});
		});
		const pending = h.runtime.runAction("poll.now", { timeoutMs: 20 });
		if (!seen) throw new Error("handler 应该当场被叫到,并拿到一个 signal");
		expect(seen.aborted).toBe(false);
		expect(await pending).toMatchObject({ ok: false, reason: "timeout" });
		expect(seen.aborted).toBe(true);
		expect((seen.reason as Error).name).toBe("TimeoutError");
	});

	/**
	 * 停用 / 收摊时还在跑的动作一并叫停(AbortError),而且在收摊钩子跑**之前** —— 钩子里能等它们
	 * 收尾。不叫停的话,拓展都停了,它的 handler 还在背后接着轮询平台。
	 */
	it("收摊 —— 还在跑的 handler 拿到的 signal 中止(AbortError),收摊钩子跑时已经中止", async () => {
		const h = harness({ manifest: V2 });
		let seen: AbortSignal | undefined;
		h.ctx.onAction("poll.now", (signal) => {
			seen = signal;
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason));
			});
		});
		let abortedWhenHookRan: boolean | undefined;
		h.ctx.onDispose(() => {
			abortedWhenHookRan = seen?.aborted;
		});
		const pending = h.runtime.runAction("poll.now");
		if (!seen) throw new Error("handler 应该当场被叫到,并拿到一个 signal");
		expect(seen.aborted).toBe(false);
		await h.runtime.dispose();
		expect(seen.aborted).toBe(true);
		expect((seen.reason as Error).name).toBe("AbortError");
		expect(abortedWhenHookRan).toBe(true);
		// 它听了 signal 抛出来 —— 面板那一发照常收到它的原话,不会挂到超时。
		expect(await pending).toMatchObject({ ok: false, reason: "failed" });
	});

	/**
	 * 同一个动作在跑时再按 → busy(路由回 409),**不排队、不并发**(决策 42):两发一起跑,扫码登录
	 * 就是两张码、两份轮询抢着存账号;排队的话,主人连按三下就在背后多跑两轮。不同的动作互不相干。
	 */
	it("同一个动作在跑时再按 —— busy;第一发照常跑完;不同的动作不互相挡;回来了又按得动", async () => {
		const h = harness({ manifest: V2 });
		let calls = 0;
		let finish: (() => void) | undefined;
		h.ctx.onAction("poll.now", () => {
			calls += 1;
			return new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		let logins = 0;
		h.ctx.onAction("login.start", () => {
			logins += 1;
		});

		const first = h.runtime.runAction("poll.now");
		expect(await h.runtime.runAction("poll.now")).toEqual({
			ok: false,
			reason: "busy",
			aborted: false,
		});
		expect(calls).toBe(1);
		expect(await h.runtime.runAction("login.start")).toEqual({ ok: true });
		expect(logins).toBe(1);

		finish?.();
		expect(await first).toEqual({ ok: true });
		const again = h.runtime.runAction("poll.now");
		expect(calls).toBe(2);
		finish?.();
		expect(await again).toEqual({ ok: true });
	});

	/**
	 * 「在跑」算到 handler 真的回来为止:超时叫停了它却不听,它就还在背后跑 —— 放第二发进去就是两发
	 * 并发。回 busy 时说清「已经叫停过了」,主人才知道不是自己按得太快。
	 */
	it("超时叫停了却不停的 —— 仍算在跑,再按是 busy,并说明已经叫停过", async () => {
		const h = harness({ manifest: V2 });
		let calls = 0;
		h.ctx.onAction("poll.now", () => {
			calls += 1;
			return new Promise(() => {});
		});
		expect(await h.runtime.runAction("poll.now", { timeoutMs: 20 })).toMatchObject({
			reason: "timeout",
		});
		expect(await h.runtime.runAction("poll.now", { timeoutMs: 20 })).toEqual({
			ok: false,
			reason: "busy",
			aborted: true,
		});
		expect(calls).toBe(1);
	});

	/** 收摊钩子还在跑时按下的:上面那一刻已经把在跑的都叫停了,这时再起一发就没人叫停它。 */
	it("收摊进行中按下的 —— 不再起新的一发", async () => {
		const h = harness({ manifest: V2 });
		let calls = 0;
		h.ctx.onAction("poll.now", () => {
			calls += 1;
		});
		let release: (() => void) | undefined;
		h.ctx.onDispose(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const disposing = h.runtime.dispose();
		expect(await h.runtime.runAction("poll.now")).toMatchObject({ ok: false, reason: "unhandled" });
		expect(calls).toBe(0);
		release?.();
		await disposing;
	});

	it("卸载之后动作一个都跑不到", async () => {
		const h = harness({ manifest: V2 });
		h.ctx.onAction("poll.now", () => {});
		await h.runtime.dispose();
		expect(await h.runtime.runAction("poll.now")).toMatchObject({ ok: false, reason: "unhandled" });
	});
});

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
	 * 🔴 **外观(v1 交的 descriptor)交上来是为了被画出来。** 收下就扔的话,面板只能自己
	 * 手抄一份短名与标识色 —— 而手抄的副本迟早跟拓展自己报的漂开,且门禁全绿
	 * (`platform-meta.tsx` 里就躺过这么一行,躺了整整一片)。
	 */
	it("交上来的外观留得住 —— 面板要拿它画那张脸", () => {
		const h = harness();
		h.ctx.registerPushSource(def());
		expect(h.runtime.pushSource()?.display).toMatchObject({ shortLabel: "桥" });
	});

	it("没注册推送源的拓展没有外观,而不是一份空壳", () => {
		expect(harness().runtime.pushSource()).toBeUndefined();
	});

	/**
	 * 🔴 **字段表交上来也是为了被画出来**(决策 33)—— 它此前只用来对表与找密钥键,面板
	 * 从没拿到过,于是推送目标页建不出拓展连接。同一族的洞:收下就扔,门禁全绿。
	 */
	it("交上来的字段表留得住 —— 面板照它画新建连接的表单", () => {
		const h = harness();
		h.ctx.registerPushSource(def());
		expect(h.runtime.pushSource()?.connectionFields.map((f) => f.key)).toEqual([
			"token",
			"bridgeKind",
		]);
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

	/**
	 * 🔴 入站是每条消息一趟的热路径。宿主的「全表」那口每问一次就 deepClone 整张连接表,
	 * 而校验归属只要那一条 —— 所以给了单条访问口就得走它,全表一次都不许问。
	 */
	it("校验归属走单条访问口,不问全表", () => {
		const h = harness();
		h.ctx.inbound.private({ userId: "u", text: "hi" }, meta("c1"));
		expect(h.inboundSeen).toHaveLength(1);
		expect(h.connectionReads()).toBe(1);
		expect(h.connectionsReads()).toBe(0);
	});

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

	it("卸载之后 statusChanged 被拒绝并留一行", async () => {
		const h = harness();
		await h.runtime.dispose();
		h.ctx.statusChanged();
		expect(h.statusChanges()).toBe(0);
		expect(h.lines.some((l) => l.startsWith("warn") && l.includes("statusChanged"))).toBe(true);
	});
});

/**
 * 现取的数据有个盲点:**什么时候该再取一次**面板不知道。桥那头 koishi 已经握完手,面板上那张卡还灰着,
 * 得切一下页才刷新。所以拓展要能喊一声「变了」,宿主把这声推到面板。
 *
 * 🔴 **按拓展合并**:每喊一声就是一帧 WS、面板整份重读一次视图 —— 桥上两百个 bot 陆续报上来就是两百次
 * 重读。短窗口里的连喊只发一次,落在窗口的**尾沿**:窗口里最后那一喊之后一定还有一发,面板重读到的
 * 是那一喊之后的样子。
 */
describe("statusChanged 合并", () => {
	const W = STATUS_CHANGED_COALESCE_MS;
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("一阵连喊只发一次,落在窗口的尾沿", () => {
		const h = harness();
		for (let i = 0; i < 200; i += 1) h.ctx.statusChanged();
		expect(h.statusChanges()).toBe(0);
		vi.advanceTimersByTime(W - 1);
		expect(h.statusChanges()).toBe(0);
		vi.advanceTimersByTime(1);
		expect(h.statusChanges()).toBe(1);
		vi.advanceTimersByTime(W * 10);
		expect(h.statusChanges()).toBe(1);
	});

	/**
	 * 最后一次不丢:**每一喊之后都还有一发** —— 窗口快满时那一喊由尾沿那一发带上;发过之后再喊,另起
	 * 一个窗口再发一次。「先发、窗口里的吞掉」那种合并,面板重读到的是最后一喊之前的样子。
	 */
	it("最后一次不丢:窗口快满时那一喊之后还有一发;发过之后再喊,再发一次", () => {
		const h = harness();
		h.ctx.statusChanged();
		vi.advanceTimersByTime(W - 1);
		h.ctx.statusChanged();
		const beforeTail = h.statusChanges();
		vi.advanceTimersByTime(1);
		expect(h.statusChanges()).toBe(beforeTail + 1);

		h.ctx.statusChanged();
		const beforeNext = h.statusChanges();
		vi.advanceTimersByTime(W);
		expect(h.statusChanges()).toBe(beforeNext + 1);
		expect(h.statusChanges()).toBe(2);
	});

	/**
	 * 窗口**不因为又喊了一声就往后推**:那样的话一个一直在喊的拓展(每 100ms 报一次)永远发不出去,
	 * 面板上那张卡一直是旧的。
	 */
	it("一直在喊也按窗口发,不会被饿死", () => {
		const h = harness();
		for (let t = 0; t < W * 10; t += W / 5) {
			h.ctx.statusChanged();
			vi.advanceTimersByTime(W / 5);
		}
		expect(h.statusChanges()).toBe(10);
	});

	/** 两个拓展各算各的:一个在连喊,另一个那一声照样按自己的窗口发出去。 */
	it("按拓展合并 —— 两个拓展互不相干", () => {
		const a = harness();
		const b = harness();
		a.ctx.statusChanged();
		vi.advanceTimersByTime(W / 2);
		b.ctx.statusChanged();
		vi.advanceTimersByTime(W / 2);
		expect([a.statusChanges(), b.statusChanges()]).toEqual([1, 0]);
		vi.advanceTimersByTime(W / 2);
		expect([a.statusChanges(), b.statusChanges()]).toEqual([1, 1]);
	});

	/**
	 * 「上报问题」(ADR-0019 决策 60)**不**喊「面板数据变了」:那一声说的是拓展的视图变了,面板会去重读
	 * 视图;上报问题有自己那一声(记录那头的 `extension-report-problems-changed`),两件事不搅在一起。
	 */
	it("上报问题不喊「面板数据变了」", async () => {
		const h = harness({
			manifest: {
				...V1_PUSH,
				apiVersion: 2,
				contributes: {
					subscription: {
						display: { label: "抖", shortLabel: "抖", color: "#161823" },
						events: ["post"],
					},
				},
			} as unknown as ExtensionManifest,
		});
		const source = h.ctx.registerSubscriptionSource({ lookup: () => [] });
		// 清单没声明下播:整条拒、记一条上报问题。
		await source.reportLiveEnd("person", { url: "https://live.example.com/1" }).catch(() => {});
		vi.advanceTimersByTime(W * 10);
		expect(h.statusChanges()).toBe(0);
		// 上报问题照样出去了 —— 这条不是因为压根没走到那个出口才绿的。
		expect(h.lines.some((line) => line.startsWith("warn") && line.includes("liveEnd"))).toBe(true);
	});

	/** 收摊时挂着的那一发清掉 —— 收摊之后再冒出一帧,面板会去重读一个已经停了的拓展。 */
	it("收摊时挂着的那一发清掉,收摊之后不再发", async () => {
		const h = harness();
		h.ctx.statusChanged();
		await h.runtime.dispose();
		vi.advanceTimersByTime(W * 10);
		expect(h.statusChanges()).toBe(0);
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
			manifest: V1_PUSH,
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
			subscriptions: () => [],
			onSubscriptionsChanged: () => ({ dispose() {} }),
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

	/**
	 * 🔴 形状不对**不再按没有算**(ADR-0019 决策 36):对桥那就是名单一空、插件收 401、按协议永久
	 * 不再重连。`ctx.settings()` 那一下当场抛,原因记在 runtime 上 —— 装载器凭它不起这个拓展。
	 */
	it("形状不对 → ctx.settings() 当场抛、点名那一格;原因记在 runtime 上,那份 zod 照样交了", () => {
		const h = harness({ settings: { links: "not-a-list" } });
		expect(() => h.ctx.settings(LINKS)).toThrow(/「links」/);
		expect(h.runtime.settingsProblem()).toContain("「links」");
		// 先交后判:改对了没有,装载器要拿这份判。
		expect(h.runtime.settingsSchemas()).toEqual([LINKS]);
	});

	it("是**现读**:面板改了下一次问就是新的", () => {
		const h = harness({ settings: { links: [] } });
		const settings = h.ctx.settings(LINKS);
		expect(settings.get()?.links).toHaveLength(0);
		h.setSettings({ links: [{ id: "a", token: "t" }] });
		expect(settings.get()?.links).toHaveLength(1);
	});

	/**
	 * 🔴 **`get()` 不去问宿主。**
	 *
	 * 宿主那头每问一次 `settings()` 都是 `getGlobals()` 现 deepClone 出来的一整份 —— 桥每握一次手
	 * 问一次。解析只在两下做:交进来那一下(当场判得出坏了没有),与落盘那一下(读一次去比内容,
	 * 变了就判、判过了才扇出)。缓存从前挂在「原始值的身份」上,键永远不同、永远不命中。
	 */
	it("连问好几次都不去问宿主;落了一次盘也只读那一次", () => {
		const h = harness({ settings: { links: [{ id: "a", token: "t" }] } });
		const settings = h.ctx.settings(LINKS);
		const before = h.settingsReads();
		settings.get();
		settings.get();
		settings.get();
		expect(h.settingsReads() - before).toBe(0);

		h.setSettings({ links: [] });
		const afterWrite = h.settingsReads();
		expect(settings.get()).toEqual({ links: [] });
		settings.get();
		expect(h.settingsReads() - afterWrite).toBe(0);
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
