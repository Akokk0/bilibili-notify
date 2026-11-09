// biome-ignore-all lint/suspicious/noExplicitAny: vitest mock class 字段/构造器入参故意保留 any,避免重复定义业务实例的窄类型
/**
 * 单元测试 — `createPipelineRuntime` 的「无重启热重载」契约(独立端配置流向核心)。
 *
 * `PushRouter` / `CommentaryGenerator` / `ImageRenderer` 用 `vi.mock` 替身,
 * 其余按真实接线构造,并用真实 `NodeMessageBus` 驱动事件,聚焦验证 pipeline.ts
 * 的 wiring 与热重载分支:
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
 *   subscription-changed:     转译并下发到动态轮询
 *   dispose():                stop 动态轮询与直播监听 + 解绑 bus(dispose 后 config-changed 不再生效)
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AuthState,
	Connection,
	ConnectionCapabilities,
	GlobalSettings,
	PlatformAdapter,
	Post,
	PostEvent,
	PostReport,
	ProbeResult,
	PushTarget,
	Source,
	SourceAuth,
	SourceContext,
	Subscription,
} from "@bilibili-notify/internal";
import {
	DEFAULT_MESSAGE_LAYOUT,
	fail,
	type Identity,
	makeDefaultGlobalSettings,
	makeEmptySubscription,
	ok,
	sameIdentity,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { registryOf } from "../../__tests__/support/adapter-ctx.js";
import { placeholderDescriptor } from "../../__tests__/support/adapter-descriptor.js";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { makeHistoryImages } from "../../__tests__/support/history-images.js";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import {
	deferred,
	makeTrackingContext,
	stillPending,
} from "../../__tests__/support/track-context.js";
import { createAiToolProviderRegistry } from "../../ai/tool-provider-registry.js";
import { type BiliSettings, BiliSettingsSchema } from "../../bilibili/settings.js";
import type { ConfigStore } from "../../config/store.js";
import { createHistoryStore } from "../../history/store.js";
import { i18n } from "../../i18n/index.js";
import { createLinkResolverRegistry } from "../../link-preview/registry.js";
import type { LiveTable, LiveTableEntry } from "../../live/live-table.js";
import { createProblemTable, type ProblemTable } from "../../problems/problem-table.js";
import { makeSource } from "../../subscriptions/__tests__/fixtures.js";
import { createSourceRegistry, type SourceRegistry } from "../../subscriptions/registry.js";
import { CARD_BG_CURSORS_FILE, CARD_BG_DIR } from "../card-assets.js";
import { createNodeMessageBus } from "../message-bus.js";
import { dataPath } from "../roots.js";
import type { NodeServiceContext } from "../service-context.js";

// ---- 参与构造的模块 spy mocks(每次构造把实例塞进 H.<component>,字段方法均为 vi.fn)----
/**
 * 在播表的内存替身:场次引擎写它(`replace` / `merge` / `remove`),别的读它(`get`)。接线测试只关心
 * 「引擎写进去、读的人读得到」,不关心合并窗口那一发(那是 `live-table.test.ts` 的事)。
 */
function memoryLiveTable(): Pick<LiveTable, "get" | "list" | "replace" | "merge" | "remove"> {
	const rows = new Map<string, LiveTableEntry>();
	return {
		get: (id) => rows.get(id),
		list: () => [...rows.values()],
		replace: (id, sourceKey, startedAt, details) => {
			rows.set(id, { subscriptionId: id, sourceKey, startedAt, details, updatedAt: Date.now() });
		},
		merge: (id, sourceKey, startedAt, details) => {
			const prev = rows.get(id);
			rows.set(id, {
				subscriptionId: id,
				sourceKey,
				startedAt: startedAt ?? prev?.startedAt,
				details: { ...prev?.details, ...details },
				updatedAt: Date.now(),
			});
		},
		remove: (id) => {
			rows.delete(id);
		},
	};
}

