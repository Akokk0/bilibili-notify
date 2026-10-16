// biome-ignore-all lint/suspicious/noExplicitAny: vitest mock class 字段/构造器入参故意保留 any,避免重复定义业务实例的窄类型
/**
 * 单元测试 — `createEngines` 的「无重启热重载」契约(独立端配置流向核心)。
 *
 * engines.ts 自身构造真实 DynamicPoller / LiveEngine / PushRouter / CommentaryGenerator /
 * ImageRenderer,代价太大且与本测试无关 —— 这里把这 5 个引擎包 `vi.mock` 成 spy class,
 * 用真实 NodeMessageBus 驱动事件,聚焦验证 engines.ts 的 wiring 与热重载分支:
 *
 *   boot:           push.start / dynamic.start 拉起;默认 globals 下 AI / image 不构造
 *   config-changed globals:  dynamic+live.updateConfig、push.setMaster 一并热推
 *   config-changed integration-settings: B 站自己的设置(cron / 健康检查间隔)按格各开各的门 ——
 *                            dynamic.updateConfig(新 dynamicCron 透传进 DynamicPollerConfig)、
 *                            (健康检查间隔归登录系统,见 `bilibili/auth/__tests__/auth-system-lifecycle.test.ts`);没变的格不动
 *   config-changed targets:  仅 push.setMaster 后早退(不触发 dynamic.updateConfig)
 *   config-changed 其它 scope:no-op
 *   AI 启 / 停 / 改:           lazy 构造 + 失效降级 + 已存在时 updateConfig
 *   image 配色热更:            puppeteer 在位时 imageRenderer.updateConfig
 *   subscription-changed / auth-restored / auth-lost: 转译并下发到引擎
 *   dispose():                stop 全引擎 + 解绑 bus(dispose 后 config-changed 不再生效)
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	AuthState,
	Connection,
	ConnectionCapabilities,
	GlobalConfig,
	PlatformAdapter,
	Post,
	PostEvent,
	ProbeResult,
	PushTarget,
	SettingsReader,
	SourceAuth,
	SourceContext,
	Subscription,
} from "@bilibili-notify/internal";
import {
	DEFAULT_MESSAGE_LAYOUT,
	fail,
	type Identity,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
	ok,
	sameIdentity,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import type { Push } from "@bilibili-notify/push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { registryOf } from "../../__tests__/support/adapter-ctx.js";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import {
	deferred,
	makeTrackingContext,
	stillPending,
} from "../../__tests__/support/track-context.js";
import { makeLiveProblems } from "../../bilibili/live/session/__tests__/support/live-problems.js";
import { type BiliSettings, BiliSettingsSchema } from "../../bilibili/settings.js";
import type { ConfigStore } from "../../config/store.js";
import { createHistoryStore } from "../../history/store.js";
import { imageRefOf } from "../../images/image-store.js";
import { createLinkResolverRegistry } from "../../link-preview/registry.js";
import { createProblemTable, type ProblemTable } from "../../problems/problem-table.js";
import { makeSource } from "../../subscriptions/__tests__/fixtures.js";
import { createSourceRegistry, type SourceRegistry } from "../../subscriptions/registry.js";
import { CARD_BG_CURSORS_FILE, CARD_BG_DIR } from "../card-assets.js";
import { segmentContentBuilder } from "../content-builder.js";
import { createNodeMessageBus } from "../message-bus.js";
import { dataPath } from "../roots.js";
import type { NodeServiceContext } from "../service-context.js";

// ---- 引擎包 spy mocks(每次构造把实例塞进 H.<engine>,字段方法均为 vi.fn)----
const H = vi.hoisted(() => ({
	push: [] as any[],
	live: [] as any[],
	ai: [] as any[],
	image: [] as any[],
}));

vi.mock("@bilibili-notify/push", () => ({
	PushRouter: class {
		opts: any;
		start = vi.fn();
		stop = vi.fn();
		setMaster = vi.fn();
		push = vi.fn(async () => []);
		notifyMaster = vi.fn(async () => ({ ok: true as const, latencyMs: 1 }));
		constructor(opts: any) {
			this.opts = opts;
			H.push.push(this);
		}
	},
}));

vi.mock("../../bilibili/live/index.js", () => {
	return {
		// 拓展直播(ADR-0019 决策 67)用的直播装配、文案渲染与两处小规矩住在 `live/`,不经这里,不用 mock。
		LiveEngine: class {
			opts: any;
			start = vi.fn();
			stop = vi.fn();
			updateConfig = vi.fn();
			setCommentary = vi.fn();
			setImageRenderer = vi.fn();
			applyOps = vi.fn();
			rebuildFromSubs = vi.fn();
			teardown = vi.fn();
			listLiveSnapshots = vi.fn(() => []);
			constructor(opts: any) {
				this.opts = opts;
				H.live.push(this);
			}
		},
	};
});

// 落盘函数前的闸默认敞开;只有「后台写登记进 track」那组用例才 hold(见 support/storage-write-gate.ts)。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

vi.mock("@bilibili-notify/ai", async (importOriginal) => ({
	// 订阅视图拼 creator 用的纯函数,走真的。
	creatorOf: (await importOriginal<typeof import("@bilibili-notify/ai")>()).creatorOf,
	CommentaryGenerator: class {
		opts: any;
		start = vi.fn();
		updateConfig = vi.fn();
		/**
		 * 构造后 engines.ts 会立刻 `attachReadOnlyTools` 把只读工具接上。替身少了
		 * 这个方法会当场抛,而 buildCommentary 的 try/catch 会把它吞成「AI 初始化
		 * 失败」—— 表现是 H.ai 里有实例但 start 一次没调,不是一眼能看懂的报错。
		 */
		setCreatorReader = vi.fn();
		/** 作品装配的 AI 点评(经 `deps.ai()` 每条现取)。 */
		comment = vi.fn(async (..._args: unknown[]) => "点评");
		/** 同上:engines.ts 构造后还会接联网搜索的执行器热读口。 */
		setWebSearchSource = vi.fn();
		constructor(opts: any) {
			this.opts = opts;
			H.ai.push(this);
		}
	},
	webSearchExecutorFromSettings: () => null,
}));

vi.mock("@bilibili-notify/image", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bilibili-notify/image")>();
	return {
		// 拓展订阅造卡用的常量与纯函数(作品翻 `Post` 的图廊张数),走真的。
		GALLERY_MAX_IMAGES: actual.GALLERY_MAX_IMAGES,
		formatCardTime: actual.formatCardTime,
		// 引擎把它当 transform 交给字体读取器 —— 真身在 packages/image,这里只要个能认出来的替身。
		buildFontFace: (dataUrl: string) => `@font-face{src:url("${dataUrl}")}`,
		ImageRenderer: class {
			opts: any;
			updateConfig = vi.fn();
			generatePostCard = vi.fn(async (..._args: unknown[]) => Buffer.from("card"));
			generateLiveCard = vi.fn(async (..._args: unknown[]) => Buffer.from("live-card"));
			constructor(opts: any) {
				this.opts = opts;
				H.image.push(this);
			}
		},
	};
});

// SUT must be imported AFTER the vi.mock calls register.
const {
	createEngines,
	liveTypeToFeature,
	liveTypeAllowsAtAll,
	buildLiveSubViewSingle,
	boundLivePush,
	postSettingsOf,
} = await import("../engines.js");

// Mirror of koishi/live/src/__tests__/live-type-to-feature.test.ts — the two
// adapter helpers MUST stay byte-consistent across ends (same business core,
// different shells). liveTypeAllowsAtAll guards the @全体 bug fix: only
// StartBroadcasting(3) is at-all-eligible; periodic「正在直播」(0) and the boot catch-up (11) are NOT.
describe("apps/server adapter live-type map (cross-end mirror)", () => {
	it("liveTypeToFeature 完整映射表 + 未知兜底 liveStart", () => {
		expect(liveTypeToFeature(0)).toBe("liveStreaming"); // 周期「正在直播」有自己的特性键(⑬d 拆键)
		expect(liveTypeToFeature(3)).toBe("liveStart");
		expect(liveTypeToFeature(4)).toBe("membership");
		expect(liveTypeToFeature(6)).toBe("superchat");
		expect(liveTypeToFeature(7)).toBe("viewerChat");
		expect(liveTypeToFeature(8)).toBe("viewerEnter");
		expect(liveTypeToFeature(9)).toBe("liveEnd");
		expect(liveTypeToFeature(11)).toBe("liveStart"); // 重启补报走开播的路由
		expect(liveTypeToFeature(999)).toBe("liveStart");
	});

	it("liveTypeAllowsAtAll:仅开播(3)允许,0/补报(11)/其它/未知一律 false", () => {
		expect(liveTypeAllowsAtAll(3)).toBe(true);
		expect(liveTypeAllowsAtAll(0)).toBe(false);
		for (const t of [4, 6, 7, 8, 9, 11, 999]) {
			expect(liveTypeAllowsAtAll(t)).toBe(false);
		}
	});
});

/**
 * 拓展订阅的直播那一跳(ADR-0019 决策 67):装配交来的消息组 → 推送层的一次推送,**特性键与 @全体 照 B 站的映射**
 * (`liveTypeToFeature` / `liveTypeAllowsAtAll`)。掉了哪一样都是静默的:开关与路由按错的特性走、每条
 * 「正在直播」都 @全体、历史把周期推送记成开播。
 */
describe("boundLivePush — 拓展直播的四种推送照 B 站的映射交给推送层", () => {
	const card = { kind: "image" as const, buffer: Buffer.from("card"), mime: "image/jpeg" };
	const spy = () => {
		const push = vi.fn(async (_push: Push) => []);
		return { push, router: { push } };
	};

	it("开播:特性 liveStart(历史就记它)、允许 @全体;一组 = 一条载荷,卡 + 文字合成一条", async () => {
		const { push, router } = spy();
		await boundLivePush(router, "sub-1")([[card, { kind: "text", text: "开播啦" }]], 3);
		expect(push).toHaveBeenCalledTimes(1);
		const sent = push.mock.calls[0]?.[0];
		expect(sent).toEqual({
			subscriptionId: "sub-1",
			feature: "liveStart",
			anchors: [
				{
					role: "main",
					messages: [
						{
							kind: "composite",
							segments: [
								{ kind: "image", buffer: card.buffer, mime: "image/jpeg" },
								{ kind: "text", text: "开播啦" },
							],
						},
					],
				},
			],
		});
	});

	it("正在直播:特性 liveStreaming(自己的开关与目标,历史就记它)、不 @全体", async () => {
		const { push, router } = spy();
		await boundLivePush(router, "sub-1")([[{ kind: "text", text: "还在播" }]], 0);
		expect(push.mock.calls[0]?.[0]).toEqual({
			subscriptionId: "sub-1",
			feature: "liveStreaming",
			allowAtAll: false,
			anchors: [{ role: "main", messages: [{ kind: "text", text: "还在播" }] }],
		});
	});

	it("重启补报:特性 liveStart(走开播的路由,历史记成开播)、不 @全体", async () => {
		const { push, router } = spy();
		await boundLivePush(router, "sub-1")([[{ kind: "text", text: "补报" }]], 11);
		expect(push.mock.calls[0]?.[0]).toMatchObject({ feature: "liveStart", allowAtAll: false });
	});

	it("下播:特性 liveEnd、不 @全体;几组 = 本体那一个锚点里的一串载荷", async () => {
		const { push, router } = spy();
		await boundLivePush(router, "sub-1")([[card], [{ kind: "text", text: "下播啦" }]], 9);
		expect(push.mock.calls[0]?.[0]).toEqual({
			subscriptionId: "sub-1",
			feature: "liveEnd",
			allowAtAll: false,
			anchors: [
				{
					role: "main",
					messages: [
						{ kind: "image", image: { buffer: card.buffer, mime: "image/jpeg" } },
						{ kind: "text", text: "下播啦" },
					],
				},
			],
		});
	});
});

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeSubCtx() {
	const tracking = makeTrackingContext();
	return {
		logger: makeLogger(),
		setInterval: vi.fn(() => ({ dispose() {} })),
		setTimeout: vi.fn(() => ({ dispose() {} })),
		onDispose: vi.fn(),
		track: tracking.track,
		signal: tracking.signal,
	};
}

function cachedSubCtx() {
	const made = new Map<string, ReturnType<typeof makeSubCtx>>();
	return (name: string, levelKey: string) => {
		const key = JSON.stringify([name, levelKey]);
		let ctx = made.get(key);
		if (!ctx) {
			ctx = makeSubCtx();
			made.set(key, ctx);
		}
		return ctx;
	};
}

function makeServiceCtx() {
	// 发出去不管的写登记进 `track`(切片 ③):`tracking.tracked` 是登记进来的每一件后台活,
	// `tracking.abort()` 模拟关停开始。
	const tracking = makeTrackingContext();
	return {
		logger: makeLogger(),
		setInterval: vi.fn(() => ({ dispose() {} })),
		setTimeout: vi.fn(() => ({ dispose() {} })),
		onDispose: vi.fn(),
		// 与真的一样:同一对(标签,键)交回同一个;不同对各是一个。
		forSubsystem: vi.fn(cachedSubCtx()),
		track: tracking.track,
		signal: tracking.signal,
		tracking,
	};
}

function makeConfigStore(
	initial: GlobalConfig,
	bus: ReturnType<typeof createNodeMessageBus>,
	initialBilibili: BiliSettings,
) {
	let g = initial;
	let bilibili = initialBilibili;
	let targets: PushTarget[] = [];
	let connections: Connection[] = [];
	return {
		getGlobals: () => g,
		// 按键读(来源上下文的 `settings` 把手走这一口):替身与真仓一样,没登记的键当场抛(组装处漏了登记)。
		readIntegrationSettings: (key: string) => {
			if (key !== "bilibili") throw new Error(`集成「${key}」没有登记`);
			return ok({ settings: structuredClone(bilibili) as unknown });
		},
		// 与真仓同一条路:挂在 bus 的 `config-changed` 上,只交 scope。
		onChange: (handler: (scope: string) => void) =>
			bus.on("config-changed", ({ scope }) => handler(scope)),
		getTargets: () => targets,
		getConnections: () => connections,
		patchTarget: vi.fn(async () => {}),
		patchConnection: vi.fn(async () => {}),
		recordConnectionProbeState: vi.fn(async () => {}),
		recordTargetReachability: vi.fn(async () => {}),
		_set: (next: GlobalConfig) => {
			g = next;
		},
		_getBilibili: () => bilibili,
		_setBilibili: (next: BiliSettings) => {
			bilibili = next;
		},
		_setTargets: (next: PushTarget[]) => {
			targets = next;
		},
		_setConnections: (next: Connection[]) => {
			connections = next;
		},
	};
}

interface Ctx {
	runtime: ReturnType<typeof createEngines>;
	bus: ReturnType<typeof createNodeMessageBus>;
	serviceCtx: ReturnType<typeof makeServiceCtx>;
	configStore: ReturnType<typeof makeConfigStore>;
	api: {
		fetchRelations: ReturnType<typeof vi.fn>;
		follow?: ReturnType<typeof vi.fn>;
	};
	/** 开机时 `registerSource` 登进去的假来源(`noSource` 时它存在但没登记)。 */
	source: ReturnType<typeof makeSource>;
	/** `registerSource` 落定:登记表里有它、关停时才收得到。需要在 dispose 前就保证登记完成的用例先 await 它。 */
	sourceReady: Promise<void>;
	/** `registerSource` 的登记项带进去的日志器(来源上下文的 `ctx.logger` 该是它)。 */
	sourceLogger: ReturnType<typeof makeLogger>;
	sources: SourceRegistry;
	/** 递给 `createEngines` 的问题表(真表):来源上下文往里写、通知器听它。 */
	problems: ProblemTable;
}

function setup(opts?: {
	globals?: GlobalConfig;
	/** 开机那一刻的 B 站设置(只给要改的几格,其余取格式的默认值);不给 = 全默认。 */
	bilibili?: Partial<BiliSettings>;
	puppeteer?: boolean;
	subs?: Subscription[];
	/** 配置表里的连接(开机健康探测会挨个探它们)。 */
	connections?: Connection[];
	/** 平台实现(探测 / 能力都问它)。 */
	platformAdapters?: PlatformAdapter[];
	/** 开发版的推送截流(接线层给的);不给 = 不传。 */
	interceptSend?: Parameters<typeof createEngines>[0]["interceptSend"];
	/** 卡片皮肤那三口(接线层给的);不给 = 这台机器只有内置默认皮肤。 */
	cardSkins?: Parameters<typeof createEngines>[0]["cardSkins"];
	/** 拓展订阅的平台名(接线层给的);不给 = 女仆那份视图退拓展 id。 */
	extensionPlatformLabel?: Parameters<typeof createEngines>[0]["extensionPlatformLabel"];
	/** 拓展订阅推送现取的那几样(接线层给的);不给 = 不接拓展订阅的推送。 */
	extensionSources?: Parameters<typeof createEngines>[0]["extensionSources"];
	/** 拓展作品往图库存图的口(接线层给的 `runtime.postImages`);给了 `extensionSources` 而不给它,默认一个存什么都成功的替身;`null` = 真的不传。 */
	postImages?: Parameters<typeof createEngines>[0]["postImages"] | null;
	/** 拓展直播往图库存封面与事件头像的口(接线层给的 `runtime.liveImages`);给了 `extensionSources` 与 `liveTable` 而不给它,默认一个存什么都成功的替身;`null` = 真的不传。 */
	liveImages?: Parameters<typeof createEngines>[0]["liveImages"] | null;
	/** 出图器的「图库引用 → 地址」口(接线层给的);不给 = 不传。 */
	resolveImageRef?: Parameters<typeof createEngines>[0]["resolveImageRef"];
	/** AI 点评看只有图库引用的图时读字节的口(接线层给的);不给 = 一个什么都读不到的替身。 */
	readImage?: Parameters<typeof createEngines>[0]["readImage"];
	/** 拓展订阅的在播表与上报出入框(接线层给的);不给 = 不接拓展订阅的直播。 */
	liveTable?: Parameters<typeof createEngines>[0]["liveTable"];
	onReportDiscrepancy?: Parameters<typeof createEngines>[0]["onReportDiscrepancy"];
	/** 大航海徽章图标(接线层给的 `runtime.guardIcons`);不给 = 一个什么都没有的替身。 */
	guardIcons?: Parameters<typeof createEngines>[0]["guardIcons"];
	/** B 站作品图 / 直播封面的抓图服务(接线层用 B 站接口的请求客户端建的);不给 = 一个什么都抓不到的替身。 */
	imageFetcher?: Parameters<typeof createEngines>[0]["imageFetcher"];
	/** 开机那一刻的登录状态;不给 = 未登录。 */
	loginStatus?: "logged-in" | "confirming";
	/** 不给引擎登记那个假来源(测「来源没在跑」)。 */
	noSource?: boolean;
	/** 给直播引擎的 B 站分层上报器;不给 = 四个方法都是 spy 的假件。 */
	biliProblems?: Parameters<typeof createEngines>[0]["biliProblems"];
	/** 数据目录;不给 = 一个不存在的临时目录(不落盘的用例都用它)。 */
	dataDir?: string;
	/** 换掉存储替身里的几个口子(登记进 track 的那组用例让写停在半路)。 */
	overrides?: {
		configStore?: Record<string, unknown>;
		historyStore?: unknown;
		subRuntimeStore?: Record<string, unknown>;
		api?: Record<string, unknown>;
	};
}): Ctx {
	const serviceCtx = makeServiceCtx();
	const bus = createNodeMessageBus();
	const configStore = Object.assign(
		makeConfigStore(
			opts?.globals ?? makeDefaultGlobalConfig(),
			bus,
			BiliSettingsSchema.parse(opts?.bilibili ?? {}),
		),
		opts?.overrides?.configStore,
	);
	if (opts?.connections) configStore._setConnections(opts.connections);
	// 关系查询回「都已关注」:补关注走到这一步就停,不再发写请求。
	const api = {
		fetchRelations: vi.fn(async (uids: string[]) => ({
			code: 0,
			data: Object.fromEntries(uids.map((uid) => [uid, { attribute: 2 }])),
		})),
		...opts?.overrides?.api,
	};
	const auth = {
		state: (): AuthState =>
			opts?.loginStatus === "logged-in"
				? { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" }
				: opts?.loginStatus === "confirming"
					? { status: "confirming", message: "正在确认" }
					: { status: "logged-out" },
	};
	const subs = opts?.subs ?? [];
	const sources = createSourceRegistry();
	const source = makeSource();
	const problems = createProblemTable({ logger: serviceCtx.logger });
	const biliProblems = opts?.biliProblems ?? makeLiveProblems();
	const runtime = createEngines({
		sources,
		linkResolvers: createLinkResolverRegistry(),
		problems,
		biliProblems,
		serviceCtx: serviceCtx as unknown as NodeServiceContext,
		// 背景轮换游标 fs 路径取自此。指向 OS 临时目录下一个**不存在**的子目录(跨平台:
		// Windows/macOS/Linux 都解析为各自 tmp 根):load 读不到走 catch 返回 {};测试不触发
		// 轮换故游标不脏、dispose 不写盘(即便写,目标在 tmp 下也无害)。不含任何真实路径/密钥。
		dataRoot: opts?.dataDir ?? join(tmpdir(), "bn-engines-test-no-such-dir"),
		// 这批用例不碰自带字体;真实实现由 runtime 传进来,这里给个空实现即可。
		loadFontFace: async () => "",
		api: api as any,
		auth,
		configStore: configStore as unknown as ConfigStore,
		historyStore: (opts?.overrides?.historyStore ?? { record: vi.fn(async () => {}) }) as any,
		subscriptionStore: {
			list: () => subs,
			findByIdentity: (identity: Identity) =>
				subs.find((s) => sameIdentity(subscriptionIdentityOf(s), identity)),
			listByIdentity: (identity: Identity) =>
				subs.filter((s) => sameIdentity(subscriptionIdentityOf(s), identity)),
			findById: (id: string) => subs.find((s) => s.id === id),
		} as any,
		subRuntimeStore: {
			get: () => undefined,
			getAll: () => ({}),
			patch: vi.fn(async () => {}),
			prune: vi.fn(async () => {}),
			load: vi.fn(async () => {}),
			...opts?.overrides?.subRuntimeStore,
		} as any,
		bus,
		adapters: registryOf(opts?.platformAdapters ?? []),
		...(opts?.interceptSend ? { interceptSend: opts.interceptSend } : {}),
		guardIcons: opts?.guardIcons ?? {
			ensure: async () => {},
			iconOf: () => undefined,
			refs: () => [],
		},
		imageFetcher: opts?.imageFetcher ?? {
			fetchImage: async () => fail("unavailable", "测试替身不联网"),
		},
		puppeteer: opts?.puppeteer ? ({} as any) : null,
		...(opts?.cardSkins ? { cardSkins: opts.cardSkins } : {}),
		...(opts?.extensionPlatformLabel
			? { extensionPlatformLabel: opts.extensionPlatformLabel }
			: {}),
		...(opts?.extensionSources ? { extensionSources: opts.extensionSources } : {}),
		...(opts?.extensionSources && opts.postImages !== null
			? {
					postImages: opts.postImages ?? {
						put: async () => ({ ok: true as const, ref: `${"0".repeat(63)}1.png` }),
					},
				}
			: {}),
		...(opts?.resolveImageRef ? { resolveImageRef: opts.resolveImageRef } : {}),
		readImage: opts?.readImage ?? (async () => undefined),
		...(opts?.liveTable ? { liveTable: opts.liveTable } : {}),
		...(opts?.extensionSources && opts.liveTable && opts.liveImages !== null
			? {
					liveImages: opts.liveImages ?? {
						put: async () => ({ ok: true as const, ref: `${"0".repeat(63)}2.png` }),
					},
				}
			: {}),
		...(opts?.onReportDiscrepancy ? { onReportDiscrepancy: opts.onReportDiscrepancy } : {}),
	});
	// 登记即 start:`start` 与键的认领都在同一个同步段里发生(下面 await 的只是登记表的收尾)。
	const sourceLogger = makeLogger();
	const sourceReady = opts?.noSource
		? Promise.resolve()
		: runtime.registerSource({
				sourceKey: "bilibili",
				source,
				// 来源上下文的 logger 是登记项带进来的(组装根造的),不取自集成上下文;集成上下文的其余格在这批用例里不被碰
				// (这里的 logger 故意是基础 logger,与登记项带的不同,「ctx.logger 来自哪」的用例才分得出)。
				integration: { logger: serviceCtx.logger } as any,
				logger: sourceLogger,
			});
	// 没人 await 它就 dispose 的用例:关停后登记作废会让它 reject,这里挂一条旁支吞掉「未处理的 rejection」,
	// sourceReady 本身仍会 reject(await 它的用例照样看得到)。
	sourceReady.catch(() => {});
	lastSetup = {
		runtime,
		bus,
		serviceCtx,
		configStore,
		api,
		source,
		sourceReady,
		sourceLogger,
		sources,
		problems,
	};
	return lastSetup;
}
/** 最近一次 `setup()` 的结果(`reportBili` 默认往它上面交作品)。 */
let lastSetup: Ctx | null = null;

/** structuredClone 当前 globals → mutate → 写回 store(模拟 ConfigStore.patch 后的快照)。 */
/** 开机时 `forSubsystem(name, levelKey)` 交出去的那个子上下文(按标签与键取)。 */
function subsystemCtx(c: Ctx, name: string, levelKey: string): ReturnType<typeof makeSubCtx> {
	const calls = c.serviceCtx.forSubsystem.mock.calls as unknown as [string, string][];
	const index = calls.findIndex(([n, k]) => n === name && k === levelKey);
	const found = c.serviceCtx.forSubsystem.mock.results[index]?.value;
	if (!found) throw new Error(`没有 ${name}/${levelKey} 子上下文`);
	return found;
}

function patchGlobals(c: Ctx, mutate: (g: GlobalConfig) => void): void {
	const next = structuredClone(c.configStore.getGlobals());
	mutate(next);
	c.configStore._set(next);
}

/**
 * 当前 B 站设置 → mutate → 写回替身(模拟配置仓写入之后的快照)。过一遍格式,与真仓一样永远是规范形态
 * (设置读者的把手靠比序列化判变没变,键序要稳)。
 */
function patchBilibili(c: Ctx, mutate: (b: BiliSettings) => void): void {
	const next = structuredClone(c.configStore._getBilibili());
	mutate(next);
	c.configStore._setBilibili(BiliSettingsSchema.parse(next));
}

function aiGlobals(): GlobalConfig {
	const g = makeDefaultGlobalConfig();
	// 连接字段住在服务商桶里(各家一套配置)。
	g.ai.activeProfile = "deepseek";
	g.ai.providers = {
		deepseek: {
			provider: "deepseek",
			label: "",
			apiKey: "k-test",
			baseUrl: "https://api.example.com",
			model: "gpt-4o-mini",
			apiFlavor: "chat",
			enableThinking: false,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			vision: { baseUrl: "", apiKey: "", model: "" },
		},
	};
	return g;
}

/** 一条 B 站来的中立作品(引擎翻好、图已抓好的样子)。 */
const bilibiliPost = (text = "正文", over: Partial<Post> = {}): Post => ({
	creator: { name: "阿绫" },
	publishedAt: "2026-10-10T00:00:00.000Z",
	text,
	...over,
});
/** B 站来源把一条作品交给核心入口:走来源上下文的 `reportPost`(`registerSource` 建的那个),走真的队列与真的装配。 */
const reportBili = (uid: string, post: Post = bilibiliPost(), postId = "d1"): void => {
	if (!lastSetup) throw new Error("reportBili 要在 setup() 之后用");
	lastSetup.source.reportPost(uid, { postId, url: `https://t.bilibili.com/${postId}`, post });
};
const biliSubOf = (uid = "1", id = `sub-${uid}`): Subscription =>
	makeEmptySubscription({ id, identity: { sourceKey: "bilibili", externalId: uid } });
/** 等登记进 `track` 的后台活全部落定(包括落定途中又登记的):凡断言「没推」都得先等它。 */
async function settleTracked(c: Ctx): Promise<void> {
	const { tracking } = c.serviceCtx;
	let seen: number;
	do {
		seen = tracking.tracked.length;
		await tracking.settled();
	} while (tracking.tracked.length !== seen);
}
/** 推送层收到的每一次作品推送里,本体那个锚点的每条消息的文字(模板那一份)。 */
async function mainTexts(): Promise<string[]> {
	return anchorTexts("messages");
}
/** 同上,AI 写的那一份(只有生成了点评的推送才有)。 */
async function aiTexts(): Promise<string[]> {
	return anchorTexts("aiMessages");
}
async function anchorTexts(field: "messages" | "aiMessages"): Promise<string[]> {
	const out: string[] = [];
	for (const [sent] of H.push[0].push.mock.calls) {
		const messages = (await sent.anchors[0]?.[field]) ?? [];
		for (const m of messages) {
			out.push(
				m.kind === "text"
					? m.text
					: (m.segments?.find((s: { kind: string }) => s.kind === "text")?.text ?? m.kind),
			);
		}
	}
	return out;
}
const TEMPLATE_GLOBALS = (template: string): GlobalConfig => {
	const g = makeDefaultGlobalConfig();
	g.defaults.templates.post = template;
	return g;
};

let active: Ctx | null = null;
beforeEach(() => {
	H.push.length = 0;
	H.live.length = 0;
	H.ai.length = 0;
	H.image.length = 0;
	active = null;
});
afterEach(() => {
	try {
		active?.runtime.dispose();
	} catch {
		/* best-effort */
	}
});

// ---------------------------------------------------------------------------
// adapter 接线 —— 「真实开播时刻」这条链路唯一没人守的一段
//
// apps/server/src/bilibili/live 侧钉住了 RoomSession **发出** startedAt,recorder 侧钉住了它**消费**
// startedAt,live-midstream-start 还把 recorder→store→aggregate 三层串起来测了。
// 唯独把两头缝上的这一行没有任何测试:它是 adapter 里的一句 lambda,少写 `at`
// 依然类型正确(载荷上 at 是可选的)、构建全绿、2483 条测试全过,而整个特性
// 静默退回「我们发现的时刻」—— 统计侧按 startedAt 认场次,同一场随即被记成两条。
// ---------------------------------------------------------------------------

describe("createEngines — live-state-changed 接线", () => {
	it("startedAt 一路转发到 bus,不在 adapter 这层被吃掉", () => {
		const c = setup();
		active = c;
		const seen: unknown[][] = [];
		c.bus.on("live-state-changed", ({ uid, status, at: startedAt }) => {
			seen.push([uid, status, startedAt]);
		});
		// 直接调 adapter 交给引擎的那个回调 —— 被测的就是这句 lambda 本身。
		H.live[0].opts.emitLiveState("u1", "live", "2026-05-16T12:00:00.000Z");
		expect(seen).toEqual([["u1", "live", "2026-05-16T12:00:00.000Z"]]);
	});

	it("下播不带 startedAt —— 它只在开播时有意义", () => {
		const c = setup();
		active = c;
		const seen: unknown[][] = [];
		c.bus.on("live-state-changed", ({ uid, status, at: startedAt }) => {
			seen.push([uid, status, startedAt]);
		});
		H.live[0].opts.emitLiveState("u1", "idle", undefined);
		expect(seen).toEqual([["u1", "idle", undefined]]);
	});
});

/**
 * 观看人数一路是精确数(㉒d,只改类型不改名):引擎节流后发的 `emitViewers(uid, 数)` 原样转成总线事件
 * `live-viewers-changed { uid, viewers }`(统计、WS、面板都挂在它后面);在播快照里的 `viewers` 也原样进
 * 「正在直播」那份快照。两处都是 adapter 里的一句 lambda,各自的单测证明不了接上了。
 */
describe("createEngines — 大航海徽章图标接线", () => {
	const makeIcons = (ensure: () => Promise<void>) => ({
		ensure: vi.fn(ensure),
		iconOf: vi.fn(() => undefined),
		refs: () => [],
	});

	const biliSub = () =>
		makeEmptySubscription({ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" } });

	// 验红:把 engines.ts 里 `live.start` 旁边那句 `void opts.guardIcons.ensure()` 删掉,这条红(开机没人去抓徽章,首条上舰才补抓)。
	it("有 B 站直播订阅、直播引擎起来时调一次 ensure(),而且不等它:抓图永不返回时 createEngines 照样建成", () => {
		const guardIcons = makeIcons(() => new Promise<void>(() => {}));
		const c = setup({ guardIcons, subs: [biliSub()] });
		expect(guardIcons.ensure).toHaveBeenCalledTimes(1);
		expect(c.runtime).toBeDefined();
	});

	// 验红:把那句挪到 `if` 外面(无条件开机就抓),这条红 —— 不带订阅的真开机 e2e 也会去连 B 站静态站,被测试的外网闸判红。
	it("没有 B 站订阅(直播引擎没起来)时开机不去抓图,等首条上舰或预览再补", () => {
		const guardIcons = makeIcons(async () => {});
		setup({ guardIcons });
		expect(guardIcons.ensure).not.toHaveBeenCalled();
	});

	// 验红:把 engines.ts 里递给 LiveEngine 的 `guardIcons: opts.guardIcons` 删掉,这条红(直播间拿不到图标)。
	it("同一份 guardIcons 递给 LiveEngine(上舰卡取图标用它)", () => {
		const guardIcons = makeIcons(async () => {});
		setup({ guardIcons });
		expect(H.live[0].opts.guardIcons).toBe(guardIcons);
	});
});

describe("createEngines — B 站图的抓图服务接线(3a-34)", () => {
	// 验红:把 engines.ts 里递给 LiveEngine 的 `imageFetcher: opts.imageFetcher` 删掉,这条红
	// (直播卡出卡前没人去抓图,封面只剩地址,出图器只认引用 —— 一张图都没有而门禁全绿)。
	// 动态那一半:来源把 `deps.imageFetcher` 递给引擎在 `bilibili/__tests__/source.test.ts`,
	// `compose.ts` 把入参那个递给来源在 `__tests__/compose.test.ts`。
	it("抓图服务递给 LiveEngine", () => {
		const imageFetcher = { fetchImage: vi.fn() } as unknown as NonNullable<
			Parameters<typeof createEngines>[0]["imageFetcher"]
		>;
		setup({ imageFetcher });
		expect(H.live[0].opts.imageFetcher).toBe(imageFetcher);
	});
});

describe("createEngines — 直播引擎的问题上报器接线", () => {
	// 验红:把 engines.ts 里递给 LiveEngine 的 `problems: opts.biliProblems` 删掉(或换成别的对象),这条红
	// (直播间停监、撞风控报到了空处,问题表里永远没有它们,而门禁全绿)。
	// 入口把 `builtins.bilibili.problems` 递进 `biliProblems` 这一环,靠类型(必填格)+ 审查 + 真机:
	// `compose.test.ts` 钉着「给来源的与挂在 `bilibili.problems` 上的是同一个」。
	it("入口递进来的 B 站分层上报器,就是直播引擎拿到的那个", () => {
		const biliProblems = makeLiveProblems();
		setup({ biliProblems });
		expect(H.live[0].opts.problems).toBe(biliProblems);
	});

	it("直播引擎的私聊口没了:递给它的 push 上只有 push", () => {
		setup();
		expect(Object.keys(H.live[0].opts.push)).toEqual(["push"]);
	});
});

describe("createEngines — 卡上主播头像的读口接线(3a-35)", () => {
	// 验红:把 engines.ts 里递给 LiveEngine 的 `avatarOf: profileAvatarOf` 换成 undefined(类型会先红),
	// 或把读口改成开机时取一次值,对应那条红 —— 之后才补上的头像永远出不了卡。
	it("直播引擎拿到的读口按订阅 id 现读订阅资料,资料之后换了值,下一次读到新的", () => {
		let profile: { avatar?: string } = {};
		const get = vi.fn((_id: string) => ({ cachedProfile: profile }));
		setup({ overrides: { subRuntimeStore: { get } } });
		const opts = H.live[0].opts;
		expect(opts.avatarOf("sub-1")).toBeUndefined();
		profile = { avatar: `${"c".repeat(64)}.jpg` };
		expect(opts.avatarOf("sub-1")).toBe(profile.avatar);
		expect(get).toHaveBeenLastCalledWith("sub-1");
	});

	// 作品这头:头像由核心出卡那一刻按订阅 id 现读(`deps.avatar`),引擎不再有头像读口。
	// 验红:把 engines.ts 里 postQueue 的 `avatar: profileAvatarOf` 去掉(或改成开机取一次),这条红。
	it("B 站作品:出卡器收到的 Post.creator.avatar 是出卡那一刻订阅资料里的头像,资料之后换了值,下一张卡用新的", async () => {
		let profile: { avatar?: string } = {};
		const get = vi.fn((_id: string) => ({ cachedProfile: profile }));
		const c = setup({
			puppeteer: true,
			subs: [biliSubOf("1")],
			overrides: { subRuntimeStore: { get } },
		});
		active = c;
		reportBili("1", bilibiliPost("第一条"), "d1");
		await settleTracked(c);
		profile = { avatar: `${"b".repeat(64)}.jpg` };
		reportBili("1", bilibiliPost("第二条"), "d2");
		await settleTracked(c);
		const handed = H.image[0].generatePostCard.mock.calls.map((call: unknown[]) => call[0] as Post);
		expect(handed).toHaveLength(2);
		expect(handed[0]?.creator.avatar).toBeUndefined();
		expect(handed[1]?.creator.avatar).toBe(profile.avatar);
		expect(get).toHaveBeenCalledWith("sub-1");
	});
});

describe("createEngines — 观看人数接线(精确数)", () => {
	it("emitViewers 的精确数原样转发到 bus 的 live-viewers-changed,不被转成字符串", () => {
		const c = setup();
		active = c;
		const seen: unknown[] = [];
		c.bus.on("live-viewers-changed", (payload) => seen.push(payload));
		// 验红:把 engines.ts 里那句 `emitViewers` 改成 `String(viewers)`(或整句删掉),这条红。
		H.live[0].opts.emitViewers("u1", 87_334);
		expect(seen).toEqual([{ uid: "u1", viewers: 87_334 }]);
	});

	it("在播快照的 viewers 原样进 listLiveRooms(精确数;没收到过帧就没有这个键的值)", () => {
		const c = setup({
			subs: [
				makeEmptySubscription({ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" } }),
				makeEmptySubscription({ id: "s2", identity: { sourceKey: "bilibili", externalId: "2" } }),
			],
		});
		active = c;
		H.live[0].listLiveSnapshots.mockReturnValue([
			{ uid: "1", roomId: "r1", isLive: true, viewers: 87_334 },
			{ uid: "2", roomId: "r2", isLive: true },
		]);
		// 验红:把 `listLiveRooms` 里的 `viewers: s.viewers` 去掉,这条红。
		const rooms = c.runtime.listLiveRooms();
		expect(rooms.map((r) => r.viewers)).toEqual([87_334, undefined]);
	});
});

/**
 * 「正在直播」的快照带着订阅自己的 id(ADR-0019 决策 50):面板拿它对订阅,同一个 UP 配了两条
 * 订阅时也认得出是哪一条。直播引擎只认 uid,翻译在宿主这边做。
 */
describe("createEngines — 在播快照带订阅 id", () => {
	it("每个在播房间带上对应订阅的 id;uid 翻不到订阅的房间不出现", () => {
		const c = setup({
			subs: [
				makeEmptySubscription({ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" } }),
			],
		});
		active = c;
		H.live[0].listLiveSnapshots.mockReturnValue([
			{ uid: "1", roomId: "r1", isLive: true, title: "在播" },
			// 监听器只为在册的订阅开,翻不到只可能是刚删掉的那一瞬。
			{ uid: "404", roomId: "r2", isLive: true, title: "刚删掉的那位" },
		]);
		expect(c.runtime.listLiveRooms()).toEqual([
			{ subscriptionId: "s1", uid: "1", roomId: "r1", isLive: true, title: "在播" },
		]);
	});
});

/**
 * 出图连续失败「只提醒一次」的计数全进程一份(ADR-0019 决策 66):B 站动态与拓展作品用的是同一个
 * 渲染器,各记各的话同一次故障会各提醒主人一遍。计数在 createEngines 里建一份,交给作品入口(两条路都经它装配)。
 * 哪条路换成自己建的一份,类型与别的测试全绿,只有这一条红。
 */
describe("createEngines — 出图失败计数 B 站与拓展作品共用一份", () => {
	it("拓展作品出图失败提醒过之后,B 站作品同一串失败不再提醒;告警的来源是同一个 post-delivery,主人只收到一条私聊", async () => {
		const ext = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const c = setup({
			puppeteer: true,
			subs: [ext, biliSubOf("1")],
			extensionSources: {
				running: () => true,
				postNoun: () => "作品",
				events: () => ["post", "liveStart", "liveEnd"],
			},
		});
		active = c;
		H.image[0].generatePostCard.mockRejectedValue(new Error("浏览器挂了"));

		c.bus.emit("subscription-reported", {
			extensionId: "douyin",
			externalId: "sec-uid-1",
			subscriptionIds: [ext.id],
			report: {
				kind: "post",
				value: { id: "p1", url: "https://www.douyin.com/video/p1", publishedAt: Date.now() },
			},
		});
		await vi.waitFor(() => expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1));
		await settleTracked(c);
		reportBili("1");
		await settleTracked(c);
		expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(2);

		// 告诉主人的只有一路:engine-error 经 MasterNotifier 的那条(带 `[post-delivery]` 前缀)。作品投递不再
		// 自己直发一条。两条路共用一份计数、一个来源(60 秒节流键),第二次失败不会再补一条,面板上也只亮一次。
		const texts = H.push[0].notifyMaster.mock.calls.map((call: unknown[]) => String(call[0]));
		expect(texts).toHaveLength(1);
		expect(texts[0]).toMatch(/^\[post-delivery\] 生成动态图片失败：浏览器挂了/);
	});
});

/**
 * 拓展作品的图走图库(ADR-0021 决策 22 下 2026-10-05 的 🔗,㉑d):作品卡是 `Post`,配图 / 封面 / 事件带来的头像
 * 经 `postImages` 存进图库、`Post` 里只放引用;出图器出卡前经注入的 `resolveImageRef` 把引用换成地址。三处接线
 * (`postImages` 传给消费者、资料里的头像引用传给消费者、`resolveImageRef` 传给出图器)各自的单元测试都证明不了
 * engines 真的接上了,漏接的症状是作品卡上一张图都没有而门禁全绿。
 */
describe("createEngines — 拓展作品的图走图库", () => {
	const AVATAR_REF = `${"a".repeat(63)}1.png`;
	/** 存图的口:回图库起的那个名字(内容哈希)。写盘推迟到出卡,翻译时算的引用必须与它一致。 */
	const storing = () =>
		vi.fn(async (bytes: Uint8Array) => {
			const ref = imageRefOf(bytes);
			if (!ref) throw new Error("夹具图不合规");
			return { ok: true as const, ref };
		});
	const sources = {
		running: () => true,
		postNoun: () => undefined,
		events: () => ["post", "liveStart", "liveEnd"] as const,
	};
	const PNG_1X1 = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
		0, 0, 0, 1, 8, 6, 0, 0, 0,
	]);

	function report(sub: { id: string }, value: Record<string, unknown> = {}) {
		return {
			extensionId: "douyin",
			externalId: "sec-uid-1",
			subscriptionIds: [sub.id],
			report: {
				kind: "post" as const,
				value: {
					id: "p1",
					url: "https://www.douyin.com/video/p1",
					publishedAt: Date.now(),
					...value,
				},
			},
		};
	}

	/** 出图器收到的 `Post`(第一个参数)。 */
	const postOf = (call: unknown[]) =>
		call[0] as { creator: { avatar?: string }; images?: unknown[] };

	it("给了 extensionSources 却没给 postImages:开机就抛,不悄悄不出图", () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		// 验红:删掉 engines.ts 里 `if (!postImages) throw …` 那一行,这条红。
		expect(() =>
			setup({ puppeteer: true, subs: [sub], extensionSources: sources, postImages: null }),
		).toThrow(/postImages/);
	});

	it("事件带来的头像与配图经 postImages 存(交给核心之前就写盘),出图器收到的 Post 里是图库的引用", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const put = storing();
		const c = setup({
			puppeteer: true,
			subs: [sub],
			extensionSources: sources,
			postImages: { put },
		});
		active = c;
		c.bus.emit(
			"subscription-reported",
			report(sub, { author: { name: "作者", avatar: PNG_1X1 }, images: [PNG_1X1] }),
		);
		await vi.waitFor(() => expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1));
		// 验红:删掉 engines.ts 里传给 bindExtensionPosts 的 `postImages,` 这一行,这条红。
		// 头像和配图各存一次(同一份字节,同一个引用)。
		expect(put).toHaveBeenCalledTimes(2);
		const post = postOf(H.image[0].generatePostCard.mock.calls[0] ?? []);
		expect(post.creator.avatar).toBe(imageRefOf(PNG_1X1));
		expect(post.images).toEqual([expect.objectContaining({ ref: imageRefOf(PNG_1X1) })]);
	});

	it("事件没带头像:订阅资料里存的头像引用顶上(不再存一遍)", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const put = storing();
		const c = setup({
			puppeteer: true,
			subs: [sub],
			extensionSources: sources,
			postImages: { put },
			overrides: {
				subRuntimeStore: {
					get: (id: string) =>
						id === sub.id
							? {
									cachedProfile: {
										name: "资料名",
										avatar: AVATAR_REF,
										sign: "",
										lastRefreshedAt: "2026-10-05T00:00:00.000Z",
									},
								}
							: undefined,
				},
			},
		});
		active = c;
		c.bus.emit("subscription-reported", report(sub));
		await vi.waitFor(() => expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1));
		// 验红:删掉 engines.ts 里 postQueue 的 `avatar: profileAvatarOf,` 那一行,这条红(头像退成没有)。
		expect(postOf(H.image[0].generatePostCard.mock.calls[0] ?? []).creator.avatar).toBe(AVATAR_REF);
		expect(put).not.toHaveBeenCalled();
	});

	it("出图器拿到接线层给的 resolveImageRef", () => {
		const resolveImageRef = vi.fn(async () => undefined);
		const c = setup({ puppeteer: true, resolveImageRef });
		active = c;
		// 验红:删掉 engines.ts 里 `resolveImageRef: opts.resolveImageRef,` 那一行,这条红。
		expect(H.image[0].opts.resolveImageRef).toBe(resolveImageRef);
	});

	// AI 点评看只有图库引用的图(拓展作品)时,核心要量字节数再编成 data URL,读口由接线层给(`runtime.imageStore.read`)。
	// 验红:把 engines.ts 里 postQueue 的 `readImage: opts.readImage,` 换成恒回 undefined,这条红(点评看不到图)。
	it("AI 点评看拓展作品只有引用的图:核心经接线层给的 readImage 读出字节,编成 data URL 交给点评", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const aiOn = aiGlobals();
		aiOn.ai.enabled = true;
		const readImage = vi.fn(async (_ref: string) => ({
			bytes: Uint8Array.from([1, 2, 3]),
			mime: "image/png",
		}));
		const c = setup({
			globals: aiOn,
			subs: [sub],
			extensionSources: sources,
			readImage,
		});
		active = c;
		c.bus.emit("subscription-reported", report(sub, { text: "有图的作品", images: [PNG_1X1] }));
		await vi.waitFor(() => expect(H.ai[0].comment).toHaveBeenCalledTimes(1));
		// 接线层的默认存图替身给的就是这个引用。
		expect(readImage).toHaveBeenCalledWith(`${"0".repeat(63)}1.png`);
		expect(H.ai[0].comment.mock.calls[0]?.[2]).toEqual([
			`data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
		]);
	});
});

/**
 * **作品入口的接线**:B 站动态引擎的 `reportPost` 选项由接线层给 —— 按身份查出订阅、把引擎交的作品包成信封
 * 入队(`createPostQueue`),入口再同步发 `post-detected`、按订阅串行跑装配、交给推送层。零件各自的单元测试证明不了
 * 接线真接上了,所以这里走**真的队列、真的装配**(只假推送层与出卡器),断言到 `PushRouter.push` 的入参;
 * 凡断言「没推」的先等登记进 track 的活落定,旁边有对照。
 */
describe("createEngines — 作品入口接线(B 站引擎 → PostQueue → 推送层)", () => {
	it("引擎交的作品:按身份查订阅、入口同步发 post-detected(订阅 id、身份、叫法「动态」),随后推送层收到订阅 id + 特性 post + 模板文字与链接", async () => {
		const sub = biliSubOf("1");
		const c = setup({ subs: [sub], globals: TEMPLATE_GLOBALS("{name}更新了") });
		active = c;
		const detected: PostEvent[] = [];
		c.bus.on("post-detected", (event) => detected.push(event));
		const post = bilibiliPost("正文");

		reportBili("1", post, "d1");

		// 同步:入口里就发了,不等装配。
		expect(detected).toEqual([
			{
				subscriptionId: sub.id,
				identity: { sourceKey: "bilibili", externalId: "1" },
				postId: "d1",
				url: "https://t.bilibili.com/d1",
				post,
				postNoun: "动态",
			},
		]);
		await settleTracked(c);
		expect(H.push[0].push).toHaveBeenCalledTimes(1);
		const [sent] = H.push[0].push.mock.calls[0];
		expect(sent).toMatchObject({ subscriptionId: sub.id, feature: "post" });
		expect(sent.anchors).toHaveLength(1);
		expect(sent.anchors[0].role).toBe("main");
		expect(await mainTexts()).toEqual(["阿绫更新了\nhttps://t.bilibili.com/d1"]);
	});

	// 验红:把 `subscriptions/source-context.ts` 里 `reportPost` 的 `listByIdentity` 换回 `findByIdentity` 取一条,这条红。
	it("同一个 uid 配了两条订阅(遗留的重复订阅):按身份展开,每条各一份 —— 两次推送、两个订阅 id、post-detected 两次", async () => {
		const first = biliSubOf("1", "sub-first");
		const second = biliSubOf("1", "sub-second");
		const c = setup({ subs: [first, second] });
		active = c;
		const detected: PostEvent[] = [];
		c.bus.on("post-detected", (event) => detected.push(event));
		reportBili("1");
		await settleTracked(c);
		expect(detected.map((e) => e.subscriptionId)).toEqual(["sub-first", "sub-second"]);
		expect(H.push[0].push).toHaveBeenCalledTimes(2);
		const pushedIds = H.push[0].push.mock.calls.map(
			([sent]: [{ subscriptionId: string }]) => sent.subscriptionId,
		);
		expect(pushedIds.sort()).toEqual(["sub-first", "sub-second"]);
	});

	// 验红:把 post-queue.ts 里入口按订阅查设置那道 `deps.settings(id) === undefined` 短路掉(恒不丢),这条红。
	it("展开时各管各的:两条里后一条停用 → 只推前一条", async () => {
		const first = biliSubOf("1", "sub-first");
		const second = { ...biliSubOf("1", "sub-second"), enabled: false };
		const c = setup({ subs: [first, second] });
		active = c;
		const detected: PostEvent[] = [];
		c.bus.on("post-detected", (event) => detected.push(event));
		reportBili("1");
		await settleTracked(c);
		// 入口那一道:停用的那条一开始就不收(不发事件);对照第一条照收。
		expect(detected.map((e) => e.subscriptionId)).toEqual(["sub-first"]);
		expect(H.push[0].push).toHaveBeenCalledTimes(1);
		expect(H.push[0].push.mock.calls[0]?.[0].subscriptionId).toBe("sub-first");
	});

	it("展开时各管各的:两条里后一条作品开关关着 → 只推前一条", async () => {
		const first = biliSubOf("1", "sub-first");
		const second = biliSubOf("1", "sub-second");
		second.overrides.features = { post: false };
		const c = setup({ subs: [first, second] });
		active = c;
		const detected: PostEvent[] = [];
		c.bus.on("post-detected", (event) => detected.push(event));
		reportBili("1");
		await settleTracked(c);
		expect(detected.map((e) => e.subscriptionId)).toEqual(["sub-first"]);
		expect(H.push[0].push).toHaveBeenCalledTimes(1);
		expect(H.push[0].push.mock.calls[0]?.[0].subscriptionId).toBe("sub-first");
	});

	it("uid 对不上订阅、订阅停用、作品开关关着 → 不发事件也不推;对照:订阅在、启用、开着就推", async () => {
		const live = biliSubOf("1");
		const disabled = { ...biliSubOf("2"), enabled: false };
		const postOff = biliSubOf("3");
		postOff.overrides.features = { post: false };
		const c = setup({ subs: [live, disabled, postOff] });
		active = c;
		const detected: PostEvent[] = [];
		c.bus.on("post-detected", (event) => detected.push(event));
		for (const uid of ["404", "2", "3"]) reportBili(uid);
		await settleTracked(c);
		expect(detected).toEqual([]);
		expect(H.push[0].push).not.toHaveBeenCalled();

		reportBili("1");
		await settleTracked(c);
		expect(detected).toHaveLength(1);
		expect(H.push[0].push).toHaveBeenCalledTimes(1);
	});

	// 「来源在跑」读口问的是来源登记表(内置来源)与拓展读口(拓展订阅):拓展停了,等着的作品不补(决策 61);
	// B 站来源没登记(或撤了)也不推。
	// 验红:把 engines.ts 里 `sourceRunning` 改成恒真,拓展那段与 B 站那段都红。
	it("来源没在跑:拓展订阅与没登记的 B 站来源的作品都不推;对照:拓展在跑、B 站来源登了就推", async () => {
		const ext = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		let running = false;
		const c = setup({
			subs: [ext, biliSubOf("1")],
			extensionSources: {
				running: () => running,
				postNoun: () => "作品",
				events: () => ["post"],
			},
		});
		active = c;
		const extReport = () =>
			c.bus.emit("subscription-reported", {
				extensionId: "douyin",
				externalId: "sec-uid-1",
				subscriptionIds: [ext.id],
				report: {
					kind: "post" as const,
					value: { id: "p1", url: "https://www.douyin.com/video/p1", publishedAt: Date.now() },
				},
			});
		extReport();
		await settleTracked(c);
		expect(H.push[0].push).not.toHaveBeenCalled(); // 拓展没在跑

		// B 站来源在登记表里:不看拓展在不在跑。
		reportBili("1");
		await settleTracked(c);
		expect(H.push[0].push).toHaveBeenCalledTimes(1);

		// 登记表里暂时认不出 B 站来源(用读口模拟「没登记」):同一条订阅的作品被丢。
		await c.sourceReady;
		const realGet = c.sources.get;
		c.sources.get = (key) => (key === "bilibili" ? undefined : realGet(key));
		reportBili("1", bilibiliPost("没人认领"), "d2");
		await settleTracked(c);
		expect(H.push[0].push).toHaveBeenCalledTimes(1);
		c.sources.get = realGet;

		running = true;
		extReport();
		await settleTracked(c);
		expect(H.push[0].push).toHaveBeenCalledTimes(2);
	});

	// 验红:把 engines.ts 里 bindExtensionPosts 的 `postNoun: (extensionId) => extensionSources.postNoun(extensionId)` 换成
	// 恒回 undefined,这条红(叫法退回「动态」)。
	it("拓展清单里的平台叫法一路走到 AI 提示词:「发布了一条视频」", async () => {
		const ext = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const aiOn = aiGlobals();
		aiOn.ai.enabled = true;
		const c = setup({
			globals: aiOn,
			subs: [ext],
			extensionSources: {
				running: () => true,
				postNoun: (extensionId) => (extensionId === "douyin" ? "视频" : undefined),
				events: () => ["post"],
			},
		});
		active = c;
		c.bus.emit("subscription-reported", {
			extensionId: "douyin",
			externalId: "sec-uid-1",
			subscriptionIds: [ext.id],
			report: {
				kind: "post" as const,
				value: {
					id: "p1",
					url: "https://www.douyin.com/video/p1",
					publishedAt: Date.now(),
					text: "今天去海边",
					author: { name: "甲" },
				},
			},
		});
		await vi.waitFor(() => expect(H.ai[0].comment).toHaveBeenCalledTimes(1));
		expect(H.ai[0].comment.mock.calls[0]?.[0]).toBe("甲发布了一条视频，内容如下：\n今天去海边");
	});
});

/**
 * 作品过滤的接线(㉑e,ADR-0021 决策 43):过滤直接吃折好的 `ContentFilters`(配置怎么叫它就怎么叫,从前
 * `dynamicFilterOf` 那层翻译删了),B 站动态引擎与拓展作品**同一份过滤、类型开关对所有来源生效**。
 * 各自的单元测试证明不了 engines 真的把全局 / 按 UP 的过滤递到了两条路上:漏递的症状是该挡的作品照推。
 */
describe("createEngines — 作品过滤接线", () => {
	const sources = {
		running: () => true,
		postNoun: () => "作品",
		events: () => ["post"] as const,
	};
	const PNG = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
		0, 0, 0, 1, 8, 6, 0, 0, 0,
	]);
	const extReport = (sub: { id: string }, value: Record<string, unknown>) => ({
		extensionId: "douyin",
		externalId: "sec-uid-1",
		subscriptionIds: [sub.id],
		report: {
			kind: "post" as const,
			value: {
				id: "p1",
				url: "https://www.douyin.com/video/p1",
				publishedAt: Date.now(),
				...value,
			},
		},
	});
	const videoReport = (sub: { id: string }) =>
		extReport(sub, { text: "新视频", video: { title: "一期" }, images: undefined });
	const imagesReport = (sub: { id: string }) => extReport(sub, { text: "返图", images: [PNG] });
	const textReport = (sub: { id: string }) => extReport(sub, { text: "只有字" });

	function extSetup(over: { globals?: GlobalConfig; sub?: Subscription } = {}) {
		const sub =
			over.sub ?? makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const c = setup({
			puppeteer: true,
			subs: [sub],
			extensionSources: sources,
			...(over.globals ? { globals: over.globals } : {}),
		});
		active = c;
		return { c, sub };
	}
	const globalsWith = (filters: Partial<GlobalConfig["defaults"]["filters"]>): GlobalConfig => {
		const g = makeDefaultGlobalConfig();
		Object.assign(g.defaults.filters, filters);
		return g;
	};

	// 验红:把 engines.ts 里 `dispose` 开头收 `sourceRegistrations` 的那一段挪到 `handles` 那一段之后,这条红
	// (到那时作品入口那一排总线监听 `handles` 已经摘了)。
	it("dispose 里来源的 stop() 早于作品入口那一排 handles 收尾:stop 同步段里总线上的监听还在", async () => {
		const { c } = extSetup();
		await c.sourceReady;
		let liveListenerAlive = false;
		c.source.stop.mockImplementation(async () => {
			// `handles` 里有订阅变更 → 直播引擎的那条监听:它还在,说明 handles 还没收。
			H.live[0].applyOps.mockClear();
			c.bus.emit("subscription-changed", { ops: [] });
			liveListenerAlive = H.live[0].applyOps.mock.calls.length > 0;
		});
		c.runtime.dispose();
		expect(c.source.stop).toHaveBeenCalledTimes(1);
		expect(liveListenerAlive).toBe(true);
	});

	// 验红:把 engines.ts 里 `const handles: Disposable[] = [postQueue]` 的 postQueue 拿掉,这条红。
	it("dispose 关掉作品入口:关停之后拓展再交的作品不发 post-detected、不推;对照:关停之前交的照推", async () => {
		const { c, sub } = extSetup();
		const detected: PostEvent[] = [];
		c.bus.on("post-detected", (event) => detected.push(event));
		c.bus.emit("subscription-reported", textReport(sub));
		await vi.waitFor(() => expect(H.push[0].push).toHaveBeenCalledTimes(1));

		c.runtime.dispose();
		c.bus.emit("subscription-reported", textReport(sub));
		await settleTracked(c);
		expect(detected).toHaveLength(1);
		expect(H.push[0].push).toHaveBeenCalledTimes(1);
	});

	// 验红:把 engines.ts 里 `filter: eff.filters` 换成空规则,这条红(B 站的作品也经同一份折叠)。
	it("B 站来源交来的作品按全局 defaults.filters 过滤:被挡的不出卡不推,没挡的照推", async () => {
		const g = globalsWith({ blockKeywords: ["禁词"] });
		const c = setup({ puppeteer: true, subs: [biliSubOf("1")], globals: g });
		active = c;
		reportBili("1", bilibiliPost("含禁词的动态"), "d1");
		reportBili("1", bilibiliPost("正常的动态"), "d2");
		await settleTracked(c);
		expect(H.push[0].push).toHaveBeenCalledTimes(1);
		expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1);
		expect(H.image[0].generatePostCard.mock.calls[0]?.[0]).toMatchObject({ text: "正常的动态" });
	});

	it("改全局过滤:不经来源热更,下一条作品立即按新的过滤(过滤不在来源里)", async () => {
		const c = setup({ puppeteer: true, subs: [biliSubOf("1")] });
		active = c;
		const video = bilibiliPost("视频", { video: { cover: {}, title: "一期", description: "" } });
		reportBili("1", video, "d1");
		await settleTracked(c);
		expect(H.push[0].push).toHaveBeenCalledTimes(1); // 过滤还没开,推了
		patchGlobals(c, (g) => {
			g.defaults.filters.blockVideos = true;
		});
		c.bus.emit("config-changed", { scope: "globals" });
		reportBili("1", video, "d2");
		await settleTracked(c);
		expect(H.push[0].push).toHaveBeenCalledTimes(1); // 新的过滤生效,第二条被挡
		expect(c.source.start).toHaveBeenCalledTimes(1); // 来源没被重启 / 重登
	});

	it("拓展作品:全局开着「屏蔽视频」,视频作品被挡(不出卡不推);没挡的类型照推", async () => {
		const { c, sub } = extSetup({ globals: globalsWith({ blockVideos: true }) });
		// 验红:把 engines.ts 里递给 bindExtensionPosts 的 `filter: eff.filters` 换成空规则,这条红。
		c.bus.emit("subscription-reported", videoReport(sub));
		c.bus.emit("subscription-reported", textReport(sub));
		await vi.waitFor(() => expect(H.push[0].push).toHaveBeenCalledTimes(1));
		// 只有那条纯文字的出了卡、推了;视频那条被挡在过滤上。
		expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1);
		expect(H.image[0].generatePostCard.mock.calls[0]?.[0]).toMatchObject({ text: "只有字" });
	});

	it("拓展作品:全局开着「屏蔽图集」,带配图的作品被挡", async () => {
		const { c, sub } = extSetup({ globals: globalsWith({ blockImages: true }) });
		c.bus.emit("subscription-reported", imagesReport(sub));
		c.bus.emit("subscription-reported", textReport(sub));
		await vi.waitFor(() => expect(H.push[0].push).toHaveBeenCalledTimes(1));
		expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1);
		expect(H.image[0].generatePostCard.mock.calls[0]?.[0]).toMatchObject({ text: "只有字" });
	});

	it("拓展作品:类型开关都关着,视频与配图照推(出厂行为)", async () => {
		const { c, sub } = extSetup();
		c.bus.emit("subscription-reported", videoReport(sub));
		c.bus.emit("subscription-reported", imagesReport(sub));
		await vi.waitFor(() => expect(H.push[0].push).toHaveBeenCalledTimes(2));
	});

	it("拓展作品:这位 UP 的按 UP 覆盖盖过全局(全局拦视频,这位单独放开 → 照推)", async () => {
		const open = makeExtensionSubscription({
			extensionId: "douyin",
			externalId: "sec-uid-1",
			overrides: { filters: { blockVideos: false } },
		});
		const a = extSetup({ globals: globalsWith({ blockVideos: true }), sub: open });
		a.c.bus.emit("subscription-reported", videoReport(a.sub));
		await vi.waitFor(() => expect(H.push[0].push).toHaveBeenCalledTimes(1));
	});

	it("拓展作品:按 UP 覆盖只拦这一位 —— 全局没开,这位单独开「屏蔽视频」就挡", async () => {
		const strict = makeExtensionSubscription({
			extensionId: "douyin",
			externalId: "sec-uid-1",
			overrides: { filters: { blockVideos: true } },
		});
		const { c, sub } = extSetup({ sub: strict });
		c.bus.emit("subscription-reported", videoReport(sub));
		c.bus.emit("subscription-reported", textReport(sub));
		await vi.waitFor(() => expect(H.push[0].push).toHaveBeenCalledTimes(1));
		expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1);
	});

	/**
	 * **被过滤的作品留痕的接线**(ADR-0021 决策 34 的 🔗)。两条路(B 站动态引擎、拓展作品)都经核心入口的 `recordFiltered`
	 * 都接到历史仓的 `record`:不经推送层,不走事件总线。
	 *
	 * 验红:把 engines.ts 里 postQueue 的 `recordFiltered: recordFilteredPost` 换成空函数 → B 站与拓展两条都红。
	 */
	describe("被过滤的作品留痕", () => {
		const BILI_SUB = "11111111-1111-4111-8111-111111111111";

		it("B 站引擎交来的作品被挡:uid 换成订阅,落一行:身份、名字快照、原因、摘要与链接;不经推送层,登记进 track", async () => {
			const sub = makeEmptySubscription({
				id: BILI_SUB,
				identity: { sourceKey: "bilibili", externalId: "1" },
			});
			const record = vi.fn(async () => {});
			const c = setup({
				subs: [sub],
				globals: globalsWith({ blockKeywords: ["禁词"] }),
				overrides: {
					historyStore: { record },
					subRuntimeStore: { get: () => ({ cachedProfile: { name: "某UP" } }) },
				},
			});
			active = c;
			await new Promise((r) => setTimeout(r, 0));
			const before = c.serviceCtx.tracking.tracked.length;

			reportBili("1", bilibiliPost("含禁词"), "9");
			await settleTracked(c);

			expect(c.serviceCtx.tracking.tracked.length).toBeGreaterThan(before);
			expect(record).toHaveBeenCalledTimes(1);
			expect(record).toHaveBeenCalledWith({
				pushId: expect.any(String),
				feature: "post",
				identity: { sourceKey: "bilibili", externalId: "1" },
				subscriptionId: BILI_SUB,
				targetId: null,
				filteredBy: "blocked-keyword",
				messages: [
					{ payload: { kind: "text", text: "含禁词\nhttps://t.bilibili.com/9" }, role: "main" },
				],
				nameSnapshot: "某UP",
			});
			expect(H.push[0].push).not.toHaveBeenCalled();
		});

		it("uid 对不上任何订阅(刚删掉)→ 不入队:不记、不推、不发 post-detected", async () => {
			const record = vi.fn(async () => {});
			const c = setup({
				globals: globalsWith({ blockKeywords: ["禁词"] }),
				overrides: { historyStore: { record } },
			});
			active = c;
			const detected: PostEvent[] = [];
			c.bus.on("post-detected", (event) => detected.push(event));
			reportBili("404", bilibiliPost("含禁词"), "9");
			await settleTracked(c);
			expect(record).not.toHaveBeenCalled();
			expect(H.push[0].push).not.toHaveBeenCalled();
			expect(detected).toEqual([]);
		});

		it("拓展作品被挡:同一个写历史的口落一行(拓展的身份、原因、上报里的地址);不出卡、不推", async () => {
			const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
			const record = vi.fn(async () => {});
			const c = setup({
				puppeteer: true,
				subs: [sub],
				extensionSources: sources,
				globals: globalsWith({ blockVideos: true }),
				overrides: { historyStore: { record } },
			});
			active = c;
			c.bus.emit("subscription-reported", videoReport(sub));
			await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
			expect(record).toHaveBeenCalledWith(
				expect.objectContaining({
					feature: "post",
					identity: { sourceKey: "douyin", externalId: "sec-uid-1" },
					subscriptionId: sub.id,
					targetId: null,
					filteredBy: "blocked-videos",
					messages: [
						{
							payload: { kind: "text", text: "新视频\n一期\nhttps://www.douyin.com/video/p1" },
							role: "main",
						},
					],
				}),
			);
			expect(H.push[0].push).not.toHaveBeenCalled();
			expect(H.image[0].generatePostCard).not.toHaveBeenCalled();
		});
	});
});

/**
 * 拓展订阅的直播接进引擎(ADR-0019 决策 57 / 60 / 61):计时器挂在 live 子系统的定时器上,周期「正在直播」
 * 因为没有新状态跳过的那一轮记进接线层给的上报出入框;开播卡照 B 站的映射交给推送层(按订阅 id、特性 live)。
 * 剪掉注册、上报出入框那一口没往下传,这里都会红。
 */
describe("createEngines — 拓展直播接上计时器与上报出入框", () => {
	it("开播 → 推送层收到按订阅 id 的开播;周期推送到点没有新状态 → 记进 onReportDiscrepancy", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const g = makeDefaultGlobalConfig();
		g.defaults.features.liveStreaming = true;
		g.defaults.liveStreaming.streamingIntervalHours = 1;
		const discrepancies: unknown[] = [];
		const c = setup({
			globals: g,
			subs: [sub],
			extensionSources: {
				running: () => true,
				postNoun: () => undefined,
				events: () => ["post", "liveStart", "liveEnd"],
			},
			// 在播表里有这一行(开播进表):表里没有 = 最新状态说不在播,周期那一轮会悄悄跳过、不记问题。
			liveTable: {
				get: (id) =>
					id === sub.id
						? { subscriptionId: sub.id, extensionId: "douyin", updatedAt: Date.now() }
						: undefined,
			},
			onReportDiscrepancy: (discrepancy) => discrepancies.push(discrepancy),
		});
		active = c;
		c.bus.emit("subscription-reported", {
			extensionId: "douyin",
			externalId: "sec-uid-1",
			subscriptionIds: [sub.id],
			report: {
				kind: "liveStart",
				value: { url: "https://live.douyin.com/1", startedAt: Date.now() },
			},
		});
		await vi.waitFor(() =>
			expect(H.push[0].push).toHaveBeenCalledWith(
				expect.objectContaining({ subscriptionId: sub.id, feature: "liveStart" }),
			),
		);
		// 真开播许 @全体:交出去的推送上没有 `allowAtAll: false`。
		expect(H.push[0].push.mock.calls[0]?.[0]).not.toHaveProperty("allowAtAll");

		// 周期推送挂在 live 子系统的定时器上,一小时一次。
		// 替拓展跑的直播场次与推送是核心的代码:定时器挂在 live/core 那个上下文上,不是 B 站直播引擎的 live/来源键
		// (验红:把 engines.ts 里 `bindLivePush` 的 `serviceCtx: coreLiveCtx` 换成 `liveCtx`,这条红)。
		const liveCtx = subsystemCtx(c, "live", "core");
		expect(subsystemCtx(c, "live", "bilibili").setInterval).not.toHaveBeenCalled();
		const intervals = (liveCtx.setInterval.mock.calls ?? []) as unknown as [() => void, number][];
		const periodic = intervals.find(([, ms]) => ms === 60 * 60 * 1000);
		expect(periodic, "周期推送没挂上").toBeDefined();
		periodic?.[0]();
		expect(discrepancies).toEqual([
			expect.objectContaining({
				extensionId: "douyin",
				kind: "liveStatus",
				subscriptionIds: [sub.id],
				outcome: "skipped",
			}),
		]);
	});
});

/**
 * 拓展直播卡的图走图库(ADR-0021 决策 22 / 24 下 2026-10-05 的 🔗,㉒c):封面与事件带来的作者头像经 `liveImages`
 * 存进图库、卡输入里只放引用;订阅资料里的头像引用(`cachedProfile.avatar`)传给消费者。两处接线
 * (`liveImages`、`avatarRef`)各自的单元测试都证明不了 engines 真的接上了,漏接的症状是拓展直播卡没有封面与头像
 * 而门禁全绿。出图器收到的第一个参数就是中立的 `LiveCardInput`。
 */
describe("createEngines — 拓展直播的图走图库", () => {
	const PROFILE_AVATAR = `${"a".repeat(64)}.png`;
	const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const sources = {
		running: () => true,
		postNoun: () => undefined,
		events: () => ["post", "liveStart", "liveEnd"] as const,
	};
	const liveRow = (id: string) => ({
		subscriptionId: id,
		extensionId: "douyin",
		updatedAt: Date.now(),
	});
	const storing = () =>
		vi.fn(async (bytes: Uint8Array) => {
			const ref = imageRefOf(bytes);
			if (!ref) throw new Error("夹具图不合规");
			return { ok: true as const, ref };
		});

	it("给了 liveTable 却没给 liveImages:开机就抛,不悄悄不出图", () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		// 验红:删掉 engines.ts 里 `if (!liveImages) throw …` 那一行,这条红。
		expect(() =>
			setup({
				puppeteer: true,
				subs: [sub],
				extensionSources: sources,
				liveTable: { get: () => undefined },
				liveImages: null,
			}),
		).toThrow(/liveImages/);
	});

	it("封面经 liveImages 存(出卡那一刻写盘),订阅资料里的头像引用顶上;出图器收到的输入里是引用", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const put = storing();
		const c = setup({
			puppeteer: true,
			subs: [sub],
			extensionSources: sources,
			liveTable: { get: (id) => (id === sub.id ? liveRow(id) : undefined) },
			liveImages: { put },
			overrides: {
				subRuntimeStore: {
					get: (id: string) =>
						id === sub.id
							? {
									cachedProfile: {
										name: "资料名",
										avatar: PROFILE_AVATAR,
										sign: "",
										lastRefreshedAt: "2026-10-05T00:00:00.000Z",
									},
								}
							: undefined,
				},
			},
		});
		active = c;
		c.bus.emit("subscription-reported", {
			extensionId: "douyin",
			externalId: "sec-uid-1",
			subscriptionIds: [sub.id],
			report: {
				kind: "liveStart",
				value: { url: "https://live.douyin.com/1", startedAt: Date.now(), cover: PNG_A },
			},
		});
		await vi.waitFor(() => expect(H.image[0].generateLiveCard).toHaveBeenCalledTimes(1));
		// 验红:删掉 engines.ts 里传给 bindLivePush 的 `liveImages,`(整条开机就抛),或 `avatarRef` 那一行(头像没了)。
		const input = H.image[0].generateLiveCard.mock.calls[0]?.[0] as {
			creator: { name: string; avatar?: string };
			cover?: { ref?: string };
		};
		expect(put).toHaveBeenCalledTimes(1);
		expect(input.cover).toEqual({ ref: imageRefOf(PNG_A) });
		expect(input.creator).toEqual({ name: "资料名", avatar: PROFILE_AVATAR });
	});
});

// 「直播就绪」:至少一个启用的 B 站订阅 `needsLiveMonitor` 为真(ADR-0027 决策 1:只看折好的开关与特别关注,
// 不看有没有推送目标)。判定本身只此一份,住 internal;这里钉的是 getModuleState 用的是它。
describe("createEngines — getModuleState.live", () => {
	const TARGET = "10000000-0000-4000-8000-000000000001";
	const LIVE_OFF = {
		liveStart: false,
		liveStreaming: false,
		liveEnd: false,
		membership: false,
		superchat: false,
	};
	function liveSub(opts: {
		features?: Partial<Subscription["overrides"]["features"] & object>;
		routing?: Partial<Subscription["routing"]>;
		specialViewers?: Subscription["specialViewers"];
		enabled?: boolean;
	}): Subscription {
		const s = makeEmptySubscription({
			id: "sub-1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		s.routing = { ...s.routing, ...opts.routing };
		s.overrides = { features: opts.features };
		s.specialViewers = opts.specialViewers ?? [];
		s.enabled = opts.enabled ?? true;
		return s;
	}

	it("直播类开关开着(出厂就开)、一个推送目标都没配 → 就绪", () => {
		const c = setup({ subs: [liveSub({})] });
		active = c;
		expect(c.runtime.getModuleState().live).toBe(true);
	});

	it("直播类开关全关、哪怕路由里留着目标 → 不就绪", () => {
		const c = setup({ subs: [liveSub({ features: LIVE_OFF, routing: { liveStart: [TARGET] } })] });
		active = c;
		expect(c.runtime.getModuleState().live).toBe(false);
	});

	it.each(["viewerChat", "viewerEnter"] as const)(
		"主开关全关、只配了一位带 %s 的特别关注用户(没有目标)→ 就绪",
		(kind) => {
			const c = setup({
				subs: [liveSub({ features: LIVE_OFF, specialViewers: [{ id: "2", features: [kind] }] })],
			});
			active = c;
			expect(c.runtime.getModuleState().live).toBe(true);
		},
	);

	it.each(["liveStart", "liveStreaming", "liveEnd", "membership", "superchat"] as const)(
		"只开 %s 一把 → 就绪",
		(key) => {
			const c = setup({ subs: [liveSub({ features: { ...LIVE_OFF, [key]: true } })] });
			active = c;
			expect(c.runtime.getModuleState().live).toBe(true);
		},
	);

	it("停用的订阅不数", () => {
		const c = setup({ subs: [liveSub({ enabled: false })] });
		active = c;
		expect(c.runtime.getModuleState().live).toBe(false);
	});
});

describe("createEngines — boot wiring", () => {
	it("createEngines 自己不起任何来源:不调 registerSource,来源的 start 一次都没被叫", () => {
		const c = setup({ noSource: true });
		active = c;
		expect(c.source.start).not.toHaveBeenCalled();
		expect(c.sources.get("bilibili")).toBeUndefined();
	});

	it("registerSource 之后:来源的 start 被叫一次,拿到的 ctx 上五个方法都在、名单现读不抛", async () => {
		const c = setup();
		active = c;
		await c.sourceReady;
		expect(c.source.start).toHaveBeenCalledTimes(1);
		const ctx = c.source.ctx;
		expect(typeof ctx?.subscriptions).toBe("function");
		expect(typeof ctx?.onSubscriptionsChanged).toBe("function");
		expect(typeof ctx?.reportPost).toBe("function");
		expect(typeof ctx?.reportProblem).toBe("function");
		expect(typeof ctx?.resolveProblem).toBe("function");
		expect(ctx?.subscriptions()).toEqual([]);
	});

	// 验红:把 engines.ts `registerSource` 里 `settings.read` 接成恒失败,头两句红;去掉 `onChanged`,「变了叫一次」红。
	it("来源在 start 里 ctx.settings(schema) 读得到配置仓里那一段;经配置仓改了之后收得到变化(别的 scope 不叫)", async () => {
		const c = setup({ noSource: true, bilibili: { dynamicCron: "*/7 * * * *" } });
		active = c;
		const seen: unknown[] = [];
		const changes = vi.fn();
		const readers: SettingsReader<{ dynamicCron: string }>[] = [];
		const probe = makeSource();
		probe.start.mockImplementation(async (ctx) => {
			const reader = ctx.settings(z.object({ dynamicCron: z.string() }));
			readers.push(reader);
			seen.push(reader.get());
			reader.onChange(changes);
		});
		await c.runtime.registerSource({
			sourceKey: "bilibili",
			source: probe,
			integration: { logger: c.serviceCtx.logger } as any,
			logger: c.sourceLogger,
		});
		expect(seen).toEqual([{ ok: true, settings: { dynamicCron: "*/7 * * * *" } }]);

		c.bus.emit("config-changed", { scope: "globals" });
		expect(changes).not.toHaveBeenCalled();

		c.configStore._setBilibili(BiliSettingsSchema.parse({ dynamicCron: "*/9 * * * *" }));
		c.bus.emit("config-changed", { scope: "integration-settings" });
		expect(changes).toHaveBeenCalledTimes(1);
		expect(readers[0]?.get()).toEqual({
			ok: true,
			settings: { dynamicCron: "*/9 * * * *" },
		});
	});

	// 验红:删掉 engines.ts `registerSource` 里递 `problems` 的那一行,这条红。
	it("来源上下文的 reportProblem 写进递进去的问题表,报的人是来源键", async () => {
		const c = setup();
		active = c;
		await c.sourceReady;
		c.source.ctx?.reportProblem({ code: "auth_lost", message: "登录失效" });
		expect(c.problems.list().map((p) => [p.reporter, p.code])).toEqual([["bilibili", "auth_lost"]]);
	});

	// 验红:删掉 builtin-sources.ts 撤登记里的 `clearReporter`,这条红。
	it("关停引擎撤掉来源登记:它报的问题跟着清空(不补「已恢复」)", async () => {
		const c = setup();
		active = c;
		await c.sourceReady;
		c.source.ctx?.reportProblem({ code: "auth_lost", message: "登录失效", notify: true });
		expect(H.push[0].notifyMaster).toHaveBeenCalledTimes(1);
		c.runtime.dispose();
		active = null;
		expect(c.problems.list()).toEqual([]);
		expect(H.push[0].notifyMaster).toHaveBeenCalledTimes(1);
	});

	// 验红:删掉 engines.ts 里 `createProblemNotifier` 那一段,这条红。
	it("问题通知器接着表与 notifyMaster:notify 为真的问题私聊一次", async () => {
		const c = setup();
		active = c;
		await c.sourceReady;
		c.problems.report({
			reporter: "bilibili",
			code: "auth_lost",
			message: "登录失效了",
			notify: true,
		});
		expect(H.push[0].notifyMaster).toHaveBeenCalledTimes(1);
		expect(H.push[0].notifyMaster).toHaveBeenCalledWith("登录失效了");
		c.problems.report({ reporter: "bilibili", code: "quiet", message: "只进表" });
		expect(H.push[0].notifyMaster).toHaveBeenCalledTimes(1);
	});

	// 验红:删掉 engines.ts 里听 `subscription-changed` 清 `clearSubscription` 的那段,这条红。
	it("删订阅:表里关于它的问题没了(别的订阅与来源级的还在),且不补「已恢复」", async () => {
		const gone = makeEmptySubscription({
			id: "sub-gone",
			identity: { sourceKey: "bilibili", externalId: "7" },
		});
		const c = setup({ subs: [gone] });
		active = c;
		await c.sourceReady;
		c.problems.report({
			reporter: "bilibili",
			about: { subscriptionId: "sub-gone" },
			code: "monitor_stopped",
			message: "停了",
			notify: true,
		});
		c.problems.report({
			reporter: "bilibili",
			about: { subscriptionId: "sub-stay" },
			code: "monitor_stopped",
			message: "也停了",
		});
		c.problems.report({ reporter: "bilibili", code: "auth_lost", message: "来源级" });
		expect(H.push[0].notifyMaster).toHaveBeenCalledTimes(1);

		c.bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: gone }] });

		expect(
			c.problems
				.list()
				.map((p) => (p.about && "subscriptionId" in p.about ? p.about.subscriptionId : "(来源级)")),
		).toEqual(["sub-stay", "(来源级)"]);
		expect(H.push[0].notifyMaster).toHaveBeenCalledTimes(1);
	});

	// 验红:去掉 engines.ts `registerSource` 里 `onAuthChanged: …`(或 builtin-sources.ts 里的订阅),这条红。
	it("来源的 auth 叫了 onChange → 总线上一条 subscription-auth-changed(来源键 + 那一刻的 state());dispose 之后摘掉", async () => {
		const c = setup({ noSource: true });
		active = c;
		const listeners = new Set<() => void>();
		let state: AuthState = { status: "logged-out" };
		const auth: SourceAuth = {
			beginLogin: async () => ok(),
			logout: async () => ok(),
			state: () => state,
			onChange: (fn) => {
				listeners.add(fn);
				return { dispose: () => void listeners.delete(fn) };
			},
		};
		await c.runtime.registerSource({
			sourceKey: "bilibili",
			source: Object.assign(makeSource(), { auth }),
			integration: { logger: c.serviceCtx.logger } as any,
			logger: c.sourceLogger,
		});
		const seen: unknown[] = [];
		c.bus.on("subscription-auth-changed", (changed) => seen.push(changed));
		expect(seen).toEqual([]); // 登记时不补发

		state = { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" };
		for (const fn of [...listeners]) fn();
		expect(seen).toEqual([{ sourceKey: "bilibili", state }]);

		c.runtime.dispose();
		active = null;
		expect(listeners.size).toBe(0);
	});

	// 验红:把 source-context.ts 里 `ctx.logger` 改回 `integration.logger`,这条红(来源拿到的成了基础 logger)。
	// 标签与键由 `compose` 那边钉(来源登记项带的日志器,标签 `dynamic`、键是来源键)。
	it("来源拿到的 ctx.logger 就是登记项带进来的那一个", async () => {
		const c = setup();
		active = c;
		await c.sourceReady;
		expect(c.source.ctx?.logger).toBe(c.sourceLogger);
		expect(c.source.ctx?.logger).not.toBe(c.serviceCtx.logger);
	});

	// 验红:去掉 engines.ts `registerSource` 里 await 之后的 `if (disposed)` 那段,这条红(来源 stop 没被叫、也没抛)。
	it("registerSource 途中 dispose():放行后来源被当场 stop 一次,registerSource 抛", async () => {
		const c = setup({ noSource: true });
		active = c;
		const gate = deferred();
		const slow = makeSource();
		slow.start.mockImplementation(async () => {
			await gate.promise;
		});
		const registering = c.runtime.registerSource({
			sourceKey: "bilibili",
			source: slow,
			integration: { logger: c.serviceCtx.logger } as any,
			logger: c.sourceLogger,
		});
		const outcome = registering.then(
			() => "ok",
			(err: unknown) => String(err),
		);
		c.runtime.dispose();
		gate.resolve();
		expect(await outcome).toContain("已关停");
		expect(slow.stop).toHaveBeenCalledTimes(1);
	});

	it("默认 globals:push 拉起,AI 与 image 不构造", () => {
		const c = setup();
		active = c;
		expect(H.push).toHaveLength(1);
		expect(H.push[0].start).toHaveBeenCalledTimes(1);
		expect(H.live).toHaveLength(1);
		// 无订阅 → 初始 live view 为空 → live.start 不调用。
		expect(H.live[0].start).not.toHaveBeenCalled();
		// 默认 globals 无 apiKey/baseUrl / 无 puppeteer。
		expect(H.ai).toHaveLength(0);
		expect(H.image).toHaveLength(0);
	});

	it("apiKey+baseUrl 齐备:启动即构造 CommentaryGenerator 并 start", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		expect(H.ai).toHaveLength(1);
		expect(H.ai[0].start).toHaveBeenCalledTimes(1);
	});

	it("构造后立刻接上联网搜索的执行器热读口 —— 快照式接线会让「刚填的 key 不生效」", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		expect(H.ai[0].setWebSearchSource).toHaveBeenCalledTimes(1);
	});

	it("构造后立刻接上只读工具 —— 不接的话女仆连订阅列表都查不到", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		expect(H.ai[0].setCreatorReader).toHaveBeenCalledTimes(1);
		// 只读如今是结构性的(工具表里就没有写工具),由 packages/ai 那道闸盯着;
		// 这里只钉「engines 确实接了」,免得那行接线被顺手删掉还全绿。
		expect(typeof H.ai[0].setCreatorReader.mock.calls[0][0].subscriptions).toBe("function");
	});

	it("只读工具那份视图里,订阅的平台名问来源登记表(先于拓展装载器),creator 是来源键:外部 id", () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "acme.inprocess", externalId: "alice-ext" },
		});
		const c = setup({
			globals: aiGlobals(),
			subs: [sub],
			extensionPlatformLabel: () => "装载器说的",
		});
		active = c;
		const realGet = c.sources.get;
		c.sources.get = (key) =>
			key === "acme.inprocess"
				? ({ sourceKey: key, descriptor: { label: "对拍源" } } as never)
				: realGet(key);
		const [item] = H.ai[0].setCreatorReader.mock.calls[0][0].subscriptions();
		// 验红:把 engines.ts 里 attachReadOnlyTools 的 `platformLabel: …` 改成只问 extensionPlatformLabel,这条红。
		expect(item).toMatchObject({ creator: "acme.inprocess:alice-ext", platform: "对拍源" });
	});

	it("只读工具那份视图里,拓展订阅的平台名接的是 extensionPlatformLabel(ADR-0019 决策 64)", () => {
		const ext = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-1" });
		const c = setup({
			globals: aiGlobals(),
			subs: [ext],
			extensionPlatformLabel: (id) => (id === "douyin" ? "抖音" : undefined),
		});
		active = c;
		// 验红:把 engines.ts 里 attachReadOnlyTools 的 `platformLabel: …` 里的拓展装载器那一支去掉,平台名退成拓展 id。
		expect(H.ai[0].setCreatorReader.mock.calls[0][0].subscriptions()[0]?.platform).toBe("抖音");
	});

	it("只读工具那份视图里,拓展订阅的在播接的是在播表(ADR-0019 决策 64 的 🔗)", () => {
		const ext = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-1" });
		const c = setup({
			globals: aiGlobals(),
			subs: [ext],
			extensionSources: {
				running: () => true,
				postNoun: () => undefined,
				events: () => ["post", "liveStart", "liveEnd"],
			},
			liveTable: {
				get: (id) =>
					id === ext.id
						? { subscriptionId: ext.id, extensionId: "douyin", title: "在播", updatedAt: 0 }
						: undefined,
			},
		});
		active = c;
		expect(H.ai[0].setCreatorReader.mock.calls[0][0].subscriptions()[0]?.liveNow).toEqual({
			state: "live",
			title: "在播",
		});
	});

	it("只读工具那份视图里,B 站订阅的在播接的是直播引擎的在播房间(不再问 B 站接口)", () => {
		const c = setup({
			globals: aiGlobals(),
			subs: [
				makeEmptySubscription({ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" } }),
				makeEmptySubscription({ id: "s2", identity: { sourceKey: "bilibili", externalId: "2" } }),
			],
		});
		active = c;
		const reader = H.ai[0].setCreatorReader.mock.calls[0][0];
		H.live[0].listLiveSnapshots.mockReturnValue([
			{
				uid: "1",
				roomId: "r1",
				isLive: true,
				title: "在播",
				startedAt: "2026-09-24T04:00:00.000Z",
			},
			{ uid: "2", roomId: "r2", isLive: false },
		]);
		// 验红:把 engines.ts 里 attachReadOnlyTools 的 `biliLiveRooms: …` 那一行删掉,这条红。
		const [first, second] = reader.subscriptions();
		expect(first?.liveNow).toEqual({
			state: "live",
			title: "在播",
			startedAt: Date.UTC(2026, 8, 24, 4, 0, 0),
		});
		expect(second?.liveNow).toEqual({ state: "idle" });
	});

	it("puppeteer 在位:构造 ImageRenderer", () => {
		const c = setup({ puppeteer: true });
		active = c;
		expect(H.image).toHaveLength(1);
	});

	// 「接线要有自己的守卫」:三口各自都有测试,证明不了 engines 真的把它们接上了 ——
	// 漏接的症状是静默的(出图永远用内置默认皮肤,类型 / 测试 / 构建全绿)。
	it("卡片皮肤那三口原样接到 ImageRenderer 上", () => {
		const get = vi.fn(() => undefined);
		const asset = vi.fn(async () => undefined);
		const onFallback = vi.fn();
		const c = setup({ puppeteer: true, cardSkins: { get, asset, onFallback } });
		active = c;
		const o = H.image[0].opts;
		// 验红:把 engines.ts 里那三行 `resolveCardSkin: opts.cardSkins?.get` 删掉,这三条红。
		expect(o.resolveCardSkin).toBe(get);
		expect(o.resolveCardSkinAsset).toBe(asset);
		expect(o.onCardSkinFallback).toBe(onFallback);
	});

	it("直播消息模板无开关:boot 时 live 引擎 config 始终带全局模板(回归 liveMsgEnabled 移除)", () => {
		// 此前 liveMsgEnabled=false(默认)→ customLiveMsg 不带 customLiveStart,引擎走
		// builtin。现无开关:全局模板始终下发,编辑即生效(默认值 == builtin,输出不变)。
		const c = setup();
		active = c;
		const liveCfg = H.live[0].opts.config;
		expect(liveCfg.customLiveMsg.customLiveStart).toBe("{name} 开播啦，当前粉丝数：{follower}");
		expect(liveCfg.customLiveMsg.customLiveStreaming).toBe(
			"{name} 正在直播，已播 {time}，累计观看：{watched}",
		);
		expect(liveCfg.customLiveMsg.customLiveEnd).toBe(
			"{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}",
		);
	});
});

describe("createEngines — enableImageRendering 运行时热启用", () => {
	it("启动无 puppeteer,运行时注入 → 构造 renderer + setImageRenderer", () => {
		const c = setup({ puppeteer: false });
		active = c;
		expect(H.image).toHaveLength(0); // 启动时无 renderer
		const enabled = c.runtime.enableImageRendering({} as any);
		expect(enabled).toBe(true);
		expect(H.image).toHaveLength(1);
		expect(H.live[0].setImageRenderer).toHaveBeenCalledWith(H.image[0]);
	});

	it("幂等:启动即 puppeteer 在位,再调 → 返回 false 且不重复构造", () => {
		const c = setup({ puppeteer: true });
		active = c;
		expect(H.image).toHaveLength(1); // 启动已构造
		const enabled = c.runtime.enableImageRendering({} as any);
		expect(enabled).toBe(false);
		expect(H.image).toHaveLength(1); // 没重复构造浏览器
	});

	it("swapImageRendering:已启用时热切换 → 重建 renderer 并重新注入直播引擎", () => {
		const c = setup({ puppeteer: true });
		active = c;
		expect(H.image).toHaveLength(1);
		c.runtime.swapImageRendering({} as any);
		expect(H.image).toHaveLength(2); // 新 renderer
		expect(H.live[0].setImageRenderer).toHaveBeenLastCalledWith(H.image[1]);
	});

	it("swapImageRendering:未启用时等同首次启用(注入而非空转)", () => {
		const c = setup({ puppeteer: false });
		active = c;
		expect(H.image).toHaveLength(0);
		c.runtime.swapImageRendering({} as any);
		expect(H.image).toHaveLength(1);
		expect(H.live[0].setImageRenderer).toHaveBeenLastCalledWith(H.image[0]);
	});

	// 渲染器会被热换,核心装配只能经 `deps.image()` 这个读外层 let 的闭包拿它 —— 按值传就是
	// 「开机时没有浏览器,之后一直没有卡片」而门禁全绿。走真的队列与真的装配,断言到出卡器与推送层。
	// 验红:把 engines.ts 里 postQueue 的 `image: () => imageRenderer ?? undefined` 改成按值传
	// (`const bootImage = imageRenderer ?? undefined; … image: () => bootImage`),这条红。
	it("热换之后下一条作品用新的渲染器:开机没有 → 热启用后出卡 → 热切换后改用新的那个 → 都不回头用旧的", async () => {
		const c = setup({ puppeteer: false, subs: [biliSubOf("1")] });
		active = c;
		reportBili("1", bilibiliPost("一"), "d1");
		await settleTracked(c);
		expect(H.image).toHaveLength(0);
		expect(await mainTexts()).toHaveLength(1); // 没有渲染器:纯文字照推

		c.runtime.enableImageRendering({} as any);
		reportBili("1", bilibiliPost("二"), "d2");
		await settleTracked(c);
		expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1);

		c.runtime.swapImageRendering({} as any);
		reportBili("1", bilibiliPost("三"), "d3");
		await settleTracked(c);
		expect(H.image[1].generatePostCard).toHaveBeenCalledTimes(1);
		expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1);
		expect(H.push[0].push).toHaveBeenCalledTimes(3);
	});
});

describe("createEngines — config-changed globals 热重载", () => {
	it("改 B 站设置(cron + 健康检查间隔):不碰 live.updateConfig(cron 归 B 站来源,健康检查间隔归登录系统)", () => {
		const c = setup();
		active = c;
		patchBilibili(c, (b) => {
			b.dynamicCron = "*/9 * * * *";
			b.healthCheckMinutes = 45;
		});
		c.bus.emit("config-changed", { scope: "integration-settings" });

		// B 站设置不是核心设置(scope 是 integration-settings 不是 globals)→ 不重算 master。
		// (从前这几格住在 `app` 里,走 globals 那一档,setMaster 顺带被调一次。)
		expect(H.push[0].setMaster).not.toHaveBeenCalled();
		// B 站设置不在 liveConfig() 的输入内 → live.updateConfig 不应触发(item 4:不扇出)。
		expect(H.live[0].updateConfig).not.toHaveBeenCalled();
	});

	// cron 本身要生效(引擎换节奏)在 `bilibili/__tests__/source.test.ts`。

	// 作品设置每条现折:改全局图集开关,下一条作品就按新的,不经引擎的热更门(此前 imageGroup 整个漏在门外)。
	it("改 defaults.imageGroup:不经引擎热更,下一条带图的作品立即多一个图集的附加项锚点", async () => {
		const closed = makeDefaultGlobalConfig();
		closed.defaults.imageGroup = { enabled: false, mergeForward: false };
		const c = setup({ subs: [biliSubOf("1")], globals: closed });
		active = c;
		const withImages = bilibiliPost("图", {
			images: [{ url: "http://a/1.jpg" }, { url: "http://a/2.jpg" }],
		});
		reportBili("1", withImages, "d1");
		await settleTracked(c);
		expect(H.push[0].push.mock.calls[0]?.[0].anchors.map((a: { role: string }) => a.role)).toEqual([
			"main",
		]);
		patchGlobals(c, (g) => {
			g.defaults.imageGroup.enabled = true;
		});
		c.bus.emit("config-changed", { scope: "globals" });
		reportBili("1", withImages, "d2");
		await settleTracked(c);
		expect(H.push[0].push.mock.calls[1]?.[0].anchors.map((a: { role: string }) => a.role)).toEqual([
			"main",
			"extra",
		]);
	});

	// 日志等级不再由引擎装配推:各子上下文只交(标签,键),等级表由入口的 `bindLogLevels` 整张推
	// (推的行为在 `log-levels.test.ts` 与 `service-context.test.ts`,接线在 `log-levels-boot-e2e`)。
	// 一行日志是谁的代码打的就跟谁那一格:这里钉「键」接对了没有 —— 接反了门禁全绿,只有调等级时才露馅。
	it("子上下文的(标签,键):作品队列与拓展直播跟 core,B 站直播引擎跟来源键,AI、出图各跟自己的", () => {
		const c = setup();
		active = c;
		const booted = (c.serviceCtx.forSubsystem.mock.calls as unknown as [string, string][]).map(
			([name, key]) => `${name}/${key}`,
		);
		expect(booted.sort()).toEqual([
			"ai/ai",
			"image/image",
			"live/bilibili",
			"live/core",
			"posts/core",
		]);
	});

	// 验红:把 engines.ts 里递给 LiveEngine 的 `serviceCtx: liveCtx` 换成 `coreLiveCtx`(键成了 core),这条红。
	it("B 站直播引擎拿到的是 live/来源键 那个上下文", () => {
		const c = setup();
		active = c;
		expect(H.live[0].opts.serviceCtx).toBe(subsystemCtx(c, "live", "bilibili"));
	});

	// 验红:把 engines.ts 里 `bindExtensionPosts` 的 `logger: postsCtx.logger` 换成 B 站那个上下文的,这条红。
	it("拓展作品的接入记的日志走 posts/core 那一个", async () => {
		const gone = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const c = setup({
			puppeteer: true,
			subs: [],
			extensionSources: {
				running: () => true,
				postNoun: () => undefined,
				events: () => ["post", "liveStart", "liveEnd"],
			},
		});
		active = c;
		c.bus.emit("subscription-reported", {
			extensionId: "douyin",
			externalId: "sec-uid-1",
			subscriptionIds: [gone.id],
			report: {
				kind: "post",
				value: { id: "p1", url: "https://www.douyin.com/video/p1", publishedAt: Date.now() },
			},
		});
		await settleTracked(c);
		const posts = subsystemCtx(c, "posts", "core").logger;
		expect(posts.debug).toHaveBeenCalledWith(expect.stringContaining("[ext-post]"));
		expect(subsystemCtx(c, "live", "bilibili").logger.debug).not.toHaveBeenCalled();
		expect(subsystemCtx(c, "live", "core").logger.debug).not.toHaveBeenCalled();
	});

	const extensionPostReport = (id: string, video: boolean) => ({
		extensionId: "douyin",
		externalId: "sec-uid-1",
		subscriptionIds: [id],
		report: {
			kind: "post" as const,
			value: {
				id: "p1",
				url: "https://www.douyin.com/video/p1",
				publishedAt: Date.now(),
				text: "新视频",
				...(video ? { video: { title: "一期" } } : {}),
			},
		},
	});

	// 验红:把 engines.ts 里 `createPostQueue` 的顶层 `logger: postsCtx.logger` 换成 `liveCtx.logger`,这条红。
	it("作品队列自己记的日志走 posts/core 那一个(订阅的拓展没在跑 → 不收)", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const c = setup({
			puppeteer: true,
			subs: [sub],
			extensionSources: {
				running: () => false,
				postNoun: () => undefined,
				events: () => ["post"],
			},
		});
		active = c;
		c.bus.emit("subscription-reported", extensionPostReport(sub.id, false));
		await settleTracked(c);
		expect(subsystemCtx(c, "posts", "core").logger.debug).toHaveBeenCalledWith(
			expect.stringContaining("不收"),
		);
		expect(subsystemCtx(c, "live", "bilibili").logger.debug).not.toHaveBeenCalled();
		expect(subsystemCtx(c, "live", "core").logger.debug).not.toHaveBeenCalled();
	});

	// 验红:把 engines.ts 里 `createPostQueue` 的 `deps.logger: postsCtx.logger` 换成 `liveCtx.logger`,这条红。
	it("作品装配(deliverPost)记的日志走 posts/core 那一个(被过滤)", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const g = makeDefaultGlobalConfig();
		g.defaults.filters.blockVideos = true;
		const c = setup({
			puppeteer: true,
			subs: [sub],
			globals: g,
			extensionSources: {
				running: () => true,
				postNoun: () => "作品",
				events: () => ["post"],
			},
		});
		active = c;
		c.bus.emit("subscription-reported", extensionPostReport(sub.id, true));
		await settleTracked(c);
		expect(subsystemCtx(c, "posts", "core").logger.debug).toHaveBeenCalledWith(
			expect.stringContaining("被过滤"),
		);
		expect(subsystemCtx(c, "live", "bilibili").logger.debug).not.toHaveBeenCalled();
		expect(subsystemCtx(c, "live", "core").logger.debug).not.toHaveBeenCalled();
	});

	// 验红:把 engines.ts 里 `createLiveSessionEngine` 的 `logger: coreLiveCtx.logger` 换成 `liveCtx.logger`,这条红。
	it("拓展直播场次记的日志走 live/core 那一个(拓展没在跑 → 这次开播不管)", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const c = setup({
			subs: [sub],
			extensionSources: {
				running: () => false,
				postNoun: () => undefined,
				events: () => ["post", "liveStart", "liveEnd"],
			},
			liveTable: { get: () => undefined },
		});
		active = c;
		c.bus.emit("subscription-reported", {
			extensionId: "douyin",
			externalId: "sec-uid-1",
			subscriptionIds: [sub.id],
			report: {
				kind: "liveStart",
				value: { url: "https://live.douyin.com/1", startedAt: Date.now() },
			},
		});
		await settleTracked(c);
		expect(subsystemCtx(c, "live", "core").logger.debug).toHaveBeenCalledWith(
			expect.stringContaining("这次开播不管"),
		);
		expect(subsystemCtx(c, "live", "bilibili").logger.debug).not.toHaveBeenCalled();
		expect(subsystemCtx(c, "posts", "core").logger.debug).not.toHaveBeenCalled();
	});

	// 验红:把 engines.ts 里 `bindLivePush` 的 `logger: coreLiveCtx.logger` 换成 `liveCtx.logger`,这条红。
	it("拓展直播推送记的日志走 live/core 那一个(周期到点时最新状态不在播)", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const g = makeDefaultGlobalConfig();
		g.defaults.features.liveStreaming = true;
		g.defaults.liveStreaming.streamingIntervalHours = 1;
		let playing = true;
		const c = setup({
			globals: g,
			subs: [sub],
			extensionSources: {
				running: () => true,
				postNoun: () => undefined,
				events: () => ["post", "liveStart", "liveEnd"],
			},
			liveTable: {
				get: (id) =>
					playing && id === sub.id
						? { subscriptionId: sub.id, extensionId: "douyin", updatedAt: Date.now() }
						: undefined,
			},
		});
		active = c;
		c.bus.emit("subscription-reported", {
			extensionId: "douyin",
			externalId: "sec-uid-1",
			subscriptionIds: [sub.id],
			report: {
				kind: "liveStart",
				value: { url: "https://live.douyin.com/1", startedAt: Date.now() },
			},
		});
		await vi.waitFor(() =>
			expect(H.push[0].push).toHaveBeenCalledWith(
				expect.objectContaining({ subscriptionId: sub.id, feature: "liveStart" }),
			),
		);
		playing = false;
		const intervals = (subsystemCtx(c, "live", "core").setInterval.mock.calls ?? []) as unknown as [
			() => void,
			number,
		][];
		const periodic = intervals.find(([, ms]) => ms === 60 * 60 * 1000);
		expect(periodic, "周期推送没挂上").toBeDefined();
		periodic?.[0]();
		expect(subsystemCtx(c, "live", "core").logger.debug).toHaveBeenCalledWith(
			expect.stringContaining("最新状态不在播"),
		);
		expect(subsystemCtx(c, "live", "bilibili").logger.debug).not.toHaveBeenCalled();
		expect(subsystemCtx(c, "posts", "core").logger.debug).not.toHaveBeenCalled();
	});

	it("配了 AI 时,只改 dynamicCron 不该热重载 commentary", () => {
		// 现有 setup() 不配 AI → commentary 为 null → 永远走不进 `else if (commentary)`
		// 分支,所以「改 app 扇出到 ai」这条路此前无人守。主人的实例配了 AI 才暴露。
		const c = setup({ globals: aiGlobals() });
		active = c;
		expect(H.ai).toHaveLength(1); // boot 时已构造
		H.ai[0].updateConfig.mockClear();

		patchBilibili(c, (b) => {
			// 要与默认值不同,否则这一发什么都没变,下面的断言就是空转。
			b.dynamicCron = "*/9 * * * *";
		});
		c.bus.emit("config-changed", { scope: "integration-settings" });

		expect(H.ai[0].updateConfig).not.toHaveBeenCalled();
	});

	it("启动时没配 AI、之后补齐 → runtime.commentary 跟着变成实例", () => {
		// 现场(桌面端 2026-08-07):启动那会儿密钥袋还没 key → commentary 为 null。
		// 随后在设置页填上 apiKey 保存,热重载把实例建起来了(日志确有「commentary
		// 已激活」),`live` 靠 setCommentary、作品装配经 `deps.ai()` 每条现取,也都拿到了新引用 ——
		// 唯独对外暴露的这个字段没人管。聊天路由读的正是它(routes/ai.ts),于是
		// 「保存成功了,进聊天照样报『baseUrl / apiKey 还没填齐』,重启才好」。
		const c = setup(); // 不配 AI
		active = c;
		expect(c.runtime.commentary).toBeNull();

		patchGlobals(c, (g) => {
			const ai = aiGlobals().ai;
			g.ai.activeProfile = ai.activeProfile;
			g.ai.providers = ai.providers;
		});
		c.bus.emit("config-changed", { scope: "globals" });

		expect(H.ai).toHaveLength(1); // 实例确实建起来了
		expect(c.runtime.commentary).not.toBeNull(); // 读得到的必须是同一个
	});

	it("配着 AI 启动、之后清空密钥 → runtime.commentary 跟着变回 null", () => {
		// 反向的一半:属性若是快照,停用后它还攥着已 stop 的旧实例,聊天会拿一个
		// 主人已经撤掉的配置继续答话 —— 比报错更难发现。
		const c = setup({ globals: aiGlobals() });
		active = c;
		expect(c.runtime.commentary).not.toBeNull();

		patchGlobals(c, (g) => {
			g.ai.providers = {};
		});
		c.bus.emit("config-changed", { scope: "globals" });

		expect(c.runtime.commentary).toBeNull();
	});

	it("改全局 templates.post/postVideo → 不经引擎热更,下一条作品就用新模板(无 per-UP 覆盖的订阅不再用旧模板)", async () => {
		// 回归:从前引擎快照里留着模板,触发条件漏了 templatesChanged 就一直用旧的;现在每条作品现折。
		const c = setup({ subs: [biliSubOf("1")], globals: TEMPLATE_GLOBALS("旧 {name}") });
		active = c;
		reportBili("1", bilibiliPost("正文"), "d1");
		await settleTracked(c);
		patchGlobals(c, (g) => {
			g.defaults.templates.post = "🔔 {name}";
		});
		c.bus.emit("config-changed", { scope: "globals" });
		reportBili("1", bilibiliPost("正文"), "d2");
		await settleTracked(c);
		expect(await mainTexts()).toEqual([
			"旧 阿绫\nhttps://t.bilibili.com/d1",
			"🔔 阿绫\nhttps://t.bilibili.com/d2",
		]);
	});

	it("回归:改全局 cards.liveCoverImageIds → live config 带 defaultLiveCoverImages(无覆盖的 UP 靠它轮换)", () => {
		// 此前 liveConfig() 没有把全局默认封面廊透传给引擎,导致无 per-UP / per-kind
		// 覆盖的 UP 永远只渲染第一张,封面配再多张也不轮换。
		// (背景图从前有一条同构的 `defaultBackgroundImages`;整条链 2026-09-20 删掉。)
		const c = setup();
		active = c;
		patchGlobals(c, (g) => {
			g.defaults.cards.liveCoverImageIds = ["a", "b"];
		});
		c.bus.emit("config-changed", { scope: "globals" });
		const liveCfg = H.live[0].updateConfig.mock.calls.at(-1)?.[0];
		expect(liveCfg.defaultLiveCoverImages).toEqual(["a", "b"]);
	});

	it("回归:改全局会员文案 → live config 的 guardTemplate 带上 enabled、体系默认与按档各自的文案与图片", () => {
		// 此前 liveConfig() 只把 `captain.template` 当成所有档位的文案传给引擎,提督 /
		// 总督的专属文案运行时从来不读(图片倒是三档各传各的)。㉓d 起文案按体系存:这里是 B 站的 `guard` 那一份,
		// 三档写成三句不同的话,少传一档、传串一档都会红。
		const guard = {
			enabled: true,
			default: { template: "默认那句 {viewer}", imageUrl: "default.png" },
			tiers: {
				captain: { template: "舰长那句", imageUrl: "cap.png" },
				commander: { template: "提督那句", imageUrl: "com.png" },
				governor: { template: "总督那句" },
			},
		};
		const c = setup();
		active = c;
		patchGlobals(c, (g) => {
			g.defaults.templates.membership.guard = guard;
		});
		c.bus.emit("config-changed", { scope: "globals" });
		const liveCfg = H.live[0].updateConfig.mock.calls.at(-1)?.[0];
		expect(liveCfg.guardTemplate).toEqual(guard);
	});

	it("全局配置里没有 guard 这一项(手改删掉了):live config 的 guardTemplate 回出厂那份,自定义关着", () => {
		const c = setup();
		active = c;
		patchGlobals(c, (g) => {
			g.defaults.templates.membership = {};
			// 改点别的让 updateConfig 触发(templates 变了就会)。
		});
		c.bus.emit("config-changed", { scope: "globals" });
		const liveCfg = H.live[0].updateConfig.mock.calls.at(-1)?.[0];
		expect(liveCfg.guardTemplate).toEqual({
			enabled: false,
			default: { template: "{viewer} 成为了 {name} 的{tier}！", imageUrl: "" },
			tiers: {},
		});
	});

	it("item 4 — 改 ai 不扇出重设 level / healthCheck", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		patchGlobals(c, (g) => {
			g.ai.persona.name = "恶魔兔";
		});
		c.bus.emit("config-changed", { scope: "globals" });
		// AI 本身热更。
		expect(H.ai[0].updateConfig).toHaveBeenCalledTimes(1);
	});

	it("3a-38 ④ — 配着 AI 时改无关设置(保留天数、资料刷新 cron)不触发「AI 配置已更新」;改人设才触发(同一份夹具对照)", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		expect(H.ai).toHaveLength(1);
		H.ai[0].updateConfig.mockClear();

		patchGlobals(c, (g) => {
			g.logging.retentionDays = 14;
			g.profileRefreshCron = "*/9 * * * *";
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(H.ai[0].updateConfig).not.toHaveBeenCalled();
		expect(c.serviceCtx.logger.info).not.toHaveBeenCalledWith(
			expect.stringContaining("commentary 配置已更新"),
		);

		// 对照:换成改顶层 ai 里的人设,同一条路就会热更(门比的是顶层 ai,不是别的什么)。
		patchGlobals(c, (g) => {
			g.ai.persona.name = "恶魔兔";
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(H.ai[0].updateConfig).toHaveBeenCalledTimes(1);
	});

	it("item 3 — 改全局配置:live.applyOps 收到全部订阅的 update op(刷新 per-sub 视图)", () => {
		const sub = makeEmptySubscription({
			id: "sub-1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		const c = setup({ globals: aiGlobals(), subs: [sub] });
		active = c;
		patchGlobals(c, (g) => {
			g.ai.persona.name = "恶魔兔";
		});
		c.bus.emit("config-changed", { scope: "globals" });
		const liveOps = H.live[0].applyOps.mock.calls.at(-1)?.[0];
		expect(liveOps).toHaveLength(1);
		expect(liveOps[0]).toMatchObject({ kind: "update", uid: "1" });
	});

	it("回归:只改全局 cardSkin → live.applyOps 收到刷新;作品不经来源,下一张卡就带新皮肤 id", async () => {
		const sub = makeEmptySubscription({
			id: "sub-1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		const c = setup({ subs: [sub], puppeteer: true });
		active = c;
		H.live[0].applyOps.mockClear();
		patchGlobals(c, (g) => {
			g.defaults.cardSkin = "skin-abc";
		});
		c.bus.emit("config-changed", { scope: "globals" });

		const liveOps = H.live[0].applyOps.mock.calls.at(-1)?.[0];
		expect(liveOps).toHaveLength(1);
		expect(liveOps[0]).toMatchObject({ kind: "update", uid: "1" });
		expect(liveOps[0].changes[0].cardSkin).toBe("skin-abc");
		reportBili("1");
		await settleTracked(c);
		expect(H.image[0].generatePostCard.mock.calls.at(-1)?.[1]).toMatchObject({
			cardSkin: "skin-abc",
		});
	});

	// 名单只列启用中的订阅、`features` 是折好的开关:全局的作品开关一翻,所有没单独覆盖的订阅在名单里的 `post` 都跟着翻。
	// 这件事没有自己的门,全靠来源上下文听 `config-changed` 的 globals 一档并叫来源:断了这一段,
	// 来源收不到通知、全局把作品推送从关改成开之后一直不产。
	// 验红:把 `subscriptions/source-context.ts` 里 `config-changed` 那个监听整个删掉,这条红。
	it("改全局 features.post:来源的名单回调被叫,此刻 ctx.subscriptions() 里那个人的 features 已不含 post(关),再开又有", async () => {
		const sub = makeEmptySubscription({
			id: "sub-1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		sub.enabled = true;
		const c = setup({ subs: [sub] });
		active = c;
		await c.sourceReady;
		const ctx = c.source.ctx as SourceContext;
		const seen: boolean[] = [];
		ctx.onSubscriptionsChanged(() => {
			seen.push(ctx.subscriptions()[0]?.features.has("post") ?? false);
		});
		patchGlobals(c, (g) => {
			g.defaults.features.post = false;
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(seen).toEqual([false]);

		patchGlobals(c, (g) => {
			g.defaults.features.post = true;
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(seen).toEqual([false, true]);
	});

	it("别的 scope 的 config-changed 不叫来源的名单回调", async () => {
		const c = setup({ subs: [biliSubOf("1")] });
		active = c;
		await c.sourceReady;
		const fn = vi.fn();
		c.source.ctx?.onSubscriptionsChanged(fn);
		c.bus.emit("config-changed", { scope: "targets" });
		expect(fn).not.toHaveBeenCalled();
	});

	// 直播拆键(⑬d):周期「正在直播」的开关、间隔与启动补报各是自己的一格,从 schedule 里搬出来。
	// 每个订阅的视图里带着折好的值,全局那几格一变就要给所有订阅合成 update op(引擎比对前后值再重排计时器)。
	// 验红:把热更门里的 `liveSettingsChanged` 删掉,间隔与补报那两条红;`featuresChanged` 管开关那一条。
	it.each([
		[
			"开关(features.liveStreaming)",
			(g: GlobalConfig) => (g.defaults.features.liveStreaming = true),
			{ liveStreaming: true },
		],
		[
			"间隔(liveStreaming.streamingIntervalHours)",
			(g: GlobalConfig) => (g.defaults.liveStreaming.streamingIntervalHours = 3),
			{ streamingIntervalHours: 3 },
		],
		[
			"启动补报(liveStart.catchUpOnBoot)",
			(g: GlobalConfig) => (g.defaults.liveStart.catchUpOnBoot = true),
			{ catchUpOnBoot: true },
		],
		// ㉓d:两个直播门槛搬出了 filters,自己成了 superchat / membership 两段,热更的门要跟着 ——
		// 漏掉的话在面板上改了门槛要重启才生效(门槛在每个订阅的视图里定格,只有 applyOps 能刷)。
		// 验红:把热更门里的 `interactionChanged` 删掉,这两条红。
		[
			"醒目留言门槛(superchat.minAmount)",
			(g: GlobalConfig) => (g.defaults.superchat = { minAmount: 30 }),
			{ minSuperchatAmount: 30 },
		],
		[
			"上舰门槛(membership.minRank.guard)",
			(g: GlobalConfig) => (g.defaults.membership = { minRank: { guard: 2 } }),
			{ minGuardRank: 2 },
		],
	])("直播拆键:只改全局%s → live.applyOps 收到刷新,带上折好的新值", (_name, mutate, expected) => {
		const sub = makeEmptySubscription({
			id: "sub-1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		const c = setup({ subs: [sub] });
		active = c;
		H.live[0].applyOps.mockClear();
		patchGlobals(c, (g) => {
			mutate(g);
		});
		c.bus.emit("config-changed", { scope: "globals" });

		const liveOps = H.live[0].applyOps.mock.calls.at(-1)?.[0];
		expect(liveOps).toHaveLength(1);
		expect(liveOps[0].changes[0]).toMatchObject(expected);
	});

	it("门槛被清掉:update op 里 minSuperchatAmount / minGuardRank 两个键恒在、值是 undefined(引擎按 Object.assign 合并,靠它盖掉旧值)", () => {
		const sub = makeEmptySubscription({
			id: "sub-1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		const c = setup({ subs: [sub] });
		active = c;
		patchGlobals(c, (g) => {
			g.defaults.superchat = { minAmount: 30 };
			g.defaults.membership = { minRank: { guard: 2 } };
		});
		c.bus.emit("config-changed", { scope: "globals" });
		H.live[0].applyOps.mockClear();
		patchGlobals(c, (g) => {
			g.defaults.superchat = {};
			g.defaults.membership = {};
		});
		c.bus.emit("config-changed", { scope: "globals" });

		const change = H.live[0].applyOps.mock.calls.at(-1)?.[0][0].changes[0];
		expect(Object.hasOwn(change, "minSuperchatAmount")).toBe(true);
		expect(Object.hasOwn(change, "minGuardRank")).toBe(true);
		expect(change.minSuperchatAmount).toBeUndefined();
		expect(change.minGuardRank).toBeUndefined();
	});

	it("no-op:globals 未变的 config-changed 不热推任何子系统", () => {
		const c = setup();
		active = c;
		c.bus.emit("config-changed", { scope: "globals" });
		expect(H.live[0].updateConfig).not.toHaveBeenCalled();
		expect(H.live[0].applyOps).not.toHaveBeenCalled();
	});

	it("targets scope:仅 push.setMaster,早退不触发 live.updateConfig", () => {
		const c = setup();
		active = c;
		c.bus.emit("config-changed", { scope: "targets" });
		expect(H.push[0].setMaster).toHaveBeenCalledTimes(1);
		expect(H.live[0].updateConfig).not.toHaveBeenCalled();
	});

	it("subscriptions / secrets scope:不 setMaster 不 updateConfig", () => {
		const c = setup();
		active = c;
		c.bus.emit("config-changed", { scope: "subscriptions" });
		c.bus.emit("config-changed", { scope: "secrets" });
		expect(H.push[0].setMaster).not.toHaveBeenCalled();
		expect(H.live[0].updateConfig).not.toHaveBeenCalled();
	});
});

// B 站自己的设置(`config/settings/bilibili.json`)走 `integration-settings` 这一档,与核心设置的 `globals`
// 各管各的:这一档只认 B 站那两格,没变的格不动;核心设置变了(日志等级之类)也不波及 B 站那两样。
describe("createEngines — config-changed integration-settings(B 站设置)", () => {
	it("只改核心设置的 logLevel:B 站的 cron 不动", () => {
		const c = setup();
		active = c;
		patchGlobals(c, (g) => {
			g.logging.level = "debug";
		});
		c.bus.emit("config-changed", { scope: "globals" });

		expect(H.push[0].setMaster).toHaveBeenCalled(); // 这一发确实被处理了
		expect(H.live[0].updateConfig).not.toHaveBeenCalled();
	});
	// 「初始带 B 站设置里的 cron」「cron 变了引擎换节奏」在 `bilibili/__tests__/source.test.ts`。
});

describe("createEngines — AI 热重载三态", () => {
	it("启用:lazy 构造 commentary 并下发给直播引擎", () => {
		const c = setup(); // 默认无 AI
		active = c;
		expect(H.ai).toHaveLength(0);
		patchGlobals(c, (g) => {
			// 添加一家并选中它 —— 「配齐了」现在的意思是「当前那家的桶里连接齐备」。
			g.ai.activeProfile = "deepseek";
			g.ai.providers = aiGlobals().ai.providers;
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(H.ai).toHaveLength(1);
		expect(H.ai[0].start).toHaveBeenCalledTimes(1);
		expect(H.live[0].setCommentary).toHaveBeenCalledWith(H.ai[0]);
	});

	it("停用:live.setCommentary(null)", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		expect(H.ai).toHaveLength(1);
		patchGlobals(c, (g) => {
			const p = g.ai.providers[g.ai.activeProfile];
			if (p) p.apiKey = "";
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(H.live[0].setCommentary).toHaveBeenCalledWith(null);
		// 不应构造新实例。
		expect(H.ai).toHaveLength(1);
	});

	// AI 实例会被热换,核心装配只能经 `deps.ai()` 这个读外层 let 的闭包拿它。
	// 验红:把 engines.ts 里 postQueue 的 `ai: () => commentary ?? undefined` 改成按值传(开机取一次),这条红。
	it("作品的 AI 点评每条现取:开机没配 → 补齐后下一条用新实例 → 清空密钥后不再点评", async () => {
		const aiOn = aiGlobals();
		aiOn.ai.enabled = true;
		const c = setup({ subs: [biliSubOf("1")], globals: TEMPLATE_GLOBALS("模板 {name}") });
		active = c;
		reportBili("1", bilibiliPost("正文"), "d1");
		await settleTracked(c);
		expect(H.ai).toHaveLength(0);
		expect(await mainTexts()).toEqual(["模板 阿绫\nhttps://t.bilibili.com/d1"]);

		patchGlobals(c, (g) => {
			g.ai = aiOn.ai;
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(H.ai).toHaveLength(1);
		reportBili("1", bilibiliPost("正文"), "d2");
		await settleTracked(c);
		expect(H.ai[0].comment).toHaveBeenCalledTimes(1);
		// 模板版照交,点评是另一份(推送层按目标挑)。
		expect((await mainTexts()).at(-1)).toBe("模板 阿绫\nhttps://t.bilibili.com/d2");
		expect(await aiTexts()).toEqual(["点评\nhttps://t.bilibili.com/d2"]);

		patchGlobals(c, (g) => {
			g.ai.providers = {};
		});
		c.bus.emit("config-changed", { scope: "globals" });
		reportBili("1", bilibiliPost("正文"), "d3");
		await settleTracked(c);
		expect(H.ai[0].comment).toHaveBeenCalledTimes(1); // 撤掉之后没再调
		expect((await mainTexts()).at(-1)).toBe("模板 阿绫\nhttps://t.bilibili.com/d3");
		expect(await aiTexts()).toHaveLength(1); // 撤掉之后这一条没有 AI 版
	});

	it("仍启用但改配置:增量 updateConfig,不重建实例", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		patchGlobals(c, (g) => {
			const p = g.ai.providers[g.ai.activeProfile];
			if (p) p.model = "gpt-4o";
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(H.ai).toHaveLength(1);
		expect(H.ai[0].updateConfig).toHaveBeenCalledTimes(1);
	});
});

describe("createEngines — image 配色热更", () => {
	it("puppeteer 在位:globals 变更 → imageRenderer.updateConfig 带新样式", () => {
		const c = setup({ puppeteer: true });
		active = c;
		patchGlobals(c, (g) => {
			g.defaults.cards.liveCoverImageIds = ["cover-1"];
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(H.image[0].updateConfig).toHaveBeenCalled();
	});

	/**
	 * 字体那一项 2026-09-14 退役成皮肤旋钮,数据区那三个开关同日一起退役 —— 从 cardStyle
	 * 透给渲染器的东西就此空了,所以这里钉的是**旋钮值**那条热更:拧一枚旋钮要当场生效,
	 * 与从前改字体一样。
	 */
	it("旋钮值改完直透 ImageRenderer 同名字段(全链路不桥接)", () => {
		const c = setup({ puppeteer: true });
		active = c;
		// boot 时构造的 ImageRenderer 一个退役字段都不带:字体与数据区三开关都不在里面了。
		const bootConfig = H.image[0].opts.config;
		expect(bootConfig.font).toBeUndefined();
		expect(bootConfig.showPopularity).toBeUndefined();
		expect(bootConfig.showArea).toBeUndefined();
		expect(bootConfig.showFans).toBeUndefined();

		patchGlobals(c, (g) => {
			g.defaults.cardSkinKnobs = { default: { font: "Noto Sans CJK SC" } };
		});
		c.bus.emit("config-changed", { scope: "globals" });
		const last = H.image[0].updateConfig.mock.calls.at(-1)?.[0];
		expect(last).toMatchObject({
			cardSkinKnobs: { default: { font: "Noto Sans CJK SC" } },
		});
	});
});

describe("createEngines — 订阅 / 鉴权事件转译", () => {
	it("subscription-changed:来源的名单回调被叫一次 + live.applyOps", async () => {
		const c = setup();
		active = c;
		await c.sourceReady;
		const fn = vi.fn();
		c.source.ctx?.onSubscriptionsChanged(fn);
		c.bus.emit("subscription-changed", { ops: [] });
		expect(fn).toHaveBeenCalledTimes(1);
		expect(H.live[0].applyOps).toHaveBeenCalledTimes(1);
	});

	it("auth-restored → live.rebuildFromSubs;auth-lost → live.teardown", () => {
		const c = setup();
		active = c;
		c.bus.emit("auth-restored");
		expect(H.live[0].rebuildFromSubs).toHaveBeenCalledTimes(1);
		c.bus.emit("auth-lost");
		expect(H.live[0].teardown).toHaveBeenCalledTimes(1);
	});
});

describe("createEngines — dispose", () => {
	it("dispose 停全引擎与登记过的来源并解绑 bus(后续 config-changed 不再生效)", async () => {
		const c = setup();
		active = c;
		await c.sourceReady;
		const live = H.live[0];
		const push = H.push[0];
		const fn = vi.fn();
		c.source.ctx?.onSubscriptionsChanged(fn);
		c.runtime.dispose();
		active = null; // 避免 afterEach 二次 dispose
		expect(c.source.stop).toHaveBeenCalledTimes(1);
		expect(live.stop).toHaveBeenCalledTimes(1);
		expect(push.stop).toHaveBeenCalledTimes(1);
		// bus handle 已解绑:dispose 后再发 config-changed 不应再叫来源的名单回调。
		c.bus.emit("config-changed", { scope: "globals" });
		expect(fn).not.toHaveBeenCalled();
		expect(c.sources.get("bilibili")).toBeUndefined();
	});

	it("dispose 之后再让来源交一条:作品入口没收到,记了那行 error", async () => {
		const c = setup({ subs: [biliSubOf("1")] });
		active = c;
		await c.sourceReady;
		const detected: PostEvent[] = [];
		c.bus.on("post-detected", (event) => detected.push(event));
		c.runtime.dispose();
		const errors = c.sourceLogger.error as ReturnType<typeof vi.fn>;
		errors.mockClear();
		reportBili("1", bilibiliPost("关停后"), "after");
		await settleTracked(c);
		expect(detected).toEqual([]);
		expect(errors).toHaveBeenCalledTimes(1);
	});

	it("P2-I:dispose 幂等 — 二次调用(index.ts 显式 + onDispose 双路径)不重复 stop", async () => {
		const c = setup();
		active = c;
		await c.sourceReady;
		const live = H.live[0];
		const push = H.push[0];
		c.runtime.dispose();
		c.runtime.dispose(); // 双调
		active = null;
		expect(c.source.stop).toHaveBeenCalledTimes(1);
		expect(live.stop).toHaveBeenCalledTimes(1);
		expect(push.stop).toHaveBeenCalledTimes(1);
	});
});

/**
 * 背景轮换游标:每次推送在推送点同步推进,只标脏;落盘由 30 秒的定时器与 dispose 那一次负责。
 * 走存储层的原子写 —— 写到一半被杀,盘上是旧的整份或新的整份,游标不会被半截 JSON 清零。
 */
describe("createEngines — 背景轮换游标落盘", () => {
	const ids = ["a", "b", "c"].map((ch) => `${ch.repeat(32)}.png`);
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-engines-cursors-"));
		await mkdir(dataPath(dataDir, ...CARD_BG_DIR), { recursive: true });
		for (const id of ids) await writeFile(dataPath(dataDir, ...CARD_BG_DIR, id), "x");
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("dispose 把推进过的游标写进 runtime/card-bg-cursors.json,目录里不留临时文件", async () => {
		const c = setup({ dataDir });
		active = c;
		const pick = H.live[0].opts.pickCardBackground;
		expect([pick("u1:live", ids), pick("u1:live", ids)]).toEqual([ids[0], ids[1]]);
		c.runtime.dispose();
		active = null;
		expect(JSON.parse(await readFile(join(dataDir, ...CARD_BG_CURSORS_FILE), "utf8"))).toEqual({
			"u1:live": 2,
		});
		expect((await readdir(dataDir)).sort()).toEqual(["library", "runtime"]);
		expect(await readdir(dirname(join(dataDir, ...CARD_BG_CURSORS_FILE)))).toEqual([
			"card-bg-cursors.json",
		]);
	});

	it("重启续接:下一轮从盘上的游标接着轮换,不归零", async () => {
		const first = setup({ dataDir });
		active = first;
		const pickFirst = H.live[0].opts.pickCardBackground;
		pickFirst("u1:live", ids);
		pickFirst("u1:live", ids);
		first.runtime.dispose();
		active = null;

		const second = setup({ dataDir });
		active = second;
		expect(H.live[1].opts.pickCardBackground("u1:live", ids)).toBe(ids[2]);
	});

	it("没推进过就不写盘(游标不脏)", () => {
		const c = setup({ dataDir });
		active = c;
		c.runtime.dispose();
		active = null;
		return expect(readdir(dataDir)).resolves.toEqual(["library"]);
	});
});

// 回归:禁用一个 UP 时,live 必须同步停推。
// 此前 subscriptionOpsToLive 的 update 分支不看 sub.enabled,把禁用翻译成带
// live:true 的 update op,LiveEngine(常驻 WS、事件驱动)listener 一直挂着照推。
// 修复:op 翻译层显式 gate enabled。动态那一半:名单只列启用中的订阅
// (`subscriptions/__tests__/source-subscriptions.test.ts`)与引擎的 `syncSubscriptions`
// (`bilibili/dynamic/__tests__/dynamic-poller.test.ts`)。
describe("createEngines — 订阅禁用/启用转译", () => {
	function makeSub(uid: string, enabled: boolean): Subscription {
		const s = makeEmptySubscription({
			id: `sub-${uid}`,
			identity: { sourceKey: "bilibili", externalId: uid },
		});
		s.enabled = enabled;
		return s;
	}

	it("禁用订阅 update:live.applyOps 收到 delete;来源的名单里没有这个人", async () => {
		const sub = makeSub("100", false);
		const c = setup({ subs: [sub] });
		active = c;
		await c.sourceReady;
		c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub }] });

		expect(H.live[0].applyOps.mock.calls.at(-1)?.[0]).toEqual([{ kind: "delete", uid: "100" }]);
		expect(c.source.ctx?.subscriptions()).toEqual([]);
	});

	it("启用订阅 update:live.applyOps 收到完整 update(非 delete);来源的名单里有这个人", async () => {
		const sub = makeSub("200", true);
		const c = setup({ subs: [sub] });
		active = c;
		await c.sourceReady;
		c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub }] });

		const liveOps = H.live[0].applyOps.mock.calls.at(-1)?.[0];
		expect(liveOps).toHaveLength(1);
		expect(liveOps[0].kind).toBe("update");
		expect(liveOps[0].uid).toBe("200");
		expect(c.source.ctx?.subscriptions().map((v) => v.externalId)).toEqual(["200"]);
	});

	/**
	 * 给某位 UP 拧了 / 还原了旋钮(ADR-0014 决策 17 的 🔗):正在监听的直播间要当场换上,
	 * 不能等重启 —— LiveEngine 只认 update op 里带的那几格。「全部还原」那一下这一格是
	 * undefined,键也得在(Object.assign 靠它盖掉旧的那份)。
	 * 验红:把 subscriptionOpsToLive 里 `cardSkinKnobs: view.cardSkinKnobs` 删掉,两条断言都红。
	 */
	it("订阅 update:live 的 update change 带上这位 UP 那层旋钮覆盖(还原后键在、值为 undefined)", () => {
		const sub = makeSub("700", true);
		sub.overrides.cardSkinKnobs = { default: { "glass-opacity": 0.4 } };
		const c = setup({ subs: [sub] });
		active = c;
		c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub }] });
		const liveOps = H.live[0].applyOps.mock.calls.at(-1)?.[0];
		expect(liveOps[0].changes[0].cardSkinKnobs).toEqual({ default: { "glass-opacity": 0.4 } });

		delete sub.overrides.cardSkinKnobs;
		c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub }] });
		const cleared = H.live[0].applyOps.mock.calls.at(-1)?.[0][0].changes[0];
		expect(Object.hasOwn(cleared, "cardSkinKnobs")).toBe(true);
		expect(cleared.cardSkinKnobs).toBeUndefined();
	});

	it("直播拆键:update op 带上折好的 liveStreaming 开关、间隔与补报(per-UP 覆盖压过全局)", () => {
		const sub = makeSub("710", true);
		sub.overrides.features = { liveStreaming: true };
		sub.overrides.liveStreaming = { streamingIntervalHours: 6 };
		sub.overrides.liveStart = { catchUpOnBoot: true };
		const c = setup({ subs: [sub] });
		active = c;
		c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub }] });

		const change = H.live[0].applyOps.mock.calls.at(-1)?.[0][0].changes[0];
		expect(change).toMatchObject({
			scope: "live",
			liveStart: true,
			liveStreaming: true,
			streamingIntervalHours: 6,
			catchUpOnBoot: true,
		});
	});

	it("直播拆键:没覆盖时取全局出厂值 —— 周期关、间隔 1 小时、不补报", () => {
		const sub = makeSub("711", true);
		const c = setup({ subs: [sub] });
		active = c;
		c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub }] });

		expect(H.live[0].applyOps.mock.calls.at(-1)?.[0][0].changes[0]).toMatchObject({
			liveStreaming: false,
			streamingIntervalHours: 1,
			catchUpOnBoot: false,
		});
	});

	it("禁用订阅 add:不向 live.applyOps 下发 add op", () => {
		const sub = makeSub("300", false);
		const c = setup({ subs: [sub] });
		active = c;
		c.bus.emit("subscription-changed", { ops: [{ kind: "add", sub }] });

		expect(H.live[0].applyOps.mock.calls.at(-1)?.[0]).toEqual([]);
	});

	it("add op:来源的名单只带 externalId 与 features(作品设置不在来源里,per-UP 覆盖由核心每条现折);直播那头照旧带着折好的皮肤 id", async () => {
		const sub = makeSub("600", true);
		sub.overrides.imageGroup = { enabled: false };
		sub.overrides.templates = { post: "🔔 {name}", postVideo: "🎬 {name}" };
		sub.overrides.cardSkin = "k9zzz-0badf00d";
		const c = setup({ subs: [sub] });
		active = c;
		await c.sourceReady;
		c.bus.emit("subscription-changed", { ops: [{ kind: "add", sub }] });

		const roster = c.source.ctx?.subscriptions() ?? [];
		expect(roster.map((v) => Object.keys(v).sort())).toEqual([["externalId", "features"]]);
		expect(roster[0]?.externalId).toBe("600");
		expect(roster[0]?.features.has("post")).toBe(true);
		// 直播那头照旧带着折好的皮肤 id。
		const liveView = H.live[0].applyOps.mock.calls.at(-1)?.[0][0].sub;
		expect(liveView.cardSkin).toBe("k9zzz-0badf00d");
	});

	it("没有 per-UP 皮肤 → 直播引擎拿全局那套", () => {
		const sub = makeSub("801", true);
		const c = setup({ subs: [sub] });
		active = c;
		patchGlobals(c, (g) => {
			g.defaults.cardSkin = "k1aaa-11111111";
		});
		c.bus.emit("subscription-changed", { ops: [{ kind: "add", sub }] });

		expect(H.live[0].applyOps.mock.calls.at(-1)?.[0][0].sub.cardSkin).toBe("k1aaa-11111111");
	});

	it("禁用订阅 add:来源的名单不列它(停用的不进名单)", async () => {
		const sub = makeSub("700", false);
		const c = setup({ subs: [sub] });
		active = c;
		await c.sourceReady;
		c.bus.emit("subscription-changed", { ops: [{ kind: "add", sub }] });

		expect(c.source.ctx?.subscriptions()).toEqual([]);
	});

	it("订阅删了:live 收到 delete(无视 enabled);来源的名单里也没有它了", async () => {
		const sub = makeSub("400", true);
		const subs: Subscription[] = [sub];
		const c = setup({ subs });
		active = c;
		await c.sourceReady;
		expect(c.source.ctx?.subscriptions().map((v) => v.externalId)).toEqual(["400"]);
		subs.length = 0;
		c.bus.emit("subscription-changed", { ops: [{ kind: "remove", sub }] });

		expect(H.live[0].applyOps.mock.calls.at(-1)?.[0]).toEqual([{ kind: "delete", uid: "400" }]);
		expect(c.source.ctx?.subscriptions()).toEqual([]);
	});

	it("拓展订阅的增删改不进 B 站引擎(ADR-0019 决策 9),也不进 B 站来源的名单", async () => {
		const ext = makeExtensionSubscription({ externalId: "400" });
		const c = setup({ subs: [ext] });
		active = c;
		await c.sourceReady;
		c.bus.emit("subscription-changed", {
			ops: [
				{ kind: "add", sub: ext },
				{ kind: "update", sub: ext },
				{ kind: "remove", sub: ext },
			],
		});

		expect(H.live[0].applyOps.mock.calls.at(-1)?.[0]).toEqual([]);
		expect(c.source.ctx?.subscriptions()).toEqual([]);
	});

	it("连续 disable→enable→disable:live 翻译在 delete / update 间正确切换", () => {
		const sub = makeSub("500", true);
		const c = setup({ subs: [sub] });
		active = c;
		const liveOpsOf = () => H.live[0].applyOps.mock.calls.at(-1)?.[0];

		// disable
		sub.enabled = false;
		c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub }] });
		expect(liveOpsOf()).toEqual([{ kind: "delete", uid: "500" }]);

		// re-enable → 完整 update(LiveEngine.applyOps 见无 listener 走 lookupFullSub 重建)
		sub.enabled = true;
		c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub }] });
		expect(liveOpsOf()).toHaveLength(1);
		expect(liveOpsOf()[0].kind).toBe("update");

		// disable again
		sub.enabled = false;
		c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub }] });
		expect(liveOpsOf()).toEqual([{ kind: "delete", uid: "500" }]);
	});
});

// ---------------------------------------------------------------------------
// 消息版式(messageLayout)— adapter 折叠 / 序列广播映射 / 全局热更
// ---------------------------------------------------------------------------

describe("createEngines — 消息版式", () => {
	const subRt = {
		get: () => undefined,
		getAll: () => ({}),
		patch: vi.fn(async () => {}),
		prune: vi.fn(async () => {}),
		load: vi.fn(async () => {}),
	} as any;

	it("buildLiveSubViewSingle 折叠 eff.messageLayout 的直播切片", () => {
		const g = makeDefaultGlobalConfig();
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		const live = buildLiveSubViewSingle(sub, subRt, g);
		expect(live.messageLayout).toEqual(DEFAULT_MESSAGE_LAYOUT.live);
	});

	it("postSettingsOf 折叠 eff.messageLayout 的作品切片", () => {
		const g = makeDefaultGlobalConfig();
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		expect(postSettingsOf(sub, g, true).messageLayout).toEqual(DEFAULT_MESSAGE_LAYOUT.post);
	});

	it("per-UP messageLayout 覆盖折叠进作品设置与直播视图(整份覆盖 + normalize)", () => {
		const g = makeDefaultGlobalConfig();
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		sub.overrides.messageLayout = {
			...DEFAULT_MESSAGE_LAYOUT,
			post: {
				blocks: [
					{ id: "text", type: "text", visible: true },
					{ id: "card", type: "card", visible: false },
				],
				separator: " | ",
			},
		};
		const post = postSettingsOf(sub, g, true);
		expect(post.messageLayout.blocks.slice(0, 2).map((b: { id: string }) => b.id)).toEqual([
			"text",
			"card",
		]);
		expect(post.messageLayout.separator).toBe(" | ");
		// normalize 追加缺失的 link 块
		expect(post.messageLayout.blocks.map((b: { type: string }) => b.type)).toContain("link");
		expect(buildLiveSubViewSingle(sub, subRt, g).messageLayout).toEqual(
			DEFAULT_MESSAGE_LAYOUT.live,
		);
	});

	it("作品分条(分条符切两条)→ 经真的队列与装配,PushRouter 收到一次推送,本体那个锚点里是两条 payload", async () => {
		// 引擎说 uid,入口认订阅 —— 这个 uid 得真有一条订阅,接线才往下交。
		const c = setup({ puppeteer: true, subs: [biliSubOf("1", "s1")] });
		active = c;
		patchGlobals(c, (g) => {
			const layout = g.defaults.messageLayout.post;
			layout.blocks = [
				{ id: "card", type: "card", visible: true },
				{ id: "split", type: "split", visible: true },
				{ id: "text", type: "text", visible: true },
				{ id: "link", type: "link", visible: true },
			];
		});
		reportBili("1", bilibiliPost("正文"), "d1");
		await settleTracked(c);
		expect(H.push[0].push).toHaveBeenCalledTimes(1);
		const [sent] = H.push[0].push.mock.calls[0];
		expect(sent.subscriptionId).toBe("s1");
		expect(sent.feature).toBe("post");
		expect(sent.anchors).toHaveLength(1);
		expect(sent.anchors[0].role).toBe("main");
		const payloads = sent.anchors[0].messages;
		expect(payloads).toHaveLength(2);
		expect(payloads[0].kind).toBe("image");
		expect(payloads[1].kind).toBe("text");
		// 作品的本体不抑制 @全体(按特性决定)
		expect(sent).not.toHaveProperty("allowAtAll");
	});

	it("livePushLike.push(分条)→ feature 映射 + 许 @全体(开播=3)", async () => {
		const c = setup({
			subs: [
				makeEmptySubscription({ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" } }),
			],
		});
		active = c;
		const msg1 = segmentContentBuilder.message([
			segmentContentBuilder.image(Buffer.from("img"), "image/jpeg"),
		]);
		const msg2 = segmentContentBuilder.message([segmentContentBuilder.text("开播文案")]);
		await H.live[0].opts.push.push({
			uid: "1",
			type: 3,
			anchors: [{ role: "main", messages: [msg1, msg2] }],
		});
		expect(H.push[0].push).toHaveBeenCalledTimes(1);
		const [sent] = H.push[0].push.mock.calls[0];
		expect(sent.subscriptionId).toBe("s1");
		expect(sent.feature).toBe("liveStart");
		const payloads = sent.anchors[0].messages;
		expect(payloads).toHaveLength(2);
		expect(payloads[0].kind).toBe("image");
		expect(payloads[1]).toEqual({ kind: "text", text: "开播文案" });
		expect(sent).not.toHaveProperty("allowAtAll");
	});

	it("回归镜像:只改全局 messageLayout → live.applyOps 收到刷新;作品下一条立即按新版式(不经引擎)", async () => {
		const sub = makeEmptySubscription({
			id: "sub-1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		const c = setup({ subs: [sub], globals: TEMPLATE_GLOBALS("{name}更新了") });
		active = c;
		H.live[0].applyOps.mockClear();
		reportBili("1", bilibiliPost("正文"), "d1");
		await settleTracked(c);
		patchGlobals(c, (g) => {
			const block = g.defaults.messageLayout.post.blocks.find((b) => b.type === "link");
			expect(block).toBeDefined();
			if (block) block.visible = false;
		});
		c.bus.emit("config-changed", { scope: "globals" });

		const liveOps = H.live[0].applyOps.mock.calls.at(-1)?.[0];
		expect(liveOps).toHaveLength(1);
		expect(liveOps[0]).toMatchObject({ kind: "update", uid: "1" });
		// live 的 update change 带上 messageLayout(live 切片)
		expect(liveOps[0].changes[0].messageLayout).toEqual(
			c.configStore.getGlobals().defaults.messageLayout.live,
		);
		reportBili("1", bilibiliPost("正文"), "d2");
		await settleTracked(c);
		// 第一条带链接,第二条版式藏起了链接部件。
		expect(await mainTexts()).toEqual(["阿绫更新了\nhttps://t.bilibili.com/d1", "阿绫更新了"]);
	});
});

// ---------------------------------------------------------------------------
// 链接卡的呈现
//
// 动态卡没有按订阅的样式覆盖(㉔e 起,卡片设置只剩直播封面),链接卡的整份呈现(样式 + 图廊轮换 + 版式)
// 从引擎拿,并且随 config-changed 刷新。
// ---------------------------------------------------------------------------

describe("createEngines — 链接卡的呈现与开关", () => {
	it("开关与版式随 config-changed 刷新,不用每条消息整份深拷贝 globals", () => {
		const c = setup();
		active = c;
		expect(c.runtime.linkParsing()).toEqual({
			enabled: false,
			cooldownSeconds: 60,
			defaults: { parse: true, form: "image" },
			groups: {},
		});
		expect(c.runtime.linkCardPresentation().cardSkin).toBe(
			c.configStore.getGlobals().defaults.cardSkin,
		);

		patchGlobals(c, (g) => {
			g.linkParsing = {
				enabled: true,
				cooldownSeconds: 5,
				defaults: { parse: true, form: "image" },
				groups: {},
			};
			g.defaults.cardSkin = "skin-link";
		});
		c.bus.emit("config-changed", { scope: "globals" });

		expect(c.runtime.linkParsing()).toEqual({
			enabled: true,
			cooldownSeconds: 5,
			defaults: { parse: true, form: "image" },
			groups: {},
		});
		expect(c.runtime.linkCardPresentation().cardSkin).toBe("skin-link");
	});

	// 例外引用的是目标:目标或连接停用、删掉都会改变答案,所以逐群表要跟着
	// globals / targets / adapters 三种变更重算,不能只盯 globals。
	it("逐群答案随 globals、targets、adapters 三种 config-changed 重算", () => {
		const ADAPTER = "11111111-1111-4111-8111-111111111111";
		const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const c = setup();
		active = c;
		c.configStore._setConnections([
			{
				id: ADAPTER,
				name: "bot",
				enabled: true,
				adapterKey: "onebot",
				platform: "onebot",
				settings: {},
				platformSnapshot: snapshotFor("onebot"),
			} as any,
		]);
		c.configStore._setTargets([
			{
				id: TARGET,
				name: "群",
				connectionId: ADAPTER,
				scope: "group",
				enabled: true,
				kind: "session",
				address: "123",
			} as PushTarget,
		]);
		const KEY = `${ADAPTER}:123`;
		const STRANGER = `${ADAPTER}:999`;
		// 出厂默认行解析开:目标群与陌生群都解析。
		expect(c.runtime.linkPolicyFor(KEY).parse).toBe(true);
		expect(c.runtime.linkPolicyFor(STRANGER).parse).toBe(true);

		patchGlobals(c, (g) => {
			g.linkParsing = {
				enabled: true,
				cooldownSeconds: 60,
				defaults: { parse: false, form: "image" },
				groups: { [TARGET]: { parse: true } },
			};
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(c.runtime.linkPolicyFor(KEY)).toEqual({ parse: true, form: "image" });
		expect(c.runtime.linkPolicyFor(STRANGER).parse).toBe(false);

		// 目标停用 → 那群不再解析;只发 targets 的变更,不发 globals。
		c.configStore._setTargets([{ ...c.configStore.getTargets()[0], enabled: false } as PushTarget]);
		c.bus.emit("config-changed", { scope: "targets" });
		expect(c.runtime.linkPolicyFor(KEY).parse).toBe(false);

		// 目标恢复、但连接停用 → 同样不算;只发 connections 的变更。
		c.configStore._setTargets([{ ...c.configStore.getTargets()[0], enabled: true } as PushTarget]);
		c.bus.emit("config-changed", { scope: "targets" });
		expect(c.runtime.linkPolicyFor(KEY).parse).toBe(true);
		c.configStore._setConnections([
			{ ...c.configStore.getConnections()[0], enabled: false } as any,
		]);
		c.bus.emit("config-changed", { scope: "connections" });
		expect(c.runtime.linkPolicyFor(KEY).parse).toBe(false);
	});

	it("链接卡没有样式覆盖可言:配色恒为 undefined(渲染器逐字段回退全局),改全局封面也不带进来", () => {
		const c = setup();
		active = c;
		expect(c.runtime.linkCardPresentation().colors).toBeUndefined();

		patchGlobals(c, (g) => {
			g.defaults.cards.liveCoverImageIds = ["cover.png"];
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(c.runtime.linkCardPresentation().colors).toBeUndefined();
	});
});

/** 目标可达性只在通断翻转时写:四格真值表(没记过的那格在「后台写登记进 track」里钉了)。 */
describe("createEngines — 目标可达性不翻转就不写", () => {
	const TARGET_ID = "22222222-2222-4222-8222-222222222222";
	const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
	const connection = {
		id: CONNECTION_ID,
		name: "bot",
		enabled: true,
		adapterKey: "onebot",
		platform: "onebot",
		settings: {},
		platformSnapshot: snapshotFor("onebot"),
	} as any;

	async function sendOnce(
		prev: "reachable" | "unreachable",
		sendOk: boolean,
	): Promise<ReturnType<typeof vi.fn>> {
		const recordTargetReachability = vi.fn(async () => {});
		const pa: PlatformAdapter = {
			adapterKey: "onebot",
			settingsSchema: z.unknown(),
			isAvailable: () => true,
			send: async () => (sendOk ? { ok: true, latencyMs: 7 } : fail("unavailable", "发不出去")),
			probe: async () => ok({ latencyMs: 1 }),
			start() {},
			stop() {},
		};
		const c = setup({
			connections: [connection],
			platformAdapters: [pa],
			overrides: { configStore: { recordTargetReachability } },
		});
		active = c;
		const changedAt = "2026-01-01T00:00:00.000Z";
		c.configStore._setTargets([
			{
				id: TARGET_ID,
				name: "群",
				connectionId: CONNECTION_ID,
				enabled: true,
				kind: "session",
				scope: "group",
				address: "1",
				reachability:
					prev === "reachable"
						? { status: "reachable", changedAt, latencyMs: 1 }
						: { status: "unreachable", changedAt, message: "旧的失败" },
			} as unknown as PushTarget,
		]);
		await new Promise((r) => setTimeout(r, 0));
		await H.push[0].opts.dispatcher.send(TARGET_ID, { kind: "text", text: "hi" });
		return recordTargetReachability;
	}

	it("已是 reachable、这次成功 → 不写", async () => {
		expect(await sendOnce("reachable", true)).not.toHaveBeenCalled();
	});

	it("已是 reachable、这次失败 → 写成 unreachable(带原话)", async () => {
		const record = await sendOnce("reachable", false);
		expect(record).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenCalledWith(TARGET_ID, {
			status: "unreachable",
			changedAt: expect.any(String),
			message: "发不出去",
		});
	});

	it("已是 unreachable、这次成功 → 写成 reachable(带耗时)", async () => {
		const record = await sendOnce("unreachable", true);
		expect(record).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenCalledWith(TARGET_ID, {
			status: "reachable",
			changedAt: expect.any(String),
			latencyMs: 7,
		});
	});

	it("已是 unreachable、这次失败 → 不写", async () => {
		expect(await sendOnce("unreachable", false)).not.toHaveBeenCalled();
	});
});

describe("createEngines — 连接所在平台的能力", () => {
	const ADAPTER = "11111111-1111-4111-8111-111111111111";
	const onebot = {
		id: ADAPTER,
		name: "bot",
		enabled: true,
		adapterKey: "onebot",
		platform: "onebot",
		settings: {},
		platformSnapshot: snapshotFor("onebot"),
	} as any;

	/** 探一次就变「支持」的假平台实现;探之前是「未探测」。 */
	function fakePlatform(answer: "supported" | "unknown" = "supported", probeOk = true) {
		let state: "unknown" | "supported" = "unknown";
		const probeCapabilities = vi.fn(async () => {
			state = answer === "supported" ? "supported" : "unknown";
			return caps();
		});
		const caps = (): ConnectionCapabilities => ({
			atAll: { state: "unknown" },
			inbound: { state: "unknown" },
			miniAppCard: state === "supported" ? { state, checkedAt: 1 } : { state },
		});
		const pa: PlatformAdapter = {
			adapterKey: "onebot",
			settingsSchema: z.unknown(),
			isAvailable: () => true,
			send: async () => ({ ok: true, latencyMs: 1 }),
			probe: vi.fn(async () => (probeOk ? ok({ latencyMs: 1 }) : fail("unavailable", "连不上"))),
			capabilities: () => caps(),
			probeCapabilities,
			start() {},
			stop() {},
		};
		return { pa, probeCapabilities };
	}
	const tick = () => new Promise<void>((r) => setTimeout(r, 0));

	it("开机健康探测顺路把「未探测」的能力探一次;之后从 connectionCapabilities 读得到", async () => {
		const { pa, probeCapabilities } = fakePlatform();
		const c = setup({ connections: [onebot], platformAdapters: [pa] });
		active = c;
		await tick();
		expect(probeCapabilities).toHaveBeenCalledTimes(1);
		expect(c.runtime.connectionCapabilities(ADAPTER)?.miniAppCard).toEqual({
			state: "supported",
			checkedAt: 1,
		});
		// 已经有答案的不重探:主人点「测试」只做健康探测。
		await c.runtime.probeConnection(ADAPTER);
		expect(probeCapabilities).toHaveBeenCalledTimes(1);
	});

	it("探完仍「未探测」→ 主人点「测试」会再给一次机会", async () => {
		const { pa, probeCapabilities } = fakePlatform("unknown");
		const c = setup({ connections: [onebot], platformAdapters: [pa] });
		active = c;
		await tick();
		expect(probeCapabilities).toHaveBeenCalledTimes(1);
		await c.runtime.probeConnection(ADAPTER);
		expect(probeCapabilities).toHaveBeenCalledTimes(2);
		expect(c.runtime.connectionCapabilities(ADAPTER)?.miniAppCard).toEqual({ state: "unknown" });
	});

	it("连都连不上的连接不补探能力 —— 那一趟只会白等满一个超时", async () => {
		const { pa, probeCapabilities } = fakePlatform("unknown", false);
		const c = setup({ connections: [onebot], platformAdapters: [pa] });
		active = c;
		await tick();
		expect(pa.probe).toHaveBeenCalled();
		expect(probeCapabilities).not.toHaveBeenCalled();
	});

	it("sendToAddress 转给派发器:适配器收到那个会话;接线层给的截流闸也接在这条路上", async () => {
		const { pa } = fakePlatform();
		const send = vi.spyOn(pa, "send");
		const open = setup({ connections: [onebot], platformAdapters: [pa] });
		active = open;
		const session = { scope: "group" as const, address: "123" };
		await open.runtime.sendToAddress(ADAPTER, session, { kind: "text", text: "hi" });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[1]).toMatchObject({ scope: "group", address: "123" });
		await open.runtime.dispose();

		send.mockClear();
		const interceptSend = vi.fn(() => ok({ latencyMs: 0, isSynthetic: true as const }));
		const gated = setup({ connections: [onebot], platformAdapters: [pa], interceptSend });
		active = gated;
		const result = await gated.runtime.sendToAddress(ADAPTER, session, {
			kind: "text",
			text: "hi",
		});
		expect(result).toEqual({ ok: true, latencyMs: 0, isSynthetic: true });
		expect(interceptSend).toHaveBeenCalledTimes(1);
		expect(send).not.toHaveBeenCalled();
	});

	it("没有能力概念的平台(配置里没这条连接也一样)→ undefined", () => {
		const c = setup();
		active = c;
		expect(c.runtime.connectionCapabilities("nope")).toBeUndefined();
	});
});

/**
 * 「AI 写正文」的读口(ADR-0032):推送层逐目标挑哪份正文,看的是宿主此刻的 `ai.writing`。构造时快照的话,
 * 面板里改了例外要重启才认 —— 而所有推送层的测试都用自己的假读口,这根线只有在这里钉得住。
 */
describe("createEngines — 推送层的 aiWriting 读口接的是活的全局设置", () => {
	it("读口回当前的 ai.writing;全局换了新的一份,下一次读到的就是新的", () => {
		const first = makeDefaultGlobalConfig();
		first.ai.writing.post = { enabled: false, byTarget: { "t-1": true } };
		const c = setup({ globals: first });
		active = c;
		const read = (H.push[0] as { opts: { aiWriting: () => unknown } }).opts.aiWriting;
		expect(read()).toEqual({
			post: { enabled: false, byTarget: { "t-1": true } },
			liveSummary: { enabled: true, byTarget: {} },
		});

		const next = structuredClone(first);
		next.ai.writing.post = { enabled: true, byTarget: {} };
		next.ai.writing.liveSummary = { enabled: false, byTarget: {} };
		c.configStore._set(next);
		expect(read()).toEqual({
			post: { enabled: true, byTarget: {} },
			liveSummary: { enabled: false, byTarget: {} },
		});
	});
});

/**
 * 开机补关注只在已登录时跑。未登录时关系查询回 -101、逐个补关注也全是 -101:白打 B 站,
 * 还把每条订阅标成「未关注」。未登录开机时 LoginFlow 已记下 needsRestore,扫码登录后发
 * auth-restored,由那条补上。
 */
describe("createEngines — 开机补关注", () => {
	it("未登录开机:不查关注关系", async () => {
		const c = setup({
			subs: [
				makeEmptySubscription({ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" } }),
			],
		});
		active = c;
		await new Promise((r) => setTimeout(r, 0));
		expect(c.api.fetchRelations).not.toHaveBeenCalled();
	});

	it("开机还没确认上(confirming,不算登录):不查关注关系", async () => {
		const c = setup({
			subs: [
				makeEmptySubscription({ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" } }),
			],
			loginStatus: "confirming",
		});
		active = c;
		await new Promise((r) => setTimeout(r, 0));
		expect(c.api.fetchRelations).not.toHaveBeenCalled();
	});

	it("已登录开机:查一次关注关系", async () => {
		const c = setup({
			subs: [
				makeEmptySubscription({ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" } }),
			],
			loginStatus: "logged-in",
		});
		active = c;
		await vi.waitFor(() => expect(c.api.fetchRelations).toHaveBeenCalledWith(["1"]));
	});

	it("未登录开机、之后登录恢复:补上那一次", async () => {
		const c = setup({
			subs: [
				makeEmptySubscription({ id: "s1", identity: { sourceKey: "bilibili", externalId: "1" } }),
			],
		});
		active = c;
		c.bus.emit("auth-restored");
		await vi.waitFor(() => expect(c.api.fetchRelations).toHaveBeenCalledWith(["1"]));
	});
});

/**
 * 发出去不管的写要登记进 `ctx.track()`(切片 ③)。
 *
 * 关停在 flush 段让各写道关门;关门前还没**交进写道**的活(先下载图片、再写历史)会在关门后被拒 ——
 * 数据就丢了。所以每条用例都是:让那笔写停在半路 → 断言登记进去的这件事此刻还悬着 → 放行 → 断言写已落定。
 * `track` 没接线时登记进来的是空的,`Promise.all([])` 立刻落定,第二句必红。
 */
describe("createEngines — 后台写登记进 track", () => {
	const SUB_ID = "11111111-1111-4111-8111-111111111111";
	const TARGET_ID = "22222222-2222-4222-8222-222222222222";
	const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";

	beforeEach(() => storageWriteGate.reset());
	afterEach(() => storageWriteGate.reset());

	/** 开机那一刻已经登记着的(健康探测那一轮),用例只看这之后新登记的。 */
	function newlyTracked(c: Ctx, before: number): Promise<unknown> {
		return Promise.all(c.serviceCtx.tracking.tracked.slice(before));
	}

	it("onSend:历史行登记进 track —— 历史写落盘,它才落定", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-engines-track-"));
		try {
			const sub = makeEmptySubscription({
				id: SUB_ID,
				identity: { sourceKey: "bilibili", externalId: "1" },
			});
			const historyStore = createHistoryStore({
				dataRoot: dataDir,
				bus: createNodeMessageBus(),
				logger: makeLogger() as never,
				images: makeHistoryImages(dataDir).historyImages,
			});
			const c = setup({ subs: [sub], overrides: { historyStore } });
			active = c;
			await new Promise((r) => setTimeout(r, 0));
			const before = c.serviceCtx.tracking.tracked.length;
			storageWriteGate.hold();

			H.push[0].opts.onSend({
				pushId: randomUUID(), // 历史行的 schema 要求 pushId 是 uuid
				subscriptionId: SUB_ID,
				feature: "post",
				target: null,
				messages: [{ payload: { kind: "text", text: "卡" }, role: "main" }],
			});

			expect(c.serviceCtx.tracking.tracked).toHaveLength(before + 1);
			await storageWriteGate.arrived();
			const registered = newlyTracked(c, before);
			expect(await stillPending(registered)).toBe(true);
			storageWriteGate.release();
			await registered;
			const files = await readdir(join(dataDir, "history"));
			expect(files.some((f) => f.endsWith(".jsonl"))).toBe(true);
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it("onSend:历史写失败 —— 登记进去的这件事不拒,记一条 warn", async () => {
		const sub = makeEmptySubscription({
			id: SUB_ID,
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		const record = vi.fn(async () => {
			throw new Error("queue closed");
		});
		const c = setup({ subs: [sub], overrides: { historyStore: { record } } });
		active = c;
		await new Promise((r) => setTimeout(r, 0));
		const before = c.serviceCtx.tracking.tracked.length;

		H.push[0].opts.onSend({
			pushId: "p1",
			subscriptionId: SUB_ID,
			feature: "post",
			target: null,
			messages: [{ payload: { kind: "text", text: "卡" }, role: "main" }],
		});

		await expect(newlyTracked(c, before)).resolves.toBeDefined();
		expect(c.serviceCtx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("queue closed"));
	});

	it("投递回调回写目标可达性:登记进 track —— 写交进 config 写道,它才落定", async () => {
		const write = deferred();
		const recordTargetReachability = vi.fn(() => write.promise);
		const target = {
			id: TARGET_ID,
			name: "群",
			connectionId: CONNECTION_ID,
			platform: "onebot",
			scope: "group",
			enabled: true,
		} as unknown as PushTarget;
		const c = setup({ overrides: { configStore: { recordTargetReachability } } });
		active = c;
		c.configStore._setTargets([target]);
		await new Promise((r) => setTimeout(r, 0));
		const before = c.serviceCtx.tracking.tracked.length;

		// 连接不在 → 投递失败,dispatcher 照样回调 onDelivery。
		await H.push[0].opts.dispatcher.send(TARGET_ID, { kind: "text", text: "hi" });

		expect(recordTargetReachability).toHaveBeenCalledTimes(1);
		// 失败的原话填进 `message`,码不落盘,失败没有耗时。
		expect(recordTargetReachability).toHaveBeenCalledWith(TARGET_ID, {
			status: "unreachable",
			changedAt: expect.any(String),
			message: `connection not found: connectionId=${CONNECTION_ID}`,
		});
		expect(c.serviceCtx.tracking.tracked).toHaveLength(before + 1);
		const registered = newlyTracked(c, before);
		expect(await stillPending(registered)).toBe(true);
		write.resolve(undefined);
		await registered;
	});

	it("房号解析出来即写盘:登记进 track —— 写交进 sub-runtime 写道,它才落定", async () => {
		const write = deferred();
		const patch = vi.fn(() => write.promise);
		const sub = makeEmptySubscription({
			id: SUB_ID,
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		const c = setup({ subs: [sub], overrides: { subRuntimeStore: { patch } } });
		active = c;
		await new Promise((r) => setTimeout(r, 0));
		const before = c.serviceCtx.tracking.tracked.length;

		H.live[0].opts.onRoomIdResolved("1", 4242);

		expect(patch).toHaveBeenCalledWith(SUB_ID, { roomId: 4242 });
		expect(c.serviceCtx.tracking.tracked).toHaveLength(before + 1);
		const registered = newlyTracked(c, before);
		expect(await stillPending(registered)).toBe(true);
		write.resolve(undefined);
		await registered;
	});

	describe("开机健康探测", () => {
		const onebot = (id: string) =>
			({
				id,
				name: "bot",
				enabled: true,
				adapterKey: "onebot",
				platform: "onebot",
				settings: {},
				platformSnapshot: snapshotFor("onebot"),
			}) as any;
		const okPlatform = (probe: () => Promise<ProbeResult>): PlatformAdapter => ({
			adapterKey: "onebot",
			settingsSchema: z.unknown(),
			isAvailable: () => true,
			send: async () => ({ ok: true, latencyMs: 1 }),
			probe,
			start() {},
			stop() {},
		});

		it("探测结果写回连接表:登记进 track —— 写交进 config 写道,它才落定", async () => {
			const write = deferred();
			const recordConnectionProbeState = vi.fn(() => write.promise);
			const c = setup({
				connections: [onebot(CONNECTION_ID)],
				platformAdapters: [okPlatform(async () => ({ ok: true, latencyMs: 1 }))],
				overrides: { configStore: { recordConnectionProbeState } },
			});
			active = c;

			await vi.waitFor(() => expect(recordConnectionProbeState).toHaveBeenCalledTimes(1));
			const tracked = c.serviceCtx.tracking.tracked;
			expect(tracked.length).toBeGreaterThan(0);
			expect(await stillPending(Promise.all(tracked))).toBe(true);
			write.resolve(undefined);
			await Promise.all(tracked);
		});

		it("探测没通:失败的原话填进 probeState.message,码不落盘,不带耗时", async () => {
			const recordConnectionProbeState = vi.fn(async () => {});
			const c = setup({
				connections: [onebot(CONNECTION_ID)],
				platformAdapters: [
					okPlatform(async () => fail("unauthorized", "token 不对", { upstreamCode: "http:401" })),
				],
				overrides: { configStore: { recordConnectionProbeState } },
			});
			active = c;
			await vi.waitFor(() => expect(recordConnectionProbeState).toHaveBeenCalledTimes(1));
			expect(recordConnectionProbeState).toHaveBeenCalledWith(CONNECTION_ID, {
				status: "unreachable",
				lastCheckedAt: expect.any(String),
				message: "token 不对",
			});
		});

		it("探测通了:写 reachable 与耗时", async () => {
			const recordConnectionProbeState = vi.fn(async () => {});
			const c = setup({
				connections: [onebot(CONNECTION_ID)],
				platformAdapters: [okPlatform(async () => ok({ latencyMs: 7 }))],
				overrides: { configStore: { recordConnectionProbeState } },
			});
			active = c;
			await vi.waitFor(() => expect(recordConnectionProbeState).toHaveBeenCalledTimes(1));
			expect(recordConnectionProbeState).toHaveBeenCalledWith(CONNECTION_ID, {
				status: "reachable",
				lastCheckedAt: expect.any(String),
				latencyMs: 7,
			});
		});

		it("适配器没有探测协议(unsupported):既不是通也不是不通,记成 unsupported", async () => {
			const recordConnectionProbeState = vi.fn(async () => {});
			const probe = vi
				.fn<() => Promise<ProbeResult>>()
				.mockResolvedValue(fail("unsupported", "no probe"));
			const c = setup({
				connections: [onebot(CONNECTION_ID)],
				platformAdapters: [okPlatform(probe)],
				overrides: { configStore: { recordConnectionProbeState } },
			});
			active = c;
			await vi.waitFor(() => expect(recordConnectionProbeState).toHaveBeenCalledTimes(1));
			expect(recordConnectionProbeState).toHaveBeenCalledWith(CONNECTION_ID, {
				status: "unsupported",
				lastCheckedAt: expect.any(String),
			});
		});

		it("已经是 unsupported 的连接周期探测不再写 —— 否则每条这样的连接每五分钟多一次写盘", async () => {
			const other = "44444444-4444-4444-8444-444444444444";
			const recordConnectionProbeState = vi.fn(async () => {});
			const known = {
				...onebot(CONNECTION_ID),
				probeState: { status: "unsupported", lastCheckedAt: "2026-06-06T00:00:00.000Z" },
			};
			const probe = vi
				.fn<() => Promise<ProbeResult>>()
				.mockResolvedValueOnce(fail("unsupported", "no probe"))
				.mockResolvedValueOnce(ok({ latencyMs: 1 }));
			const c = setup({
				connections: [known, onebot(other)],
				platformAdapters: [okPlatform(probe)],
				overrides: { configStore: { recordConnectionProbeState } },
			});
			active = c;
			// 第二条连接的结果写了,说明这一轮走完了;第一条(已是 unsupported)一次都没写。
			await vi.waitFor(() => expect(recordConnectionProbeState).toHaveBeenCalledTimes(1));
			expect(recordConnectionProbeState).toHaveBeenCalledWith(other, expect.anything());
		});

		it("关停一开始就不再起新的探测:一轮探下来要等每条连接的超时,登记之后不能靠预算硬等", async () => {
			const first = deferred<ProbeResult>();
			const probe = vi.fn(() => first.promise);
			const other = "44444444-4444-4444-8444-444444444444";
			const c = setup({
				connections: [onebot(CONNECTION_ID), onebot(other)],
				platformAdapters: [okPlatform(probe)],
			});
			active = c;
			await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

			c.serviceCtx.tracking.abort();
			first.resolve({ ok: true, latencyMs: 1 });
			await Promise.all(c.serviceCtx.tracking.tracked);

			expect(probe).toHaveBeenCalledTimes(1);
		});
	});

	describe("补关注", () => {
		const twoSubs = [
			makeEmptySubscription({ id: SUB_ID, identity: { sourceKey: "bilibili", externalId: "1" } }),
			makeEmptySubscription({
				id: "55555555-5555-4555-8555-555555555555",
				identity: { sourceKey: "bilibili", externalId: "2" },
			}),
		];
		/** 关系查询回「都没关注」→ 走逐个补关注。 */
		const noneFollowed = vi.fn(async () => ({ code: 0, data: null }));

		it("逐个补关注:登记进 track,关停信号中止后停在手上这一个", async () => {
			const first = deferred<{ code: number; message: string }>();
			const follow = vi.fn(() => first.promise);
			const c = setup({
				subs: twoSubs,
				loginStatus: "logged-in",
				overrides: { api: { fetchRelations: noneFollowed, follow } },
			});
			active = c;
			await vi.waitFor(() => expect(follow).toHaveBeenCalledTimes(1));
			const tracked = c.serviceCtx.tracking.tracked;
			expect(await stillPending(Promise.all(tracked))).toBe(true);

			c.serviceCtx.tracking.abort();
			first.resolve({ code: 0, message: "0" });
			await Promise.all(tracked);

			// 第二个订阅没有再发关注 —— signal 一路交到了 syncFollows 手里。
			expect(follow).toHaveBeenCalledTimes(1);
			expect(follow).toHaveBeenCalledWith("1");
		});

		it("只开直播(作品关着)的订阅开机不查、不补关注", async () => {
			const liveOnly = {
				...biliSubOf("1"),
				overrides: { features: { post: false } },
			} as Subscription;
			const follow = vi.fn(async () => ({ code: 0, message: "0" }));
			const c = setup({
				subs: [liveOnly, biliSubOf("2")],
				loginStatus: "logged-in",
				overrides: { api: { fetchRelations: noneFollowed, follow } },
			});
			active = c;
			await Promise.all(c.serviceCtx.tracking.tracked);

			expect(c.api.fetchRelations).toHaveBeenCalledWith(["2"]);
			expect(follow).toHaveBeenCalledTimes(1);
			expect(follow).toHaveBeenCalledWith("2");
		});

		/**
		 * 开关从关到开时补一次:关了的人开机时没被关注,开关翻开以后动态才有用,得当场补上。
		 * 只补**新变成需要关注**的那几位 —— 别的人这次连关系查询都不带;无关的变更一个请求都不发(写接口招风控)。
		 */
		describe("开关翻开时补一次", () => {
			// 关系查询的替身是上面共用的一个:每条用例各数各的。
			beforeEach(() => {
				noneFollowed.mockClear();
			});
			const postOff = (sub: Subscription): Subscription => ({
				...sub,
				overrides: { features: { post: false } },
			});
			const postOn = (sub: Subscription): Subscription => ({
				...sub,
				overrides: { features: { post: true } },
			});
			const follow = () => vi.fn(async (_fid: string) => ({ code: 0, message: "0" }));

			/** 开机时 1 号作品关着、2 号开着:开机那一轮只关注了 2 号。 */
			async function booted(over?: { loggedOut?: boolean; globals?: GlobalConfig }) {
				const send = follow();
				const subs = [postOff(biliSubOf("1")), biliSubOf("2")];
				const c = setup({
					subs,
					...(over?.globals ? { globals: over.globals } : {}),
					// 不给 `loginStatus` = 未登录(夹具的默认)。
					...(over?.loggedOut ? {} : { loginStatus: "logged-in" as const }),
					overrides: { api: { fetchRelations: noneFollowed, follow: send } },
				});
				active = c;
				await Promise.all(c.serviceCtx.tracking.tracked);
				return { c, subs, send };
			}

			it("订阅自己的作品开关从关到开 → 只补它这一位", async () => {
				const { c, subs, send } = await booted();
				const before = noneFollowed.mock.calls.length;
				subs[0] = postOn(biliSubOf("1"));

				c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub: subs[0] }] });
				await Promise.all(c.serviceCtx.tracking.tracked);

				expect(noneFollowed.mock.calls.length).toBe(before + 1);
				expect(noneFollowed).toHaveBeenLastCalledWith(["1"]);
				expect(send.mock.calls.map((a) => a[0])).toEqual(["2", "1"]);
			});

			it("停用的订阅被启用 → 补", async () => {
				const send = follow();
				const off = { ...biliSubOf("1"), enabled: false };
				const subs = [off];
				const c = setup({
					subs,
					loginStatus: "logged-in",
					overrides: { api: { fetchRelations: noneFollowed, follow: send } },
				});
				active = c;
				await Promise.all(c.serviceCtx.tracking.tracked);
				expect(send).not.toHaveBeenCalled();

				subs[0] = { ...off, enabled: true };
				c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub: subs[0] }] });
				await Promise.all(c.serviceCtx.tracking.tracked);

				expect(send).toHaveBeenCalledTimes(1);
				expect(send).toHaveBeenCalledWith("1");
			});

			it("全局作品开关从关到开 → 补继承它的订阅,已经在关注范围里的不再动", async () => {
				const base = makeDefaultGlobalConfig();
				const globalPostOff: GlobalConfig = {
					...base,
					defaults: { ...base.defaults, features: { ...base.defaults.features, post: false } },
				};
				const send = follow();
				const subs = [biliSubOf("1"), postOn(biliSubOf("2"))];
				const c = setup({
					subs,
					globals: globalPostOff,
					loginStatus: "logged-in",
					overrides: { api: { fetchRelations: noneFollowed, follow: send } },
				});
				active = c;
				await Promise.all(c.serviceCtx.tracking.tracked);
				expect(send.mock.calls.map((a) => a[0])).toEqual(["2"]); // 开机只关注了自己开着作品的 2 号

				c.configStore._set(base); // 全局作品开关翻开
				c.bus.emit("config-changed", { scope: "globals" });
				await Promise.all(c.serviceCtx.tracking.tracked);

				expect(send.mock.calls.map((a) => a[0])).toEqual(["2", "1"]);
			});

			it("无关的变更(全局设置别的格 / 订阅别的字段 / 开关从开到关)一个请求都不发", async () => {
				const { c, subs, send } = await booted();
				const queries = noneFollowed.mock.calls.length;
				const sends = send.mock.calls.length;

				// 全局设置保存了一下,作品开关没动。
				c.bus.emit("config-changed", { scope: "globals" });
				// 订阅改了备注,开关没动。
				subs[1] = { ...subs[1], notes: "改了备注" } as Subscription;
				c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub: subs[1] }] });
				// 开关从开到关:不取关,也不用查。
				subs[1] = postOff(biliSubOf("2"));
				c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub: subs[1] }] });
				await Promise.all(c.serviceCtx.tracking.tracked);

				expect(noneFollowed.mock.calls.length).toBe(queries);
				expect(send.mock.calls.length).toBe(sends);
			});

			it("新增的订阅不在这里补(新建的那条路由当场关注,这里再补就是重复发写请求)", async () => {
				const { c, subs, send } = await booted();
				const sends = send.mock.calls.length;
				const added = biliSubOf("3");
				subs.push(added);

				c.bus.emit("subscription-changed", { ops: [{ kind: "add", sub: added }] });
				await Promise.all(c.serviceCtx.tracking.tracked);

				expect(send.mock.calls.length).toBe(sends);
			});

			it("没登录:开关翻开不查不补(等登录恢复那一轮全量补上)", async () => {
				const { c, subs, send } = await booted({ loggedOut: true });
				expect(noneFollowed).not.toHaveBeenCalled();
				subs[0] = postOn(biliSubOf("1"));

				c.bus.emit("subscription-changed", { ops: [{ kind: "update", sub: subs[0] }] });
				await Promise.all(c.serviceCtx.tracking.tracked);

				expect(noneFollowed).not.toHaveBeenCalled();
				expect(send).not.toHaveBeenCalled();
			});
		});
	});
});