const H = vi.hoisted(() => ({
	push: [] as any[],
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

// 落盘函数前的闸默认敞开;只有「后台写登记进 track」那组用例才 hold(见 support/storage-write-gate.ts)。
vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

vi.mock("@bilibili-notify/ai", async (importOriginal) => ({
	// 订阅视图拼 creator 用的纯函数,走真的。
	creatorOf: (await importOriginal<typeof import("@bilibili-notify/ai")>()).creatorOf,
	// 推送点评拼提示词时落的中性叫法,走真的常量。
	PROMPT_NEUTRAL_NOUNS: (await importOriginal<typeof import("@bilibili-notify/ai")>())
		.PROMPT_NEUTRAL_NOUNS,
	CommentaryGenerator: class {
		opts: any;
		start = vi.fn();
		updateConfig = vi.fn();
		/**
		 * 构造后 pipeline.ts 会立刻 `attachReadOnlyTools` 把只读工具接上。替身少了
		 * 这个方法会当场抛,而 buildCommentary 的 try/catch 会把它吞成「AI 初始化
		 * 失败」—— 表现是 H.ai 里有实例但 start 一次没调,不是一眼能看懂的报错。
		 */
		setCreatorReader = vi.fn();
		setProvidedTools = vi.fn();
		/** 作品装配的 AI 点评(经 `deps.ai()` 每条现取)。 */
		comment = vi.fn(async (..._args: unknown[]) => "点评");
		/** 同上:pipeline.ts 构造后还会接联网搜索的执行器热读口。 */
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
		// 推送链路把它当 transform 交给字体读取器 —— 真身在 packages/image,这里只要个能认出来的替身。
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
const { createPipelineRuntime } = await import("../pipeline.js");
const { postSettingsOf } = await import("../../posts/post-settings.js");

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
	initial: GlobalSettings,
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
		getConnection: (id: string) => connections.find((c) => c.id === id),
		patchTarget: vi.fn(async () => {}),
		patchConnection: vi.fn(async () => {}),
		recordConnectionProbeState: vi.fn(async () => {}),
		recordTargetReachability: vi.fn(async () => {}),
		_set: (next: GlobalSettings) => {
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
	runtime: ReturnType<typeof createPipelineRuntime>;
	bus: ReturnType<typeof createNodeMessageBus>;
	serviceCtx: ReturnType<typeof makeServiceCtx>;
	configStore: ReturnType<typeof makeConfigStore>;
	/** 开机时 `registerSource` 登进去的假来源(`noSource` 时它存在但没登记)。 */
	source: ReturnType<typeof makeSource>;
	/** `registerSource` 落定:登记表里有它、关停时才收得到。需要在 dispose 前就保证登记完成的用例先 await 它。 */
	sourceReady: Promise<unknown>;
	/** 主来源的撤登记把手;`noSource` 时没有。 */
	sourceRegistration?: Promise<{ dispose(): void }>;
	/** 额外来源的上下文,按来源键取(`extraSources` 登记的那些)。 */
	extraSource(sourceKey: string): SourceContext;
	/** `registerSource` 的登记项带进去的日志器(来源上下文的 `ctx.logger` 该是它)。 */
	sourceLogger: ReturnType<typeof makeLogger>;
	sources: SourceRegistry;
	/** 递给 `createPipelineRuntime` 的问题表(真表):来源上下文往里写、通知器听它。 */
	problems: ProblemTable;
}

function setup(opts?: {
	globals?: GlobalSettings;
	/** 开机那一刻的 B 站设置(只给要改的几格,其余取格式的默认值);不给 = 全默认。 */
	bilibili?: Partial<BiliSettings>;
	puppeteer?: boolean;
	subs?: Subscription[];
	/** 配置表里的连接(开机健康探测会挨个探它们)。 */
	connections?: Connection[];
	/** 平台实现(探测 / 能力都问它)。 */
	platformAdapters?: PlatformAdapter[];
	/** 开发版的推送截流(接线层给的);不给 = 不传。 */
	interceptSend?: Parameters<typeof createPipelineRuntime>[0]["interceptSend"];
	/** 卡片皮肤那三口(接线层给的);不给 = 这台机器只有内置默认皮肤。 */
	cardSkins?: Parameters<typeof createPipelineRuntime>[0]["cardSkins"];
	/** 拓展订阅的平台名(接线层给的);不给 = 女仆那份视图退拓展 id。 */
	extensionPlatformLabel?: Parameters<typeof createPipelineRuntime>[0]["extensionPlatformLabel"];
	/** 拓展清单里作品叫法(接线层给的);不给 = 女仆那份视图退中性叫法。 */
	extensionPostNoun?: Parameters<typeof createPipelineRuntime>[0]["extensionPostNoun"];
	/** 女仆读统计的口(接线层给的);不给 = 女仆的作品 / 统计工具答「没接上」。 */
	creatorStats?: Parameters<typeof createPipelineRuntime>[0]["creatorStats"];
	/** 出图器的「图库引用 → 地址」口(接线层给的);不给 = 不传。 */
	resolveImageRef?: Parameters<typeof createPipelineRuntime>[0]["resolveImageRef"];
	/** AI 点评看只有图库引用的图时读字节的口(接线层给的);不给 = 一个什么都读不到的替身。 */
	readImage?: Parameters<typeof createPipelineRuntime>[0]["readImage"];
	/** 直播场次用的在播表;不给 = 不接直播。 */
	liveTable?: Parameters<typeof createPipelineRuntime>[0]["liveTable"];
	/** B 站作品图 / 直播封面的抓图服务(接线层用 B 站接口的请求客户端建的);不给 = 一个什么都抓不到的替身。 */
	imageFetcher?: Parameters<typeof createPipelineRuntime>[0]["imageFetcher"];
	/** 登记的假来源是否实现拉取式的 `fetchLiveStatus`;不给 = 没实现。 */
	fetchLiveStatus?: Source["fetchLiveStatus"];
	/** 假来源登记在哪个键下;不给 = `bilibili`。 */
	sourceKey?: string;
	/** 主来源的描述符作品叫法;不给 = `makeSource()` 的「动态」。 */
	sourcePostNoun?: string;
	/** 主来源之外再登记几个来源。 */
	extraSources?: Array<{ sourceKey: string; source: ReturnType<typeof makeSource> }>;
	/** 不给推送链路登记那个假来源(测「来源没在跑」)。 */
	noSource?: boolean;
	/** 数据目录;不给 = 一个不存在的临时目录(不落盘的用例都用它)。 */
	dataDir?: string;
	/** 换掉存储替身里的几个口子(登记进 track 的那组用例让写停在半路)。 */
	overrides?: {
		configStore?: Record<string, unknown>;
		historyStore?: unknown;
		subscriptionStateStore?: Record<string, unknown>;
	};
}): Ctx {
	const serviceCtx = makeServiceCtx();
	const bus = createNodeMessageBus();
	const configStore = Object.assign(
		makeConfigStore(
			opts?.globals ?? makeDefaultGlobalSettings(),
			bus,
			BiliSettingsSchema.parse(opts?.bilibili ?? {}),
		),
		opts?.overrides?.configStore,
	);
	if (opts?.connections) configStore._setConnections(opts.connections);
	const subs = opts?.subs ?? [];
	const sources = createSourceRegistry();
	const source = makeSource();
	if (opts?.sourcePostNoun) {
		Object.assign(source, { descriptor: { ...source.descriptor, postNoun: opts.sourcePostNoun } });
	}
	if (opts?.fetchLiveStatus) source.fetchLiveStatus = opts.fetchLiveStatus;
	const problems = createProblemTable({ logger: serviceCtx.logger });
	const runtime = createPipelineRuntime({
		sources,
		linkResolvers: createLinkResolverRegistry(),
		aiToolProviders: createAiToolProviderRegistry(),
		problems,
		profileReports: { report: () => {} },
		serviceCtx: serviceCtx as unknown as NodeServiceContext,
		// 背景轮换游标 fs 路径取自此。指向 OS 临时目录下一个**不存在**的子目录(跨平台:
		// Windows/macOS/Linux 都解析为各自 tmp 根):load 读不到走 catch 返回 {};测试不触发
		// 轮换故游标不脏、dispose 不写盘(即便写,目标在 tmp 下也无害)。不含任何真实路径/密钥。
		dataRoot: opts?.dataDir ?? join(tmpdir(), "bn-pipeline-test-no-such-dir"),
		// 这批用例不碰自带字体;真实实现由 runtime 传进来,这里给个空实现即可。
		loadFontFace: async () => "",
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
		subscriptionStateStore: {
			get: () => undefined,
			getAll: () => ({}),
			patch: vi.fn(async () => {}),
			prune: vi.fn(async () => {}),
			load: vi.fn(async () => {}),
			...opts?.overrides?.subscriptionStateStore,
		} as any,
		bus,
		adapters: registryOf(opts?.platformAdapters ?? []),
		...(opts?.interceptSend ? { interceptSend: opts.interceptSend } : {}),
		imageFetcher: opts?.imageFetcher ?? {
			fetchImage: async () => fail("unavailable", "测试替身不联网"),
		},
		puppeteer: opts?.puppeteer ? ({} as any) : null,
		...(opts?.cardSkins ? { cardSkins: opts.cardSkins } : {}),
		...(opts?.extensionPlatformLabel
			? { extensionPlatformLabel: opts.extensionPlatformLabel }
			: {}),
		...(opts?.creatorStats ? { creatorStats: opts.creatorStats } : {}),
		...(opts?.extensionPostNoun ? { extensionPostNoun: opts.extensionPostNoun } : {}),
		...(opts?.resolveImageRef ? { resolveImageRef: opts.resolveImageRef } : {}),
		readImage: opts?.readImage ?? (async () => undefined),
		...(opts?.liveTable ? { liveTable: opts.liveTable } : {}),
	});
	// 登记即 start:`start` 与键的认领都在同一个同步段里发生(下面 await 的只是登记表的收尾)。
	const sourceLogger = makeLogger();
	const sourceRegistration = opts?.noSource
		? undefined
		: runtime.registerSource({
				sourceKey: opts?.sourceKey ?? "bilibili",
				source,
				// 来源上下文的 logger 是登记项带进来的(组装根造的),不取自集成上下文;集成上下文的其余格在这批用例里不被碰
				// (这里的 logger 故意是基础 logger,与登记项带的不同,「ctx.logger 来自哪」的用例才分得出)。
				integration: { logger: serviceCtx.logger } as any,
				logger: sourceLogger,
			});
	const sourceReady = sourceRegistration ?? Promise.resolve();
	// 没人 await 它就 dispose 的用例:关停后登记作废会让它 reject,这里挂一条旁支吞掉「未处理的 rejection」,
	// sourceReady 本身仍会 reject(await 它的用例照样看得到)。
	sourceReady.catch(() => {});
	const extraReady = (opts?.extraSources ?? []).map(({ sourceKey, source: extra }) =>
		runtime.registerSource({
			sourceKey,
			source: extra,
			integration: { logger: serviceCtx.logger } as any,
			logger: sourceLogger,
		}),
	);
	for (const ready of extraReady) ready.catch(() => {});
	lastSetup = {
		runtime,
		bus,
		serviceCtx,
		configStore,
		source,
		sourceReady,
		...(sourceRegistration ? { sourceRegistration } : {}),
		extraSource(sourceKey) {
			const found = opts?.extraSources?.find((entry) => entry.sourceKey === sourceKey)?.source.ctx;
			if (!found) throw new Error(`额外的来源 ${sourceKey} 还没 start`);
			return found;
		},
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

function patchGlobals(c: Ctx, mutate: (g: GlobalSettings) => void): void {
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

function aiGlobals(): GlobalSettings {
	const g = makeDefaultGlobalSettings();
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

/** 一条 B 站来的中立作品(来源翻好、图已抓好的样子)。 */
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
const TEMPLATE_GLOBALS = (template: string): GlobalSettings => {
	const g = makeDefaultGlobalSettings();
	g.defaults.templates.post = template;
	return g;
};

let active: Ctx | null = null;
beforeEach(() => {
	H.push.length = 0;
	H.ai.length = 0;
	H.image.length = 0;
	active = null;
});
afterEach(async () => {
	try {
		await active?.runtime.dispose();
	} catch {
		/* best-effort */
	}
});

describe("createPipelineRuntime — 卡上主播头像的读口接线(3a-35)", () => {
	// 作品这头:头像由核心出卡那一刻按订阅 id 现读(`deps.avatar`),动态轮询不再有头像读口。
	// 验红:把 pipeline.ts 里 postQueue 的 `avatar: profileAvatarOf` 去掉(或改成开机取一次),这条红。
	it("B 站作品:出卡器收到的 Post.creator.avatar 是出卡那一刻订阅资料里的头像,资料之后换了值,下一张卡用新的", async () => {
		let profile: { avatar?: string } = {};
		const get = vi.fn((_id: string) => ({ cachedProfile: profile }));
		const c = setup({
			puppeteer: true,
			subs: [biliSubOf("1")],
			overrides: { subscriptionStateStore: { get } },
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

/**
 * 出图连续失败「只提醒一次」的计数全进程一份(ADR-0019 决策 66):B 站动态与拓展作品用的是同一个
 * 渲染器,各记各的话同一次故障会各提醒主人一遍。计数在 createPipelineRuntime 里建一份,交给作品入口(两条路都经它装配)。
 * 哪条路换成自己建的一份,类型与别的测试全绿,只有这一条红。
 */
describe("createPipelineRuntime — 出图失败计数 B 站与拓展作品共用一份", () => {
	it("拓展作品出图失败提醒过之后,B 站作品同一串失败不再提醒;告警的来源是同一个 post-delivery,主人只收到一条私聊", async () => {
		const ext = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const c = setup({
			puppeteer: true,
			subs: [ext, biliSubOf("1")],
			extraSources: [{ sourceKey: "douyin", source: makeSource() }],
		});
		active = c;
		H.image[0].generatePostCard.mockRejectedValue(new Error("浏览器挂了"));

		c.extraSource("douyin").reportPost("sec-uid-1", {
			postId: "p1",
			url: "https://www.douyin.com/video/p1",
			post: {
				creator: { name: "作者" },
				publishedAt: new Date().toISOString(),
				text: "作品",
			},
		});
		await vi.waitFor(() => expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1));
		await settleTracked(c);
		reportBili("1");
		await settleTracked(c);
		expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(2);

		// 告诉主人的只有一路:pipeline-error 经 MasterNotifier 的那条(带 `[post-delivery]` 前缀)。作品投递不再
		// 自己直发一条。两条路共用一份计数、一个来源(60 秒节流键),第二次失败不会再补一条,面板上也只亮一次。
		const texts = H.push[0].notifyMaster.mock.calls.map((call: unknown[]) => String(call[0]));
		expect(texts).toHaveLength(1);
		expect(texts[0]).toMatch(/^\[post-delivery\] 生成作品图片失败：浏览器挂了/);
	});
});

/** 来源上下文交来的作品图已经是图库引用；推送链路要把引用、资料头像和 `resolveImageRef` 接到出图器。 */
describe("createPipelineRuntime — 拓展作品的图走图库", () => {
	const AVATAR_REF = `${"a".repeat(63)}1.png`;
	const IMAGE_REF = `${"c".repeat(64)}.png`;

	/** 出图器收到的 `Post`(第一个参数)。 */
	const postOf = (call: unknown[]) =>
		call[0] as { creator: { avatar?: string }; images?: unknown[] };

	it("来源交来的头像与配图引用原样到出图器", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const c = setup({
			puppeteer: true,
			subs: [sub],
			sourceKey: "douyin",
		});
		active = c;
		c.source.ctx?.reportPost("sec-uid-1", {
			postId: "p1",
			url: "https://www.douyin.com/video/p1",
			post: {
				publishedAt: new Date().toISOString(),
				creator: { name: "作者", avatar: IMAGE_REF },
				text: "有图的作品",
				images: [{ ref: IMAGE_REF }],
			},
		});
		await vi.waitFor(() => expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1));
		const post = postOf(H.image[0].generatePostCard.mock.calls[0] ?? []);
		expect(post.creator.avatar).toBe(IMAGE_REF);
		expect(post.images).toEqual([expect.objectContaining({ ref: IMAGE_REF })]);
	});

	it("事件没带头像:订阅资料里存的头像引用顶上", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const c = setup({
			puppeteer: true,
			subs: [sub],
			sourceKey: "douyin",
			overrides: {
				subscriptionStateStore: {
					get: (id: string) =>
						id === sub.id
							? {
									cachedProfile: {
										name: "资料名",
										avatar: AVATAR_REF,
										refreshedAt: "2026-10-05T00:00:00.000Z",
									},
								}
							: undefined,
				},
			},
		});
		active = c;
		c.source.ctx?.reportPost("sec-uid-1", {
			postId: "p1",
			url: "https://www.douyin.com/video/p1",
			post: {
				creator: { name: "作者" },
				publishedAt: new Date().toISOString(),
				text: "作品",
			},
		});
		await vi.waitFor(() => expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1));
		expect(postOf(H.image[0].generatePostCard.mock.calls[0] ?? []).creator.avatar).toBe(AVATAR_REF);
	});

	it("出图器拿到接线层给的 resolveImageRef", () => {
		const resolveImageRef = vi.fn(async () => undefined);
		const c = setup({ puppeteer: true, resolveImageRef });
		active = c;
		// 验红:删掉 pipeline.ts 里 `resolveImageRef: opts.resolveImageRef,` 那一行,这条红。
		expect(H.image[0].opts.resolveImageRef).toBe(resolveImageRef);
	});

	it("出图器拿到现取的全局时区:改了设置跟着变", () => {
		const c = setup({ puppeteer: true });
		active = c;
		// 验红:删掉 pipeline.ts 里 `timezone: () => globals().timezone,` 那一行,这条红。
		expect(H.image[0].opts.timezone()).toBe("Asia/Shanghai");
		patchGlobals(c, (g) => {
			g.timezone = "America/New_York";
		});
		expect(H.image[0].opts.timezone()).toBe("America/New_York");
	});

	// AI 点评看只有图库引用的图(拓展作品)时,核心要量字节数再编成 data URL,读口由接线层给(`runtime.imageStore.read`)。
	// 验红:把 pipeline.ts 里 postQueue 的 `readImage: opts.readImage,` 换成恒回 undefined,这条红(点评看不到图)。
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
			sourceKey: "douyin",
			readImage,
		});
		active = c;
		c.source.ctx?.reportPost("sec-uid-1", {
			postId: "p1",
			url: "https://www.douyin.com/video/p1",
			post: {
				creator: { name: "作者" },
				publishedAt: new Date().toISOString(),
				text: "有图的作品",
				images: [{ ref: `${"0".repeat(63)}1.png` }],
			},
		});
		await vi.waitFor(() => expect(H.ai[0].comment).toHaveBeenCalledTimes(1));
		expect(readImage).toHaveBeenCalledWith(`${"0".repeat(63)}1.png`);
		expect(H.ai[0].comment.mock.calls[0]?.[2]).toEqual([
			`data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
		]);
	});
});

/**
 * **作品入口的接线**:B 站动态轮询的 `reportPost` 选项由接线层给 —— 按身份查出订阅、把动态轮询交的作品包成信封
 * 入队(`createPostQueue`),入口再同步发 `post-detected`、按订阅串行跑装配、交给推送层。零件各自的单元测试证明不了
 * 接线真接上了,所以这里走**真的队列、真的装配**(只假推送层与出卡器),断言到 `PushRouter.push` 的入参;
 * 凡断言「没推」的先等登记进 track 的活落定,旁边有对照。
 */
describe("createPipelineRuntime — 作品入口接线(B 站动态轮询 → PostQueue → 推送层)", () => {
	it("动态轮询交的作品:按身份查订阅、入口同步发 post-detected(订阅 id、身份、叫法「动态」),随后推送层收到订阅 id + 特性 post + 模板文字与链接", async () => {
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

	// 「来源在跑」读口问的是来源登记表:拓展停了,等着的作品不补(决策 61);
	// B 站来源没登记(或撤了)也不推。
	// 验红:把 pipeline.ts 里 `sourceRunning` 改成恒真,这些用例都红。
	it("来源没在跑:拓展订阅与没登记的 B 站来源的作品都不推;对照:拓展在跑、B 站来源登了就推", async () => {
		const ext = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const c = setup({
			subs: [ext, biliSubOf("1")],
			extraSources: [{ sourceKey: "douyin", source: makeSource() }],
		});
		active = c;
		const extReport = () =>
			c.extraSource("douyin").reportPost("sec-uid-1", {
				postId: "p1",
				url: "https://www.douyin.com/video/p1",
				post: {
					creator: { name: "作者" },
					publishedAt: new Date().toISOString(),
					text: "作品",
				},
			});
		await c.sourceReady;
		const realGet = c.sources.get;
		c.sources.get = (key) => (key === "douyin" ? undefined : realGet(key));
		extReport();
		await settleTracked(c);
		expect(H.push[0].push).not.toHaveBeenCalled(); // 拓展没在跑
		c.sources.get = realGet;

		// B 站来源在登记表里:不看拓展在不在跑。
		reportBili("1");
		await settleTracked(c);
		expect(H.push[0].push).toHaveBeenCalledTimes(1);

		// 登记表里暂时认不出 B 站来源(用读口模拟「没登记」):同一条订阅的作品被丢。
		c.sources.get = (key) => (key === "bilibili" ? undefined : realGet(key));
		reportBili("1", bilibiliPost("没人认领"), "d2");
		await settleTracked(c);
		expect(H.push[0].push).toHaveBeenCalledTimes(1);
		c.sources.get = realGet;

		extReport();
		await settleTracked(c);
		expect(H.push[0].push).toHaveBeenCalledTimes(2);
	});

	// 来源描述符里的作品叫法随 `SourceContext.reportPost` 的信封交进作品入口,AI 提示词照它说。
	it("来源描述符里的作品叫法一路走到 AI 提示词:「发布了一条视频」", async () => {
		const ext = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const aiOn = aiGlobals();
		aiOn.ai.enabled = true;
		const c = setup({
			globals: aiOn,
			subs: [ext],
			sourceKey: "douyin",
			sourcePostNoun: "视频",
		});
		active = c;
		c.source.ctx?.reportPost("sec-uid-1", {
			postId: "p1",
			url: "https://www.douyin.com/video/p1",
			post: {
				publishedAt: new Date().toISOString(),
				text: "今天去海边",
				creator: { name: "甲" },
			},
		});
		await vi.waitFor(() => expect(H.ai[0].comment).toHaveBeenCalledTimes(1));
		expect(H.ai[0].comment.mock.calls[0]?.[0]).toBe("甲发布了一条视频，内容如下：\n今天去海边");
	});
});

/**
 * 作品过滤的接线(㉑e,ADR-0021 决策 43):过滤直接吃折好的 `ContentFilters`(配置怎么叫它就怎么叫,从前
 * `dynamicFilterOf` 那层翻译删了),B 站动态轮询与拓展作品**同一份过滤、类型开关对所有来源生效**。
 * 各自的单元测试证明不了 pipeline 真的把全局 / 按 UP 的过滤递到了两条路上:漏递的症状是该挡的作品照推。
 */
describe("createPipelineRuntime — 作品过滤接线", () => {
	const IMAGE_REF = `${"c".repeat(64)}.png`;
	const extReport = (_sub: { id: string }, value: Record<string, unknown>): PostReport => ({
		postId: "p1",
		url: "https://www.douyin.com/video/p1",
		post: {
			creator: { name: "作者" },
			publishedAt: new Date().toISOString(),
			text: "",
			...value,
		} as PostReport["post"],
	});
	const videoReport = (sub: { id: string }) =>
		extReport(sub, { text: "新视频", video: { title: "一期" }, images: undefined });
	const imagesReport = (sub: { id: string }) =>
		extReport(sub, { text: "返图", images: [{ ref: IMAGE_REF }] });
	const textReport = (sub: { id: string }) => extReport(sub, { text: "只有字" });

	function extSetup(over: { globals?: GlobalSettings; sub?: Subscription } = {}) {
		const sub =
			over.sub ?? makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const c = setup({
			puppeteer: true,
			subs: [sub],
			sourceKey: "douyin",
			...(over.globals ? { globals: over.globals } : {}),
		});
		active = c;
		return { c, sub };
	}
	const globalsWith = (filters: Partial<GlobalSettings["defaults"]["filters"]>): GlobalSettings => {
		const g = makeDefaultGlobalSettings();
		Object.assign(g.defaults.filters, filters);
		return g;
	};

	// 验红:把 pipeline.ts 里 `const handles: Disposable[] = [postQueue]` 的 postQueue 拿掉,这条红。
	it("dispose 关掉作品入口:关停之后拓展再交的作品不发 post-detected、不推;对照:关停之前交的照推", async () => {
		const { c, sub } = extSetup();
		const detected: PostEvent[] = [];
		c.bus.on("post-detected", (event) => detected.push(event));
		c.source.ctx?.reportPost("sec-uid-1", textReport(sub));
		await vi.waitFor(() => expect(H.push[0].push).toHaveBeenCalledTimes(1));

		await c.runtime.dispose();
		c.source.ctx?.reportPost("sec-uid-1", textReport(sub));
		await settleTracked(c);
		expect(detected).toHaveLength(1);
		expect(H.push[0].push).toHaveBeenCalledTimes(1);
	});

	// 验红:把 pipeline.ts 里 `filter: eff.filters` 换成空规则,这条红(B 站的作品也经同一份折叠)。
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
		// 验红:把来源上下文交给作品入口的 `filter: eff.filters` 换成空规则,这条红。
		c.source.ctx?.reportPost("sec-uid-1", videoReport(sub));
		c.source.ctx?.reportPost("sec-uid-1", textReport(sub));
		await vi.waitFor(() => expect(H.push[0].push).toHaveBeenCalledTimes(1));
		// 只有那条纯文字的出了卡、推了;视频那条被挡在过滤上。
		expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1);
		expect(H.image[0].generatePostCard.mock.calls[0]?.[0]).toMatchObject({ text: "只有字" });
	});

	it("拓展作品:全局开着「屏蔽图集」,带配图的作品被挡", async () => {
		const { c, sub } = extSetup({ globals: globalsWith({ blockImages: true }) });
		c.source.ctx?.reportPost("sec-uid-1", imagesReport(sub));
		c.source.ctx?.reportPost("sec-uid-1", textReport(sub));
		await vi.waitFor(() => expect(H.push[0].push).toHaveBeenCalledTimes(1));
		expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1);
		expect(H.image[0].generatePostCard.mock.calls[0]?.[0]).toMatchObject({ text: "只有字" });
	});

	it("拓展作品:类型开关都关着,视频与配图照推(出厂行为)", async () => {
		const { c, sub } = extSetup();
		c.source.ctx?.reportPost("sec-uid-1", videoReport(sub));
		c.source.ctx?.reportPost("sec-uid-1", imagesReport(sub));
		await vi.waitFor(() => expect(H.push[0].push).toHaveBeenCalledTimes(2));
	});

	it("拓展作品:这位 UP 的按 UP 覆盖盖过全局(全局拦视频,这位单独放开 → 照推)", async () => {
		const open = makeExtensionSubscription({
			extensionId: "douyin",
			externalId: "sec-uid-1",
			overrides: { filters: { blockVideos: false } },
		});
		const a = extSetup({ globals: globalsWith({ blockVideos: true }), sub: open });
		a.c.source.ctx?.reportPost("sec-uid-1", videoReport(a.sub));
		await vi.waitFor(() => expect(H.push[0].push).toHaveBeenCalledTimes(1));
	});

	it("拓展作品:按 UP 覆盖只拦这一位 —— 全局没开,这位单独开「屏蔽视频」就挡", async () => {
		const strict = makeExtensionSubscription({
			extensionId: "douyin",
			externalId: "sec-uid-1",
			overrides: { filters: { blockVideos: true } },
		});
		const { c, sub } = extSetup({ sub: strict });
		c.source.ctx?.reportPost("sec-uid-1", videoReport(sub));
		c.source.ctx?.reportPost("sec-uid-1", textReport(sub));
		await vi.waitFor(() => expect(H.push[0].push).toHaveBeenCalledTimes(1));
		expect(H.image[0].generatePostCard).toHaveBeenCalledTimes(1);
	});

	/**
	 * **被过滤的作品留痕的接线**(ADR-0021 决策 34 的 🔗)。两条路(B 站动态轮询、拓展作品)都经核心入口的 `recordFiltered`
	 * 都接到历史仓的 `record`:不经推送层,不走事件总线。
	 *
	 * 验红:把 pipeline.ts 里 postQueue 的 `recordFiltered: recordFilteredPost` 换成空函数 → B 站与拓展两条都红。
	 */
	describe("被过滤的作品留痕", () => {
		const BILI_SUB = "11111111-1111-4111-8111-111111111111";

		it("B 站动态轮询交来的作品被挡:uid 换成订阅,落一行:身份、名字快照、原因、摘要与链接;不经推送层,登记进 track", async () => {
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
					subscriptionStateStore: { get: () => ({ cachedProfile: { name: "某UP" } }) },
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
				sourceKey: "douyin",
				globals: globalsWith({ blockVideos: true }),
				overrides: { historyStore: { record } },
			});
			active = c;
			c.source.ctx?.reportPost("sec-uid-1", videoReport(sub));
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
 * 拓展订阅的直播接进推送链路(ADR-0019 决策 57 / 61):开播卡照 B 站的映射交给推送层(按订阅 id、特性 live)。
 * 周期「正在直播」不在这里 —— 推送这头没有自己的计时器(核心按每一场的开播时刻问来源,见「来源周期核对」)。
 * 剪掉注册那一口没往下传,这里会红。
 */
describe("createPipelineRuntime — 拓展直播接上推送", () => {
	it("开播 → 推送层收到按订阅 id 的开播", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const g = makeDefaultGlobalSettings();
		g.defaults.features.liveStreaming = true;
		g.defaults.liveStreaming.streamingIntervalHours = 1;
		const c = setup({
			globals: g,
			subs: [sub],
			sourceKey: "douyin",
			liveTable: memoryLiveTable(),
		});
		active = c;
		c.source.ctx?.reportLive("sec-uid-1", {
			kind: "start",
			startedAt: new Date().toISOString(),
			details: { url: "https://live.douyin.com/1" },
		});
		await vi.waitFor(() =>
			expect(H.push[0].push).toHaveBeenCalledWith(
				expect.objectContaining({ subscriptionId: sub.id, feature: "liveStart" }),
			),
		);
		// 真开播许 @全体:交出去的推送上没有 `allowAtAll: false`。
		expect(H.push[0].push.mock.calls[0]?.[0]).not.toHaveProperty("allowAtAll");
	});
});

/**
 * 来源交来的直播图已经是图库引用;卡输入里只放引用,订阅资料里的头像引用(`cachedProfile.avatar`)也要接到消费者。
 * 出图器收到的第一个参数就是中立的 `LiveCardInput`。
 */
describe("createPipelineRuntime — 拓展直播的图走图库", () => {
	const PROFILE_AVATAR = `${"a".repeat(64)}.png`;
	const COVER_REF = `${"c".repeat(64)}.png`;

	it("封面引用与订阅资料里的头像引用都到出图器", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const c = setup({
			puppeteer: true,
			subs: [sub],
			sourceKey: "douyin",
			liveTable: memoryLiveTable(),
			overrides: {
				subscriptionStateStore: {
					get: (id: string) =>
						id === sub.id
							? {
									cachedProfile: {
										name: "资料名",
										avatar: PROFILE_AVATAR,
										refreshedAt: "2026-10-05T00:00:00.000Z",
									},
								}
							: undefined,
				},
			},
		});
		active = c;
		c.source.ctx?.reportLive("sec-uid-1", {
			kind: "start",
			startedAt: new Date().toISOString(),
			details: { url: "https://live.douyin.com/1", cover: { ref: COVER_REF } },
		});
		await vi.waitFor(() => expect(H.image[0].generateLiveCard).toHaveBeenCalledTimes(1));
		const input = H.image[0].generateLiveCard.mock.calls[0]?.[0] as {
			creator: { name: string; avatar?: string };
			cover?: { ref?: string };
		};
		expect(input.cover).toEqual({ ref: COVER_REF });
		expect(input.creator).toEqual({ name: "资料名", avatar: PROFILE_AVATAR });
	});
});

describe("createPipelineRuntime — 来源周期核对", () => {
	const START = "2026-10-20T08:00:00.000Z";

	// 周期「正在直播」只由核心的计时驱动,推送这头不挂自己的:不管来源实现没实现 `fetchLiveStatus`,
	// live/core 上下文上都不该有一小时的 setInterval(验红:在 `bindLivePush` 里加回一个 `serviceCtx.setInterval(…, 小时)`,
	// 同时把 `serviceCtx` 的类型放回 `setInterval`,这条红)。
	it("推送这头不挂自己的周期计时器(周期归场次的计时)", async () => {
		const g = makeDefaultGlobalSettings();
		g.defaults.features.liveStreaming = true;
		g.defaults.liveStreaming.streamingIntervalHours = 1;
		const hourly = async (fetchLiveStatus?: Source["fetchLiveStatus"]): Promise<number[]> => {
			const sub = biliSubOf("42", "sub-42");
			const c = setup({
				globals: g,
				subs: [sub],
				liveTable: memoryLiveTable(),
				...(fetchLiveStatus ? { fetchLiveStatus } : {}),
			});
			active = c;
			await c.sourceReady;
			c.source.ctx?.reportLive("42", { kind: "start", startedAt: START, details: { title: "t" } });
			const intervals = (subsystemCtx(c, "live", "core").setInterval.mock.calls ??
				[]) as unknown as [() => void, number][];
			return intervals.map(([, ms]) => ms).filter((ms) => ms === 60 * 60 * 1000);
		};
		expect(await hourly(async () => ({ ok: false, code: "x", message: "x" }))).toEqual([]);
		await active?.runtime.dispose();
		expect(await hourly()).toEqual([]);
	});
});

/**
 * 直播那块搬进工厂前的接线刻画:每一条都从 `createPipelineRuntime` 交出的公开成员、来源上下文或
 * 总线事件观察,断了就由这里变红。
 */
describe("createPipelineRuntime — 直播接线刻画", () => {
	const START = "2026-10-25T08:00:00.000Z";

	it("globals 改 wordcloudStopWords:在播收集器从下一句起使用新停用词", async () => {
		const sub = biliSubOf("57", "sub-57");
		const c = setup({
			subs: [sub],
			liveTable: memoryLiveTable(),
		});
		active = c;
		await c.sourceReady;
		c.source.ctx?.reportLive("57", { kind: "start", startedAt: START, details: {} });

		patchGlobals(c, (g) => {
			g.defaults.templates.wordcloudStopWords = "刷屏";
		});
		c.bus.emit("config-changed", { scope: "globals" });
		c.source.ctx?.reportLiveInteraction("57", {
			kind: "viewerChat",
			viewer: { id: "viewer-1", name: "甲" },
			text: "刷屏主播",
		});

		expect(c.runtime.viewerChatStats()).toEqual({ subscriptions: 1, words: 1, senders: 1 });
	});

	it("viewerChatStats():给了在播表时报收集器规模,没给时报零", async () => {
		const withoutLive = setup();
		expect(withoutLive.runtime.viewerChatStats()).toEqual({
			subscriptions: 0,
			words: 0,
			senders: 0,
		});
		await withoutLive.runtime.dispose();

		const sub = biliSubOf("57", "sub-57");
		const c = setup({
			subs: [sub],
			liveTable: memoryLiveTable(),
		});
		active = c;
		await c.sourceReady;
		c.source.ctx?.reportLive("57", { kind: "start", startedAt: START, details: {} });
		c.source.ctx?.reportLiveInteraction("57", {
			kind: "viewerChat",
			viewer: { id: "viewer-1", name: "甲" },
			text: "主播好厉害",
		});
		expect(c.runtime.viewerChatStats()).toEqual({ subscriptions: 1, words: 2, senders: 1 });
	});

	it("tickLiveSessionNow():把这条订阅当前的场次核对转给场次引擎", async () => {
		const sub = biliSubOf("57", "sub-57");
		sub.enabled = false;
		const fetchLiveStatus = vi.fn(async () => ({
			ok: true as const,
			kind: "live" as const,
			details: { title: "刚才那场" },
		}));
		const c = setup({
			subs: [sub],
			liveTable: memoryLiveTable(),
			fetchLiveStatus,
		});
		active = c;
		await c.sourceReady;
		sub.enabled = true;
		c.source.ctx?.reportLive("57", { kind: "start", startedAt: START, details: {} });

		await expect(c.runtime.tickLiveSessionNow(sub.id)).resolves.toBe(true);
		expect(fetchLiveStatus).toHaveBeenCalledTimes(1);
	});

	it("没给在播表:来源报直播信号和互动各记一条 error 后丢弃,不抛", async () => {
		const sub = biliSubOf("57", "sub-57");
		const c = setup({ subs: [sub] });
		active = c;
		await c.sourceReady;
		const changes: unknown[] = [];
		c.bus.on("live-session-changed", (change) => changes.push(change));
		const errors = subsystemCtx(c, "live", "core").logger.error;
		errors.mockClear();

		expect(() => {
			c.source.ctx?.reportLive("57", { kind: "start", startedAt: START, details: {} });
		}).not.toThrow();
		expect(() => {
			c.source.ctx?.reportLiveInteraction("57", {
				kind: "viewerChat",
				viewer: { id: "viewer-1", name: "甲" },
				text: "主播好厉害",
			});
		}).not.toThrow();

		expect(changes).toEqual([]);
		expect(errors).toHaveBeenCalledTimes(2);
		expect(errors.mock.calls).toEqual([
			[
				"未装配场次引擎，丢弃本次直播信号",
				{
					event: "pipeline.live_signal_dropped",
					identity: { sourceKey: "bilibili", externalId: "57" },
					kind: "start",
				},
			],
			[
				"未装配直播互动入口，丢弃本次互动",
				{
					event: "pipeline.live_interaction_dropped",
					subscriptionId: "sub-57",
					kind: "viewerChat",
				},
			],
		]);
	});
});

// 「直播就绪」:至少一个启用的 B 站订阅 `needsLiveMonitor` 为真(ADR-0027 决策 1:只看折好的开关与特别关注,
// 不看有没有推送目标)。判定本身只此一份,住 internal;这里钉的是 getModuleState 用的是它。
describe("createPipelineRuntime — getModuleState.live", () => {
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
	const setupLive = (opts: Parameters<typeof setup>[0] = {}) =>
		setup({
			...opts,
			fetchLiveStatus: async () => ({ ok: true, kind: "offline" }),
		});

	it("直播类开关开着(出厂就开)、一个推送目标都没配 → 就绪", () => {
		const c = setupLive({ subs: [liveSub({})] });
		active = c;
		expect(c.runtime.getModuleState().live).toBe(true);
	});

	it("直播类开关全关、哪怕路由里留着目标 → 不就绪", () => {
		const c = setupLive({
			subs: [liveSub({ features: LIVE_OFF, routing: { liveStart: [TARGET] } })],
		});
		active = c;
		expect(c.runtime.getModuleState().live).toBe(false);
	});

	// 特别关注那两支是「开关 ∧ 名单上有人带它」(3b-16):只有名单、特别开关关着 → 不就绪。
	it.each(["viewerChat", "viewerEnter"] as const)(
		"主开关全关、名单上有人带 %s、但这把特别开关关着 → 不就绪",
		(kind) => {
			const c = setupLive({
				subs: [liveSub({ features: LIVE_OFF, specialViewers: [{ id: "2", features: [kind] }] })],
			});
			active = c;
			expect(c.runtime.getModuleState().live).toBe(false);
		},
	);

	it.each(["viewerChat", "viewerEnter"] as const)(
		"主开关全关、%s 开着、名单上有人带它(没有目标)→ 就绪",
		(kind) => {
			const c = setupLive({
				subs: [
					liveSub({
						features: { ...LIVE_OFF, [kind]: true },
						specialViewers: [{ id: "2", features: [kind] }],
					}),
				],
			});
			active = c;
			expect(c.runtime.getModuleState().live).toBe(true);
		},
	);

	it("viewerChat 开着、名单上的人只带 viewerEnter → 不就绪", () => {
		const c = setupLive({
			subs: [
				liveSub({
					features: { ...LIVE_OFF, viewerChat: true },
					specialViewers: [{ id: "2", features: ["viewerEnter"] }],
				}),
			],
		});
		active = c;
		expect(c.runtime.getModuleState().live).toBe(false);
	});

	it.each(["liveStart", "liveStreaming", "liveEnd", "membership", "superchat"] as const)(
		"只开 %s 一把 → 就绪",
		(key) => {
			const c = setupLive({ subs: [liveSub({ features: { ...LIVE_OFF, [key]: true } })] });
			active = c;
			expect(c.runtime.getModuleState().live).toBe(true);
		},
	);

	it("停用的订阅不数", () => {
		const c = setupLive({ subs: [liveSub({ enabled: false })] });
		active = c;
		expect(c.runtime.getModuleState().live).toBe(false);
	});

	// 声明了周期直播的拓展登记时就核过要交 `fetchLiveStatus`,所以「有直播」与今天的口径一致:来源实现了拉取式。
	it("只订了实现了 fetchLiveStatus 的拓展来源 → 就绪", () => {
		const c = setupLive({
			sourceKey: "douyin",
			subs: [makeExtensionSubscription()],
		});
		active = c;
		expect(c.runtime.getModuleState().live).toBe(true);
	});

	it("来源没实现直播 → 不就绪", () => {
		const c = setup({ subs: [liveSub({})] });
		active = c;
		expect(c.runtime.getModuleState().live).toBe(false);
	});
});

describe("createPipelineRuntime — boot wiring", () => {
	it("createPipelineRuntime 自己不起任何来源:不调 registerSource,来源的 start 一次都没被叫", () => {
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

	// 来源读自己集成的设置:读法住集成上下文(`integrations/settings-reader.ts` 的 `settingsReaderOptionsOf`),
	// 不再由推送链路装配递 —— 那条线的单测在 `integrations/__tests__/settings-reader.test.ts`,从真入口的接线钉在
	// `__tests__/builtin-source-settings-boot-e2e.test.ts`。

	// 验红:删掉 pipeline.ts `registerSource` 里递 `problems` 的那一行,这条红。
	it("来源上下文的 reportProblem 写进递进去的问题表,报的人是来源键", async () => {
		const c = setup();
		active = c;
		await c.sourceReady;
		c.source.ctx?.reportProblem({ code: "auth_lost", message: "登录失效" });
		expect(c.problems.list().map((p) => [p.reporter, p.code])).toEqual([["bilibili", "auth_lost"]]);
	});

	// 验红:删掉 builtin-sources.ts 撤登记里的 `clearReporter`,这条红。
	it("关停推送链路撤掉来源登记:它报的问题跟着清空(不补「已恢复」)", async () => {
		const c = setup();
		active = c;
		await c.sourceReady;
		c.source.ctx?.reportProblem({ code: "auth_lost", message: "登录失效", notify: true });
		expect(H.push[0].notifyMaster).toHaveBeenCalledTimes(1);
		await c.runtime.dispose();
		active = null;
		expect(c.problems.list()).toEqual([]);
		expect(H.push[0].notifyMaster).toHaveBeenCalledTimes(1);
	});

	// 验红:删掉 pipeline.ts 里 `createProblemNotifier` 那一段,这条红。
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

	// 验红:删掉 pipeline.ts 里听 `subscription-changed` 清 `clearSubscription` 的那段,这条红。
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

	// 验红:去掉 pipeline.ts `registerSource` 里 `onAuthChanged: …`(或 builtin-sources.ts 里的订阅),这条红。
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

		await c.runtime.dispose();
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

	// 验红:去掉 pipeline.ts `registerSource` 里 await 之后的 `if (disposed)` 那段,这条红(来源 stop 没被叫、也没抛)。
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
		await c.runtime.dispose();
		gate.resolve();
		expect(await outcome).toContain("disposed");
		expect(slow.stop).toHaveBeenCalledTimes(1);
	});

	// 验红:让 pipeline.ts `registerSource` 的返回值不撤登记(回一个空把手),这条红(登记表里的来源还在、stop 没被叫)。
	it("registerSource 交回撤登记的把手:撤一次来源 stop 一次、登记表里没了;再撤与推送链路关停都是空操作", async () => {
		const c = setup({ noSource: true });
		active = c;
		const extra = makeSource();
		const registration = await c.runtime.registerSource({
			sourceKey: "douyin",
			source: extra,
			integration: { logger: c.serviceCtx.logger } as any,
			logger: c.sourceLogger,
		});
		expect(c.sources.get("douyin")).toBeDefined();
		registration.dispose();
		registration.dispose();
		expect(extra.stop).toHaveBeenCalledTimes(1);
		expect(c.sources.get("douyin")).toBeUndefined();
		await c.runtime.dispose();
		expect(extra.stop).toHaveBeenCalledTimes(1);
	});

	// 验红:让 pipeline.ts 的 `searchCreators` 另建一道 `createSourceGates()`(不用共用的 `sourceGates`),这条红
	// (取资料在搜人还没落定时就被调了)。
	it("searchCreators 与 fetchProfile 对同一来源排同一道闸:第二个要等第一个落定", async () => {
		const c = setup({ noSource: true });
		active = c;
		const gate = deferred();
		const source = makeSource();
		source.searchCreators = vi.fn(async () => {
			await gate.promise;
			return { ok: true as const, candidates: [] };
		});
		source.fetchProfile = vi.fn(async () => ({ ok: true as const, name: "某人" }));
		await c.runtime.registerSource({
			sourceKey: "douyin",
			source,
			integration: { logger: c.serviceCtx.logger } as any,
			logger: c.sourceLogger,
		});
		const searching = c.runtime.searchCreators("douyin", "q");
		const fetching = c.runtime.fetchProfile({ sourceKey: "douyin", externalId: "x" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(source.searchCreators).toHaveBeenCalledTimes(1);
		expect(source.fetchProfile).not.toHaveBeenCalled();
		gate.resolve();
		await searching;
		await fetching;
		expect(source.fetchProfile).toHaveBeenCalledTimes(1);
	});

	// 验红:让登记项里的 `rejectedProblemLevel` 到不了 `createSourceContext`(例如 `registerBuiltinSource` 不再把它递下去),这条红(被拒的问题上报记成 error)。
	it("registerSource 的登记项带 rejectedProblemLevel: warn:来源报了形状不对的问题,记 warn 不记 error", async () => {
		const c = setup({ noSource: true });
		active = c;
		const extra = makeSource();
		await c.runtime.registerSource({
			sourceKey: "douyin",
			source: extra,
			integration: { logger: c.serviceCtx.logger } as any,
			logger: c.sourceLogger,
			rejectedProblemLevel: "warn",
		});
		extra.ctx?.reportProblem({ code: "Bad Code", message: "x" });
		expect(c.sourceLogger.warn).toHaveBeenCalledTimes(1);
		expect(c.sourceLogger.error).not.toHaveBeenCalled();
	});

	it("fallbackCreatorName:订阅资料里有名字用它,没有退身份标签(平台名 · 外部 id)", () => {
		const sub = makeExtensionSubscription({
			id: "e0000000-0000-4000-8000-0000000000aa",
			extensionId: "douyin",
			externalId: "sec-uid-1",
		});
		const named = setup({
			subs: [sub],
			overrides: {
				subscriptionStateStore: {
					get: (id: string) =>
						id === sub.id ? { cachedProfile: { name: "资料里的名字" } } : undefined,
				},
			},
		});
		active = named;
		expect(
			named.runtime.fallbackCreatorName({ sourceKey: "douyin", externalId: "sec-uid-1" }),
		).toBe("资料里的名字");
		const unnamed = setup({
			subs: [sub],
			extensionPlatformLabel: (id) => (id === "douyin" ? "抖音" : undefined),
		});
		active = unnamed;
		expect(
			unnamed.runtime.fallbackCreatorName({ sourceKey: "douyin", externalId: "sec-uid-1" }),
		).toBe("抖音 · sec-uid-1");
		// 订阅都不在了(刚删):只剩身份标签。
		expect(unnamed.runtime.fallbackCreatorName({ sourceKey: "douyin", externalId: "gone" })).toBe(
			"抖音 · gone",
		);
	});

	it("apiKey+baseUrl 齐备:启动即构造 CommentaryGenerator 并 start", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		expect(H.ai).toHaveLength(1);
		expect(H.ai[0].start).toHaveBeenCalledTimes(1);
	});

	it("提示词叫法接拓展清单的平台名与作品叫法,并暴露同一个现读取口", () => {
		const c = setup({
			globals: aiGlobals(),
			extensionPlatformLabel: (id) => (id === "douyin" ? "抖音" : undefined),
			extensionPostNoun: (id) => (id === "douyin" ? "视频" : undefined),
		});
		active = c;
		expect(c.runtime.extensionPostNoun("douyin")).toBe("视频");
		expect(H.ai[0].opts.nouns(["douyin"])).toEqual({
			creatorNoun: "创作者",
			postNoun: "视频",
			sources: "抖音",
		});
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
		expect(H.ai[0].setProvidedTools).toHaveBeenCalledTimes(1);
		// 只读如今是结构性的(工具表里就没有写工具),由 packages/ai 那道闸盯着;
		// 这里只钉「pipeline 确实接了」,免得那行接线被顺手删掉还全绿。
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
		// 验红:把 pipeline.ts 里 attachReadOnlyTools 的 `platformLabel: …` 改成只问 extensionPlatformLabel,这条红。
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
		// 验红:把 pipeline.ts 里 attachReadOnlyTools 的 `platformLabel: …` 里的拓展装载器那一支去掉,平台名退成拓展 id。
		expect(H.ai[0].setCreatorReader.mock.calls[0][0].subscriptions()[0]?.platform).toBe("抖音");
	});

	it("只读工具那份视图里,拓展订阅的在播接的是在播表(ADR-0019 决策 64 的 🔗)", async () => {
		const ext = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-1" });
		const aiLiveTable = memoryLiveTable();
		aiLiveTable.replace(ext.id, "douyin", undefined, { title: "在播" });
		const c = setup({
			globals: aiGlobals(),
			subs: [ext],
			liveTable: aiLiveTable,
			sourceKey: "douyin",
		});
		active = c;
		await c.sourceReady;
		expect(H.ai[0].setCreatorReader.mock.calls[0][0].subscriptions()[0]?.liveNow).toEqual({
			state: "live",
			title: "在播",
		});
	});

	it("只读工具那份视图里,B 站订阅的在播也接在播表", () => {
		const sub = makeEmptySubscription({
			id: "bili-1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		const aiLiveTable = memoryLiveTable();
		aiLiveTable.replace(sub.id, "bilibili", undefined, { title: "在播" });
		const c = setup({
			globals: aiGlobals(),
			subs: [sub],
			liveTable: aiLiveTable,
		});
		active = c;
		expect(H.ai[0].setCreatorReader.mock.calls[0][0].subscriptions()[0]?.liveNow).toEqual({
			state: "live",
			title: "在播",
		});
	});

	it("只读工具的读口:作品与统计接的是接线层给的统计读口(creatorStats),订阅 id 原样递下去", async () => {
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		const recentPosts = vi.fn(async () => [
			{ publishedAt: "2026-10-01T00:00:00.000Z", title: "t" },
		]);
		const c = setup({
			globals: aiGlobals(),
			subs: [sub],
			creatorStats: { isEnabled: () => true, recentPosts, statsRow: async () => undefined },
		});
		active = c;
		const reader = H.ai[0].setCreatorReader.mock.calls[0][0];
		// 验红:把 pipeline.ts 里 attachReadOnlyTools 的 `stats: opts.creatorStats` 那一行删掉,这条红(回 unavailable)。
		expect(await reader.recentPosts("bilibili:1", 5)).toEqual({
			ok: true,
			posts: [{ publishedAt: "2026-10-01T00:00:00.000Z", title: "t" }],
		});
		expect(recentPosts).toHaveBeenCalledWith("s1", 5);
	});

	it("puppeteer 在位:构造 ImageRenderer", () => {
		const c = setup({ puppeteer: true });
		active = c;
		expect(H.image).toHaveLength(1);
	});

	// 「接线要有自己的守卫」:三口各自都有测试,证明不了 pipeline 真的把它们接上了 ——
	// 漏接的症状是静默的(出图永远用内置默认皮肤,类型 / 测试 / 构建全绿)。
	it("卡片皮肤那三口原样接到 ImageRenderer 上", () => {
		const get = vi.fn(() => undefined);
		const asset = vi.fn(async () => undefined);
		const onFallback = vi.fn();
		const c = setup({ puppeteer: true, cardSkins: { get, asset, onFallback } });
		active = c;
		const o = H.image[0].opts;
		// 验红:把 pipeline.ts 里那三行 `resolveCardSkin: opts.cardSkins?.get` 删掉,这三条红。
		expect(o.resolveCardSkin).toBe(get);
		expect(o.resolveCardSkinAsset).toBe(asset);
		expect(o.onCardSkinFallback).toBe(onFallback);
	});
});

describe("createPipelineRuntime — enableImageRendering 运行时热启用", () => {
	it("幂等:启动即 puppeteer 在位,再调 → 返回 false 且不重复构造", () => {
		const c = setup({ puppeteer: true });
		active = c;
		expect(H.image).toHaveLength(1); // 启动已构造
		const enabled = c.runtime.enableImageRendering({} as any);
		expect(enabled).toBe(false);
		expect(H.image).toHaveLength(1); // 没重复构造浏览器
	});

	// 渲染器会被热换,核心装配只能经 `deps.image()` 这个读外层 let 的闭包拿它 —— 按值传就是
	// 「开机时没有浏览器,之后一直没有卡片」而门禁全绿。走真的队列与真的装配,断言到出卡器与推送层。
	// 验红:把 pipeline.ts 里 postQueue 的 `image: () => imageRenderer ?? undefined` 改成按值传
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

describe("createPipelineRuntime — config-changed globals 热重载", () => {
	// cron 本身要生效(动态轮询换节奏)在 `bilibili/__tests__/source.test.ts`。

	// 作品设置每条现折:改全局图集开关,下一条作品就按新的,不经推送链路的热更门(此前 imageGroup 整个漏在门外)。
	it("改 defaults.imageGroup:不经推送链路热更,下一条带图的作品立即多一个图集的附加项锚点", async () => {
		const closed = makeDefaultGlobalSettings();
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

	// 日志等级不再由推送链路装配推:各子上下文只交(标签,键),等级表由入口的 `bindLogLevels` 整张推
	// (推的行为在 `log-levels.test.ts` 与 `service-context.test.ts`,接线在 `log-levels-boot-e2e`)。
	// 一行日志是谁的代码打的就跟谁那一格:这里钉「键」接对了没有 —— 接反了门禁全绿,只有调等级时才露馅。
	it("子上下文的(标签,键):作品队列与拓展直播跟 core,AI、出图各跟自己的", () => {
		const c = setup();
		active = c;
		const booted = (c.serviceCtx.forSubsystem.mock.calls as unknown as [string, string][]).map(
			([name, key]) => `${name}/${key}`,
		);
		expect(booted.sort()).toEqual(["ai/ai", "image/image", "live/core", "posts/core"]);
	});

	const extensionPostReport = (video: boolean): PostReport => ({
		postId: "p1",
		url: "https://www.douyin.com/video/p1",
		post: {
			creator: { name: "作者" },
			publishedAt: new Date().toISOString(),
			text: "新视频",
			...(video ? { video: { cover: {}, title: "一期", description: "" } } : {}),
		},
	});

	// 验红:把 pipeline.ts 里 `createPostQueue` 的顶层 `logger: postsCtx.logger` 换成 `liveCtx.logger`,这条红。
	it("作品队列自己记的日志走 posts/core 那一个(订阅停用 → 不收)", async () => {
		const sub = makeExtensionSubscription({
			extensionId: "douyin",
			externalId: "sec-uid-1",
			enabled: false,
		});
		const c = setup({
			puppeteer: true,
			subs: [sub],
			sourceKey: "douyin",
		});
		active = c;
		c.source.ctx?.reportPost("sec-uid-1", extensionPostReport(false));
		await settleTracked(c);
		expect(subsystemCtx(c, "posts", "core").logger.debug).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				event: "post.queue_skipped",
				subscriptionId: sub.id,
				postId: "p1",
			}),
		);
		expect(subsystemCtx(c, "live", "core").logger.debug).not.toHaveBeenCalled();
	});

	// 验红:把 pipeline.ts 里 `createPostQueue` 的 `deps.logger: postsCtx.logger` 换成 `liveCtx.logger`,这条红。
	it("作品装配(deliverPost)记的日志走 posts/core 那一个(被过滤)", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const g = makeDefaultGlobalSettings();
		g.defaults.filters.blockVideos = true;
		const c = setup({
			puppeteer: true,
			subs: [sub],
			globals: g,
			sourceKey: "douyin",
			sourcePostNoun: "作品",
		});
		active = c;
		c.source.ctx?.reportPost("sec-uid-1", extensionPostReport(true));
		await settleTracked(c);
		expect(subsystemCtx(c, "posts", "core").logger.debug).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				event: "post.filtered",
				subscriptionId: sub.id,
				postId: "p1",
				reason: "blocked-videos",
			}),
		);
		expect(subsystemCtx(c, "live", "core").logger.debug).not.toHaveBeenCalled();
	});

	// 验红:把 pipeline.ts 里 `bindLivePush` 的 `logger: coreLiveCtx.logger` 换成 `liveCtx.logger`,这条红。
	it("拓展直播推送记的日志走 live/core 那一个(BN 起来后收到的状态是在播,接上这一场)", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const c = setup({
			subs: [sub],
			sourceKey: "douyin",
			liveTable: memoryLiveTable(),
		});
		active = c;
		await c.sourceReady;
		c.source.ctx?.reportLive("sec-uid-1", {
			kind: "status",
			isLive: true,
			details: { url: "https://live.douyin.com/1" },
		});
		await settleTracked(c);
		expect(subsystemCtx(c, "live", "core").logger.debug).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ event: "live.push_attached", subscriptionId: sub.id }),
		);
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

	it("改全局 templates.post/postVideo → 不经推送链路热更,下一条作品就用新模板(无 per-UP 覆盖的订阅不再用旧模板)", async () => {
		// 回归:从前推送链路快照里留着模板,触发条件漏了 templatesChanged 就一直用旧的;现在每条作品现折。
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

	it("item 4 — 改 ai 不扇出重设 level / healthCheck", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		patchGlobals(c, (g) => {
			g.ai.activePreset = "tsundere";
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
			g.ai.activePreset = "tsundere";
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(H.ai[0].updateConfig).toHaveBeenCalledTimes(1);
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
});

describe("createPipelineRuntime — AI 热重载三态", () => {
	// AI 实例会被热换,核心装配只能经 `deps.ai()` 这个读外层 let 的闭包拿它。
	// 验红:把 pipeline.ts 里 postQueue 的 `ai: () => commentary ?? undefined` 改成按值传(开机取一次),这条红。
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

	// 内置人格的内容跟着语言走(ADR-0037 决策 11):只换语言、ai 一格没动,常驻生成器也要换成新语言的人格。
	// 验红:把 `aiChanged` 里「语言变了」那一条去掉,这条红。
	it("只换语言(ai 没动):updateConfig 一次,拿到的是新语言的内置人格", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		expect(H.ai[0].opts.config.persona.name).toBe("小绫");
		patchGlobals(c, (g) => {
			g.locale = "en";
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(H.ai[0].updateConfig).toHaveBeenCalledTimes(1);
		expect(H.ai[0].updateConfig.mock.calls[0]?.[0].persona.name).toBe("Ling");
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

describe("createPipelineRuntime — image 配色热更", () => {
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

describe("createPipelineRuntime — dispose", () => {
	it("关停先撤来源登记再收场次:在播行出去,来源上下文随登记停掉", async () => {
		const sub = makeExtensionSubscription({ extensionId: "douyin", externalId: "sec-uid-1" });
		const liveTable = memoryLiveTable();
		const c = setup({
			subs: [sub],
			sourceKey: "douyin",
			liveTable,
		});
		active = c;
		await c.sourceReady;
		c.source.ctx?.reportLive("sec-uid-1", {
			kind: "status",
			isLive: true,
			details: { url: "https://live.douyin.com/1", currentViewers: 2000 },
		});
		expect(liveTable.get(sub.id)).toMatchObject({
			subscriptionId: sub.id,
			details: { currentViewers: 2000 },
		});
		await c.runtime.dispose();
		expect(liveTable.get(sub.id)).toBeUndefined();
		expect(c.source.stops).toBe(1);
	});

	// 验红:去掉 pipeline.ts `dispose` 里等在途收尾的那一行(`await Promise.all(sourceClosings)`),这条红(stop 没落定推送层就停了)。
	it("关停等来源的 stop 落定再关作品入口:stop 途中来源的上下文仍开着,落定之后才停推送、清问题", async () => {
		const c = setup();
		active = c;
		await c.sourceReady;
		const gate = deferred();
		c.source.stop = vi.fn(() => gate.promise);
		let settled = false;
		const closing = c.runtime.dispose().then(() => {
			settled = true;
		});
		try {
			expect(c.source.stop).toHaveBeenCalledTimes(1);
			// stop 在路上:来源报的问题照收、推送层还没停。
			c.source.ctx?.reportProblem({ code: "mid_stop", message: "停途中" });
			expect(c.problems.list().map((p) => p.code)).toEqual(["mid_stop"]);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(settled).toBe(false);
			expect(H.push[0].stop).not.toHaveBeenCalled();
		} finally {
			gate.resolve();
		}
		await closing;
		expect(H.push[0].stop).toHaveBeenCalledTimes(1);
		expect(c.problems.list()).toEqual([]);
		c.source.ctx?.reportProblem({ code: "late", message: "落定之后" });
		expect(c.problems.list()).toEqual([]);
	});

	it("拓展先撤了登记、stop 还没落定时关停,也等它落定", async () => {
		const c = setup({ noSource: true });
		active = c;
		const extra = makeSource();
		const gate = deferred();
		extra.stop = vi.fn(() => gate.promise);
		const registration = await c.runtime.registerSource({
			sourceKey: "douyin",
			source: extra,
			integration: { logger: c.serviceCtx.logger } as any,
			logger: c.sourceLogger,
		});
		// 装载器收摊:自己先撤,把手同步返回,stop 还在路上。
		registration.dispose();
		expect(extra.stop).toHaveBeenCalledTimes(1);
		let settled = false;
		const closing = c.runtime.dispose().then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		gate.resolve();
		await closing;
		expect(settled).toBe(true);
		expect(extra.stop).toHaveBeenCalledTimes(1);
	});

	it("dispose 之后再让来源交一条:作品入口没收到,记了那行 error", async () => {
		const c = setup({ subs: [biliSubOf("1")] });
		active = c;
		await c.sourceReady;
		const detected: PostEvent[] = [];
		c.bus.on("post-detected", (event) => detected.push(event));
		await c.runtime.dispose();
		const errors = c.sourceLogger.error as ReturnType<typeof vi.fn>;
		errors.mockClear();
		reportBili("1", bilibiliPost("关停后"), "after");
		await settleTracked(c);
		expect(detected).toEqual([]);
		expect(errors).toHaveBeenCalledTimes(1);
	});
});

/**
 * 背景轮换游标:每次推送在推送点同步推进,只标脏;落盘由 30 秒的定时器与 dispose 那一次负责。
 * 走存储层的原子写 —— 写到一半被杀,盘上是旧的整份或新的整份,游标不会被半截 JSON 清零。
 */
describe("createPipelineRuntime — 背景轮换游标落盘", () => {
	const ids = ["a", "b", "c"].map((ch) => `${ch.repeat(32)}.png`);
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-pipeline-cursors-"));
		await mkdir(dataPath(dataDir, ...CARD_BG_DIR), { recursive: true });
		for (const id of ids) await writeFile(dataPath(dataDir, ...CARD_BG_DIR, id), "x");
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("没推进过就不写盘(游标不脏)", async () => {
		const c = setup({ dataDir });
		active = c;
		await c.runtime.dispose();
		active = null;
		await expect(readdir(dataDir)).resolves.toEqual(["library"]);
	});

	it("推进过就在 dispose 时落盘", async () => {
		const sub = biliSubOf("57", "sub-57");
		const g = makeDefaultGlobalSettings();
		g.defaults.cards.liveCoverImageIds = ids.slice(0, 2);
		const c = setup({
			dataDir,
			globals: g,
			subs: [sub],
			liveTable: memoryLiveTable(),
		});
		active = c;
		await c.sourceReady;
		c.source.ctx?.reportLive("57", {
			kind: "start",
			startedAt: "2026-10-25T08:00:00.000Z",
			details: { url: "https://live.bilibili.com/57" },
		});
		await vi.waitFor(() => expect(H.push[0].push).toHaveBeenCalledTimes(1));
		await settleTracked(c);

		await c.runtime.dispose();
		active = null;
		const persisted: unknown = JSON.parse(
			await readFile(dataPath(dataDir, ...CARD_BG_CURSORS_FILE), "utf8"),
		);
		expect(persisted).toEqual({ "bilibili:57:live-cover": 1 });
	});
});

// 回归:禁用一个 UP 时,live 必须同步停推。
// 此前 subscriptionOpsToLive 的 update 分支不看 sub.enabled,把禁用翻译成带
// live:true 的 update op,LiveEngine(常驻 WS、事件驱动)listener 一直挂着照推。
// 修复:op 翻译层显式 gate enabled。动态那一半:名单只列启用中的订阅
// (`subscriptions/__tests__/source-subscriptions.test.ts`)与动态轮询的 `syncSubscriptions`
// (`bilibili/dynamic/__tests__/dynamic-poller.test.ts`)。
describe("createPipelineRuntime — 订阅禁用/启用转译", () => {
	function makeSub(uid: string, enabled: boolean): Subscription {
		const s = makeEmptySubscription({
			id: `sub-${uid}`,
			identity: { sourceKey: "bilibili", externalId: uid },
		});
		s.enabled = enabled;
		return s;
	}

	it("禁用订阅 add:来源的名单不列它(停用的不进名单)", async () => {
		const sub = makeSub("700", false);
		const c = setup({ subs: [sub] });
		active = c;
		await c.sourceReady;
		c.bus.emit("subscription-changed", { ops: [{ kind: "add", sub }] });

		expect(c.source.ctx?.subscriptions()).toEqual([]);
	});
});

describe("createPipelineRuntime — 默认 globals", () => {
	it("默认 globals:push 拉起,AI 与 image 不构造", () => {
		const c = setup();
		active = c;
		expect(H.push).toHaveLength(1);
		expect(H.ai).toHaveLength(0);
		expect(H.image).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 消息版式(messageLayout)— adapter 折叠 / 序列广播映射 / 全局热更
// ---------------------------------------------------------------------------

describe("createPipelineRuntime — 消息版式", () => {
	it("postSettingsOf 折叠 eff.messageLayout 的作品切片", () => {
		const g = makeDefaultGlobalSettings();
		const sub = makeEmptySubscription({
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "1" },
		});
		expect(postSettingsOf(sub, g, true).messageLayout).toEqual(DEFAULT_MESSAGE_LAYOUT.post);
	});

	it("作品分条(分条符切两条)→ 经真的队列与装配,PushRouter 收到一次推送,本体那个锚点里是两条 payload", async () => {
		// 动态轮询说 uid,入口认订阅 —— 这个 uid 得真有一条订阅,接线才往下交。
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
});

// ---------------------------------------------------------------------------
// 链接卡的呈现
//
// 动态卡没有按订阅的样式覆盖(㉔e 起,卡片设置只剩直播封面),链接卡的呈现(皮肤)从推送链路拿,
// 并且随 config-changed 刷新。
// ---------------------------------------------------------------------------

describe("createPipelineRuntime — 链接卡的呈现与开关", () => {
	it("开关与版式随 config-changed 刷新,不用每条消息整份深拷贝 globals", () => {
		const c = setup();
		active = c;
		expect(c.runtime.linkPreview()).toEqual({
			enabled: false,
			isOnByDefault: true,
			replyForm: "image",
			byTarget: {},
			cooldownSec: 60,
		});
		expect(c.runtime.linkCardPresentation().cardSkin).toBe(
			c.configStore.getGlobals().defaults.cardSkin,
		);

		patchGlobals(c, (g) => {
			g.linkPreview = {
				enabled: true,
				isOnByDefault: true,
				replyForm: "image",
				byTarget: {},
				cooldownSec: 5,
			};
			g.defaults.cardSkin = "skin-link";
		});
		c.bus.emit("config-changed", { scope: "globals" });

		expect(c.runtime.linkPreview()).toEqual({
			enabled: true,
			isOnByDefault: true,
			replyForm: "image",
			byTarget: {},
			cooldownSec: 5,
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
		expect(c.runtime.linkPolicyFor(KEY).isOn).toBe(true);
		expect(c.runtime.linkPolicyFor(STRANGER).isOn).toBe(true);

		patchGlobals(c, (g) => {
			g.linkPreview = {
				enabled: true,
				isOnByDefault: false,
				replyForm: "image",
				byTarget: { [TARGET]: { isOn: true } },
				cooldownSec: 60,
			};
		});
		c.bus.emit("config-changed", { scope: "globals" });
		expect(c.runtime.linkPolicyFor(KEY)).toEqual({ isOn: true, replyForm: "image" });
		expect(c.runtime.linkPolicyFor(STRANGER).isOn).toBe(false);

		// 目标停用 → 那群不再解析;只发 targets 的变更,不发 globals。
		c.configStore._setTargets([{ ...c.configStore.getTargets()[0], enabled: false } as PushTarget]);
		c.bus.emit("config-changed", { scope: "targets" });
		expect(c.runtime.linkPolicyFor(KEY).isOn).toBe(false);

		// 目标恢复、但连接停用 → 同样不算;只发 connections 的变更。
		c.configStore._setTargets([{ ...c.configStore.getTargets()[0], enabled: true } as PushTarget]);
		c.bus.emit("config-changed", { scope: "targets" });
		expect(c.runtime.linkPolicyFor(KEY).isOn).toBe(true);
		c.configStore._setConnections([
			{ ...c.configStore.getConnections()[0], enabled: false } as any,
		]);
		c.bus.emit("config-changed", { scope: "connections" });
		expect(c.runtime.linkPolicyFor(KEY).isOn).toBe(false);
	});
});

/** 目标可达性只在通断翻转时写:四格真值表(没记过的那格在「后台写登记进 track」里钉了)。 */
describe("createPipelineRuntime — 目标可达性不翻转就不写", () => {
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
			descriptor: placeholderDescriptor(),
			isAvailable: () => true,
			send: async () => (sendOk ? { ok: true, latencyMs: 7 } : fail("unavailable", "发不出去")),
			probe: async () => ok({ latencyMs: 1 }),
			listConnectionCandidates: async () => [],
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

describe("createPipelineRuntime — 连接所在平台的能力", () => {
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
		// 内置平台的 atAll / inbound 是静态的「支持」,只有小程序卡要探;假实现照此,
		// 「还不知道」才只剩小程序卡这一格(宿主补探看的是任一格还不知道)。
		const caps = (): ConnectionCapabilities => ({
			atAll: { state: "supported", checkedAt: "2026-10-26T00:00:00.000Z" },
			inbound: { state: "supported", checkedAt: "2026-10-26T00:00:00.000Z" },
			nativeShare:
				state === "supported" ? { state, checkedAt: "2026-10-26T00:00:00.000Z" } : { state },
		});
		const pa: PlatformAdapter = {
			adapterKey: "onebot",
			settingsSchema: z.unknown(),
			descriptor: placeholderDescriptor(),
			isAvailable: () => true,
			send: async () => ({ ok: true, latencyMs: 1 }),
			probe: vi.fn(async () => (probeOk ? ok({ latencyMs: 1 }) : fail("unavailable", "连不上"))),
			capabilities: () => caps(),
			probeCapabilities,
			listConnectionCandidates: async () => [],
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
		expect(c.runtime.connectionCapabilities(ADAPTER)?.nativeShare).toEqual({
			state: "supported",
			checkedAt: "2026-10-26T00:00:00.000Z",
		});
		// 已经有答案的不重探:主人点「测试」只做健康探测。
		await c.runtime.probeConnection(ADAPTER);
		expect(probeCapabilities).toHaveBeenCalledTimes(1);
	});

	it("探完仍「未探测」→ 主人点「测试」会再给一次机会(宿主的重探窗口 60 秒过了之后)", async () => {
		const { pa, probeCapabilities } = fakePlatform("unknown");
		const c = setup({ connections: [onebot], platformAdapters: [pa] });
		active = c;
		await tick();
		expect(probeCapabilities).toHaveBeenCalledTimes(1);
		// 窗口内:宿主不再问适配器(探不出来的连接每问一次要赔一个超时)。
		await c.runtime.probeConnection(ADAPTER);
		expect(probeCapabilities).toHaveBeenCalledTimes(1);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(Date.now() + 61_000);
			await c.runtime.probeConnection(ADAPTER);
		} finally {
			vi.useRealTimers();
		}
		expect(probeCapabilities).toHaveBeenCalledTimes(2);
		expect(c.runtime.connectionCapabilities(ADAPTER)?.nativeShare).toEqual({ state: "unknown" });
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
describe("createPipelineRuntime — 推送层的 aiWriting 读口接的是活的全局设置", () => {
	it("读口回当前的 ai.writing;全局换了新的一份,下一次读到的就是新的", () => {
		const first = makeDefaultGlobalSettings();
		first.ai.writing.post = { isOnByDefault: false, byTarget: { "t-1": true } };
		const c = setup({ globals: first });
		active = c;
		const read = (H.push[0] as { opts: { aiWriting: () => unknown } }).opts.aiWriting;
		expect(read()).toEqual({
			post: { isOnByDefault: false, byTarget: { "t-1": true } },
			liveSummary: { isOnByDefault: true, byTarget: {} },
		});

		const next = structuredClone(first);
		next.ai.writing.post = { isOnByDefault: true, byTarget: {} };
		next.ai.writing.liveSummary = { isOnByDefault: false, byTarget: {} };
		c.configStore._set(next);
		expect(read()).toEqual({
			post: { isOnByDefault: true, byTarget: {} },
			liveSummary: { isOnByDefault: false, byTarget: {} },
		});
	});
});

/**
 * 发出去不管的写要登记进 `ctx.track()`(切片 ③)。
 *
 * 关停在 flush 段让各写道关门;关门前还没**交进写道**的活(先下载图片、再写历史)会在关门后被拒 ——
 * 数据就丢了。所以每条用例都是:让那笔写停在半路 → 断言登记进去的这件事此刻还悬着 → 放行 → 断言写已落定。
 * `track` 没接线时登记进来的是空的,`Promise.all([])` 立刻落定,第二句必红。
 */
describe("createPipelineRuntime — 后台写登记进 track", () => {
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
		const dataDir = await mkdtemp(join(tmpdir(), "bn-pipeline-track-"));
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

	it("onSend:历史写失败按当前语言记录，保留原错误与 cause，不记录消息正文", async () => {
		const previous = i18n.state();
		try {
			i18n.set({ locale: "en", voice: "maid" });
			const sub = makeEmptySubscription({
				id: SUB_ID,
				identity: { sourceKey: "bilibili", externalId: "1" },
			});
			const error = new Error("queue closed", { cause: new Error("disk unavailable") });
			const record = vi.fn(async () => {
				throw error;
			});
			const c = setup({ subs: [sub], overrides: { historyStore: { record } } });
			active = c;
			await c.sourceReady;
			const before = c.serviceCtx.tracking.tracked.length;
			H.push[0].opts.onSend({
				pushId: "p1",
				subscriptionId: SUB_ID,
				feature: "post",
				target: null,
				messages: [{ payload: { kind: "text", text: "PRIVATE-MESSAGE-CONTENT" }, role: "main" }],
			});
			await expect(newlyTracked(c, before)).resolves.toBeDefined();
			expect(c.serviceCtx.logger.warn).toHaveBeenCalledExactlyOnceWith(
				"Failed to record push history",
				{
					event: "pipeline.history_record_failed",
					pushId: "p1",
					subscriptionId: SUB_ID,
					targetId: null,
					feature: "post",
				},
				error,
			);
			expect(JSON.stringify(c.serviceCtx.logger.warn.mock.calls)).not.toContain(
				"PRIVATE-MESSAGE-CONTENT",
			);
		} finally {
			i18n.set(previous);
		}
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
			descriptor: placeholderDescriptor(),
			isAvailable: () => true,
			send: async () => ({ ok: true, latencyMs: 1 }),
			probe,
			listConnectionCandidates: async () => [],
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

		// 验红:删掉 pipeline.ts 里 config-changed:connections 那一档的 `connectionProbe.checkSettings()`,这条红。
		it("连接变更时设置不合法的连接当场进问题表,不用等下一轮探测", async () => {
			const c = setup({
				connections: [{ ...onebot(CONNECTION_ID), settings: { token: "t" } }],
				platformAdapters: [
					{
						...okPlatform(async () => ok({ latencyMs: 1 })),
						settingsSchema: z.object({ token: z.string().min(1) }),
					},
				],
			});
			active = c;
			await vi.waitFor(() => expect(c.serviceCtx.tracking.tracked.length).toBeGreaterThan(0));
			await Promise.all(c.serviceCtx.tracking.tracked);
			expect(c.problems.list()).toEqual([]);
			c.configStore._setConnections([{ ...onebot(CONNECTION_ID), settings: {} }]);
			c.bus.emit("config-changed", { scope: "connections" });
			expect(c.problems.list().map((p) => [p.reporter, p.code])).toEqual([
				["onebot", "connection_settings_invalid"],
			]);
		});

		// 接线的守卫:模块对了、没接上(问题表 / 主人连接 / 适配器在场没递进去)单元测试看不出来。
		// 验红:删掉 pipeline.ts 里递给 createConnectionProbeEngine 的 `problems` / `masterConnectionId`,这两条红。
		describe("连接断了经问题表私聊主人", () => {
			const MASTER_TARGET = "55555555-5555-4555-8555-555555555555";
			afterEach(() => {
				vi.useRealTimers();
			});
			/** 先通、再连续两次不通;返回引擎环境。 */
			async function downAfterUp(opts: { masterOnThisConnection: boolean }) {
				vi.useFakeTimers({
					toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
				});
				let up = true;
				const globals = makeDefaultGlobalSettings();
				if (opts.masterOnThisConnection) globals.master.targetId = MASTER_TARGET;
				const c = setup({
					globals,
					connections: [onebot(CONNECTION_ID)],
					platformAdapters: [
						okPlatform(async () => (up ? ok({ latencyMs: 1 }) : fail("unavailable", "拒绝连接"))),
					],
					overrides: {
						configStore: {
							getTargets: () => [
								{ id: MASTER_TARGET, connectionId: CONNECTION_ID, kind: "session", enabled: true },
							],
						},
					},
				});
				active = c;
				await vi.advanceTimersByTimeAsync(0);
				up = false;
				await vi.advanceTimersByTimeAsync(60_000);
				await vi.advanceTimersByTimeAsync(60_000);
				return c;
			}

			it("通过之后连续两次不通:进表,私聊主人一次", async () => {
				const c = await downAfterUp({ masterOnThisConnection: false });
				expect(c.problems.list().map((p) => [p.reporter, p.code])).toEqual([
					["onebot", "connection_unreachable"],
				]);
				expect(H.push[0].notifyMaster).toHaveBeenCalledTimes(1);
			});

			it("主人的私聊目标走的就是这条连接:进表,不私聊", async () => {
				const c = await downAfterUp({ masterOnThisConnection: true });
				expect(c.problems.list().map((p) => p.code)).toEqual(["connection_unreachable"]);
				expect(H.push[0].notifyMaster).not.toHaveBeenCalled();
			});
		});
	});
});
