// biome-ignore-all lint/suspicious/noExplicitAny: vitest mock class 字段/构造器入参故意保留 any,避免重复定义业务实例的窄类型
/**
 * 单元测试 — `createEngines` 的「无重启热重载」契约(独立端配置流向核心)。
 *
 * engines.ts 自身构造真实 DynamicEngine / LiveEngine / BilibiliPush / CommentaryGenerator /
 * ImageRenderer,代价太大且与本测试无关 —— 这里把这 5 个引擎包 `vi.mock` 成 spy class,
 * 用真实 NodeMessageBus 驱动事件,聚焦验证 engines.ts 的 wiring 与热重载分支:
 *
 *   boot:           push.start / dynamic.start 拉起;默认 globals 下 AI / image 不构造
 *   config-changed globals:  dynamic+live.updateConfig、setLevel、api.setUserAgent、
 *                            loginFlow.setHealthCheckMs、push.setMaster 一并热推,
 *                            且新 dynamicCron 透传进 DynamicEngineConfig
 *   config-changed targets:  仅 push.setMaster 后早退(不触发 dynamic.updateConfig)
 *   config-changed 其它 scope:no-op
 *   AI 启 / 停 / 改:           lazy 构造 + 失效降级 + 已存在时 updateConfig
 *   image 配色热更:            puppeteer 在位时 imageRenderer.updateConfig
 *   subscription-changed / auth-restored / auth-lost: 转译并下发到引擎
 *   dispose():                stop 全引擎 + 解绑 bus(dispose 后 config-changed 不再生效)
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalConfig, Subscription } from "@bilibili-notify/internal";
import {
	DEFAULT_CARD_LAYOUT,
	DEFAULT_MESSAGE_LAYOUT,
	makeDefaultGlobalConfig,
	makeEmptySubscription,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ConfigStore } from "../../config/store.js";
import { standaloneContentBuilder } from "../content-builder.js";
import { createNodeMessageBus } from "../message-bus.js";
import type { NodeServiceContext } from "../service-context.js";

// ---- 引擎包 spy mocks(每次构造把实例塞进 H.<engine>,字段方法均为 vi.fn)----
const H = vi.hoisted(() => ({
	push: [] as any[],
	dynamic: [] as any[],
	live: [] as any[],
	ai: [] as any[],
	image: [] as any[],
}));

vi.mock("@bilibili-notify/push", () => ({
	BilibiliPush: class {
		opts: any;
		start = vi.fn();
		stop = vi.fn();
		setMaster = vi.fn();
		broadcastToFeature = vi.fn(async () => {});
		sendPrivateMsg = vi.fn(async () => {});
		sendErrorMsg = vi.fn(async () => {});
		constructor(opts: any) {
			this.opts = opts;
			H.push.push(this);
		}
	},
}));

vi.mock("@bilibili-notify/dynamic", () => ({
	// 纯函数镜像(真实实现见 packages/dynamic/src/push-like.ts):dynamic-images 抑制 @全体。
	atAllOptsForDynamicKind: (kind: string) =>
		kind === "dynamic-images" ? { allowAtAll: false } : undefined,
	DynamicEngine: class {
		opts: any;
		start = vi.fn();
		stop = vi.fn();
		updateConfig = vi.fn();
		setAi = vi.fn();
		setImage = vi.fn();
		applyOps = vi.fn();
		constructor(opts: any) {
			this.opts = opts;
			H.dynamic.push(this);
		}
	},
}));

vi.mock("@bilibili-notify/live", () => ({
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
}));

vi.mock("@bilibili-notify/ai", () => ({
	CommentaryGenerator: class {
		opts: any;
		start = vi.fn();
		stop = vi.fn();
		updateConfig = vi.fn();
		/**
		 * 构造后 engines.ts 会立刻 `attachReadOnlyTools` 把只读工具接上。替身少了
		 * 这个方法会当场抛,而 buildCommentary 的 try/catch 会把它吞成「AI 初始化
		 * 失败」—— 表现是 H.ai 里有实例但 start 一次没调,不是一眼能看懂的报错。
		 */
		setSubManagement = vi.fn();
		constructor(opts: any) {
			this.opts = opts;
			H.ai.push(this);
		}
	},
}));

vi.mock("@bilibili-notify/image", () => ({
	ImageRenderer: class {
		opts: any;
		start = vi.fn();
		stop = vi.fn();
		updateConfig = vi.fn();
		constructor(opts: any) {
			this.opts = opts;
			H.image.push(this);
		}
	},
}));

// SUT must be imported AFTER the vi.mock calls register.
const {
	createEngines,
	liveTypeToFeature,
	liveTypeAllowsAtAll,
	buildDynamicSubViewSingle,
	buildLiveSubViewSingle,
} = await import("../engines.js");

// Mirror of koishi/live/src/__tests__/live-type-to-feature.test.ts — the two
// adapter helpers MUST stay byte-consistent across ends (same business core,
// different shells). liveTypeAllowsAtAll guards the @全体 bug fix: only
// StartBroadcasting(3) is at-all-eligible; periodic「正在直播」(0) is NOT.
describe("apps/server adapter live-type map (cross-end mirror)", () => {
	it("liveTypeToFeature 完整映射表 + 未知兜底 live", () => {
		expect(liveTypeToFeature(0)).toBe("live");
		expect(liveTypeToFeature(3)).toBe("live");
		expect(liveTypeToFeature(4)).toBe("liveGuardBuy");
		expect(liveTypeToFeature(5)).toBe("wordcloud");
		expect(liveTypeToFeature(6)).toBe("superchat");
		expect(liveTypeToFeature(7)).toBe("specialDanmaku");
		expect(liveTypeToFeature(8)).toBe("specialUserEnter");
		expect(liveTypeToFeature(9)).toBe("liveEnd");
		expect(liveTypeToFeature(10)).toBe("liveSummary");
		expect(liveTypeToFeature(999)).toBe("live");
	});

	it("liveTypeAllowsAtAll:仅开播(3)允许,0/其它/未知一律 false", () => {
		expect(liveTypeAllowsAtAll(3)).toBe(true);
		expect(liveTypeAllowsAtAll(0)).toBe(false);
		for (const t of [4, 5, 6, 7, 8, 9, 10, 999]) {
			expect(liveTypeAllowsAtAll(t)).toBe(false);
		}
	});
});

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeSubCtx() {
	return {
		logger: makeLogger(),
		setLevel: vi.fn(),
		setInterval: vi.fn(() => ({ dispose() {} })),
		setTimeout: vi.fn(() => ({ dispose() {} })),
		onDispose: vi.fn(),
	};
}

function makeServiceCtx() {
	return {
		logger: makeLogger(),
		setLevel: vi.fn(),
		setInterval: vi.fn(() => ({ dispose() {} })),
		setTimeout: vi.fn(() => ({ dispose() {} })),
		onDispose: vi.fn(),
		forSubsystem: vi.fn(() => makeSubCtx()),
	};
}

function makeConfigStore(initial: GlobalConfig) {
	let g = initial;
	return {
		// 背景轮换游标 fs 路径取自此。指向 OS 临时目录下一个**不存在**的子目录(跨平台:
		// Windows/macOS/Linux 都解析为各自 tmp 根):load 读不到走 catch 返回 {};测试不触发
		// 轮换故游标不脏、dispose 不写盘(即便写,目标在 tmp 下也无害)。不含任何真实路径/密钥。
		bootstrap: { dataDir: join(tmpdir(), "bn-engines-test-no-such-dir") },
		getGlobals: () => g,
		getTargets: () => [],
		getAdapters: () => [],
		patchTarget: vi.fn(async () => {}),
		patchAdapter: vi.fn(async () => {}),
		_set: (next: GlobalConfig) => {
			g = next;
		},
	};
}

interface Ctx {
	runtime: ReturnType<typeof createEngines>;
	bus: ReturnType<typeof createNodeMessageBus>;
	serviceCtx: ReturnType<typeof makeServiceCtx>;
	configStore: ReturnType<typeof makeConfigStore>;
	api: { setUserAgent: ReturnType<typeof vi.fn> };
	loginFlow: { setHealthCheckMs: ReturnType<typeof vi.fn> };
}

function setup(opts?: { globals?: GlobalConfig; puppeteer?: boolean; subs?: Subscription[] }): Ctx {
	const serviceCtx = makeServiceCtx();
	const configStore = makeConfigStore(opts?.globals ?? makeDefaultGlobalConfig());
	const api = { setUserAgent: vi.fn() };
	const loginFlow = { setHealthCheckMs: vi.fn() };
	const bus = createNodeMessageBus();
	const subs = opts?.subs ?? [];
	const runtime = createEngines({
		serviceCtx: serviceCtx as unknown as NodeServiceContext,
		api: api as any,
		loginFlow: loginFlow as any,
		configStore: configStore as unknown as ConfigStore,
		historyStore: { append: vi.fn(async () => {}) } as any,
		subscriptionStore: {
			list: () => subs,
			findByUid: (uid: string) => subs.find((s) => s.uid === uid),
		} as any,
		subRuntimeStore: {
			get: () => undefined,
			getAll: () => ({}),
			patch: vi.fn(async () => {}),
			prune: vi.fn(async () => {}),
			load: vi.fn(async () => {}),
		} as any,
		bus,
		adapters: [],
		puppeteer: opts?.puppeteer ? ({} as any) : null,
	});
	return { runtime, bus, serviceCtx, configStore, api, loginFlow };
}

/** structuredClone 当前 globals → mutate → 写回 store(模拟 ConfigStore.patch 后的快照)。 */
function patchGlobals(c: Ctx, mutate: (g: GlobalConfig) => void): void {
	const next = structuredClone(c.configStore.getGlobals());
	mutate(next);
	c.configStore._set(next);
}

function aiGlobals(): GlobalConfig {
	const g = makeDefaultGlobalConfig();
	(g.defaults.ai as Record<string, unknown>).apiKey = "k-test";
	(g.defaults.ai as Record<string, unknown>).baseUrl = "https://api.example.com";
	return g;
}

let active: Ctx | null = null;
beforeEach(() => {
	H.push.length = 0;
	H.dynamic.length = 0;
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
// packages/live 侧钉住了 RoomSession **发出** startedAt,recorder 侧钉住了它**消费**
// startedAt,live-midstream-start 还把 recorder→store→aggregate 三层串起来测了。
// 唯独把两头缝上的这一行没有任何测试:它是 adapter 里的一句 lambda,少写第三个参数
// 依然类型正确(签名上 startedAt 是可选的)、构建全绿、2483 条测试全过,而整个特性
// 静默退回「我们发现的时刻」—— 统计侧按 startedAt 认场次,同一场随即被记成两条。
// ---------------------------------------------------------------------------

describe("createEngines — live-state-changed 接线", () => {
	it("startedAt 一路转发到 bus,不在 adapter 这层被吃掉", () => {
		const c = setup();
		active = c;
		const seen: unknown[][] = [];
		c.bus.on("live-state-changed", (uid, status, startedAt) => {
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
		c.bus.on("live-state-changed", (uid, status, startedAt) => {
			seen.push([uid, status, startedAt]);
		});
		H.live[0].opts.emitLiveState("u1", "idle", undefined);
		expect(seen).toEqual([["u1", "idle", undefined]]);
	});
});

describe("createEngines — boot wiring", () => {
	it("默认 globals:push/dynamic 拉起,AI 与 image 不构造", () => {
		const c = setup();
		active = c;
		expect(H.push).toHaveLength(1);
		expect(H.push[0].start).toHaveBeenCalledTimes(1);
		expect(H.dynamic).toHaveLength(1);
		expect(H.dynamic[0].start).toHaveBeenCalledTimes(1);
		expect(H.live).toHaveLength(1);
		// 无订阅 → 初始 live view 为空 → live.start 不调用。
		expect(H.live[0].start).not.toHaveBeenCalled();
		// 默认 globals 无 apiKey/baseUrl / 无 puppeteer。
		expect(H.ai).toHaveLength(0);
		expect(H.image).toHaveLength(0);
		// 启动期把 userAgent 推到 BilibiliAPI 一次。
		expect(c.api.setUserAgent).toHaveBeenCalledTimes(1);
		// boot 时 base logger(core 桶)立即对齐 logLevels.core ?? app.logLevel
		// (默认 globals 无 core override → "info";不等首次 dashboard 保存)。
		expect(c.serviceCtx.setLevel).toHaveBeenCalledTimes(1);
		expect(c.serviceCtx.setLevel).toHaveBeenCalledWith("info");
	});

	it("apiKey+baseUrl 齐备:启动即构造 CommentaryGenerator 并 start", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		expect(H.ai).toHaveLength(1);
		expect(H.ai[0].start).toHaveBeenCalledTimes(1);
	});

	it("构造后立刻接上只读工具 —— 不接的话女仆连订阅列表都查不到", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		expect(H.ai[0].setSubManagement).toHaveBeenCalledTimes(1);
		// 只读档的具体含义(不给 subMgmt)由 ai/read-only-tools 的测试盯着;
		// 这里只钉「engines 确实接了」,免得那行接线被顺手删掉还全绿。
		expect(H.ai[0].setSubManagement.mock.calls[0][0]).toHaveProperty("getSubs");
	});

	it("puppeteer 在位:构造 ImageRenderer 并 start", () => {
		const c = setup({ puppeteer: true });
		active = c;
		expect(H.image).toHaveLength(1);
		expect(H.image[0].start).toHaveBeenCalledTimes(1);
	});

	it("直播消息模板无开关:boot 时 live 引擎 config 始终带全局模板(回归 liveMsgEnabled 移除)", () => {
		// 此前 liveMsgEnabled=false(默认)→ customLiveMsg 不带 customLiveStart,引擎走
		// builtin。现无开关:全局模板始终下发,编辑即生效(默认值 == builtin,输出不变)。
		const c = setup();
		active = c;
		const liveCfg = H.live[0].opts.config;
		expect(liveCfg.customLiveMsg.customLiveStart).toBe("{name} 开播啦，当前粉丝数：{follower}");
		expect(liveCfg.customLiveMsg.customLive).toBe(
			"{name} 正在直播，已播 {time}，累计观看：{watched}",
		);
		expect(liveCfg.customLiveMsg.customLiveEnd).toBe(
			"{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}",
		);
	});
});

describe("createEngines — enableImageRendering 运行时热启用", () => {
	it("启动无 puppeteer,运行时注入 → 构造 renderer + start + setImage/setImageRenderer", () => {
		const c = setup({ puppeteer: false });
		active = c;
		expect(H.image).toHaveLength(0); // 启动时无 renderer
		const enabled = c.runtime.enableImageRendering({} as any);
		expect(enabled).toBe(true);
		expect(H.image).toHaveLength(1);
		expect(H.image[0].start).toHaveBeenCalledTimes(1);
		expect(H.dynamic[0].setImage).toHaveBeenCalledWith(H.image[0]);
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

	it("swapImageRendering:已启用时热切换 → 重建 renderer 并重新注入两个引擎", () => {
		const c = setup({ puppeteer: true });
		active = c;
		expect(H.image).toHaveLength(1);
		c.runtime.swapImageRendering({} as any);
		expect(H.image).toHaveLength(2); // 新 renderer
		expect(H.image[1].start).toHaveBeenCalledTimes(1);
		expect(H.dynamic[0].setImage).toHaveBeenLastCalledWith(H.image[1]);
		expect(H.live[0].setImageRenderer).toHaveBeenLastCalledWith(H.image[1]);
	});

	it("swapImageRendering:未启用时等同首次启用(注入而非空转)", () => {
		const c = setup({ puppeteer: false });
		active = c;
		expect(H.image).toHaveLength(0);
		c.runtime.swapImageRendering({} as any);
		expect(H.image).toHaveLength(1);
		expect(H.dynamic[0].setImage).toHaveBeenLastCalledWith(H.image[0]);
		expect(H.live[0].setImageRenderer).toHaveBeenLastCalledWith(H.image[0]);
	});
});

describe("createEngines — config-changed globals 热重载", () => {
	it("改 app 字段:热推 health + dynamic,不碰 live.updateConfig", () => {
		const c = setup();
		active = c;
		patchGlobals(c, (g) => {
			g.app.dynamicCron = "*/9 * * * *";
			g.app.healthCheckMinutes = 45;
		});
		c.bus.emit("config-changed", "globals");

		expect(H.dynamic[0].updateConfig).toHaveBeenCalledTimes(1);
		expect(c.loginFlow.setHealthCheckMs).toHaveBeenCalledWith(45 * 60_000);
		expect(H.push[0].setMaster).toHaveBeenCalledTimes(1);
		// app 变更不在 liveConfig() 的输入内 → live.updateConfig 不应触发(item 4:不扇出)。
		expect(H.live[0].updateConfig).not.toHaveBeenCalled();
		// UA / 日志等级这次都没动 → 不该被顺手重设(boot 那 1 次之外不再有)。
		expect(c.api.setUserAgent).toHaveBeenCalledTimes(1);
		expect(c.serviceCtx.setLevel).toHaveBeenCalledTimes(1);
	});

	// `app` 曾是一道粗门:只要 section 里任一字段变,门内 setLevel×5 + setUserAgent +
	// setHealthCheckMs 就无差别全做一遍。于是改个 cron 会顺手重设 UA(刷一条 info)、
	// 并把登录健康检查的 setInterval **销毁重建**(相位被白白打乱)。下面三条按字段钉死。
	it("只改 dynamicCron:不重设 UA、不重排健康检查、不动日志等级", () => {
		const c = setup();
		active = c;
		patchGlobals(c, (g) => {
			// 必须与默认值不同 —— DEFAULT_DYNAMIC_CRON 现在就是 "30 */2 * * * *"。
			g.app.dynamicCron = "*/9 * * * *";
		});
		c.bus.emit("config-changed", "globals");

		expect(H.dynamic[0].updateConfig).toHaveBeenCalledTimes(1); // cron 本身要生效
		expect(c.api.setUserAgent).toHaveBeenCalledTimes(1); // 仅 boot(engines.ts:185)
		expect(c.serviceCtx.setLevel).toHaveBeenCalledTimes(1); // 仅 boot(engines.ts:181)
		expect(c.loginFlow.setHealthCheckMs).not.toHaveBeenCalled(); // boot 不调,这次也不该调
	});

	it("改 defaults.imageGroup:热推进 dynamic(此前整个漏在门外,改了要重启才生效)", () => {
		// dynamicConfig() 明明读 `defaults.imageGroup`,但 config-changed 的 diff 列表里
		// 从来没有 imageGroupChanged —— 于是改「图片合并转发」时所有 *Changed 全 false,
		// dynamic.updateConfig 根本不调,配置静静躺在 store 里直到下次重启。这是漏更新,
		// 比多更新严重得多(用户以为保存生效了,其实没有)。
		const c = setup();
		active = c;
		patchGlobals(c, (g) => {
			g.defaults.imageGroup.enable = !g.defaults.imageGroup.enable;
		});
		c.bus.emit("config-changed", "globals");

		expect(H.dynamic[0].updateConfig).toHaveBeenCalledTimes(1);
		const cfg = H.dynamic[0].updateConfig.mock.calls.at(-1)?.[0];
		expect(cfg.imageGroup).toEqual(c.configStore.getGlobals().defaults.imageGroup);
	});

	it("只改 userAgent:重设 UA,不重排健康检查", () => {
		const c = setup();
		active = c;
		patchGlobals(c, (g) => {
			g.app.userAgent = "Mozilla/5.0 (custom)";
		});
		c.bus.emit("config-changed", "globals");

		expect(c.api.setUserAgent).toHaveBeenCalledTimes(2);
		expect(c.api.setUserAgent).toHaveBeenLastCalledWith("Mozilla/5.0 (custom)");
		expect(c.loginFlow.setHealthCheckMs).not.toHaveBeenCalled();
	});

	it("只改 logLevel:热推 5 个子系统的 setLevel,不重设 UA", () => {
		const c = setup();
		active = c;
		patchGlobals(c, (g) => {
			g.app.logLevel = "debug";
		});
		c.bus.emit("config-changed", "globals");

		expect(c.serviceCtx.setLevel).toHaveBeenCalledTimes(2);
		expect(c.api.setUserAgent).toHaveBeenCalledTimes(1);
	});

	it("配了 AI 时,只改 dynamicCron 不该热重载 commentary", () => {
		// 现有 setup() 不配 AI → commentary 为 null → 永远走不进 `else if (commentary)`
		// 分支,所以「改 app 扇出到 ai」这条路此前无人守。主人的实例配了 AI 才暴露。
		const c = setup({ globals: aiGlobals() });
		active = c;
		expect(H.ai).toHaveLength(1); // boot 时已构造
		H.ai[0].updateConfig.mockClear();

		patchGlobals(c, (g) => {
			g.app.dynamicCron = "30 */2 * * * *";
		});
		c.bus.emit("config-changed", "globals");

		expect(H.ai[0].updateConfig).not.toHaveBeenCalled();
	});

	it("新 dynamicCron 透传进 DynamicEngineConfig", () => {
		const c = setup();
		active = c;
		patchGlobals(c, (g) => {
			g.app.dynamicCron = "*/7 * * * *";
		});
		c.bus.emit("config-changed", "globals");
		const cfg = H.dynamic[0].updateConfig.mock.calls.at(-1)?.[0];
		expect(cfg.dynamicCron).toBe("*/7 * * * *");
	});

	it("改全局 templates.dynamic/dynamicVideo → dynamic.updateConfig 热推新模板(templatesChanged 触发)", () => {
		// 回归:dynamicConfig() 读 templates.dynamic/dynamicVideo,触发条件必须含
		// templatesChanged,否则只改全局动态文本模板时引擎不热更、无 per-UP 覆盖的
		// 订阅一直用旧模板。
		const c = setup();
		active = c;
		patchGlobals(c, (g) => {
			g.defaults.templates.dynamic = "🔔 {name} {url}";
			g.defaults.templates.dynamicVideo = "🎬 {name} {url}";
		});
		c.bus.emit("config-changed", "globals");
		expect(H.dynamic[0].updateConfig).toHaveBeenCalledTimes(1);
		const cfg = H.dynamic[0].updateConfig.mock.calls.at(-1)?.[0];
		expect(cfg.dynamicTemplate).toBe("🔔 {name} {url}");
		expect(cfg.videoTemplate).toBe("🎬 {name} {url}");
	});

	it("回归:改全局 cardStyle.backgroundImages → 两端 config 都带 defaultBackgroundImages(无覆盖的 UP 靠它轮换)", () => {
		// 此前 dynamicConfig()/liveConfig() 都没有把全局默认图廊透传给引擎,
		// 导致无 per-UP / per-kind 背景覆盖的 UP 永远只渲染渲染器内部缓存的
		// 静态首图,图廊配再多张也不轮换。
		const c = setup();
		active = c;
		patchGlobals(c, (g) => {
			g.defaults.cardStyle.backgroundImages = ["a", "b"];
		});
		c.bus.emit("config-changed", "globals");
		const dynCfg = H.dynamic[0].updateConfig.mock.calls.at(-1)?.[0];
		const liveCfg = H.live[0].updateConfig.mock.calls.at(-1)?.[0];
		expect(dynCfg.defaultBackgroundImages).toEqual(["a", "b"]);
		expect(liveCfg.defaultBackgroundImages).toEqual(["a", "b"]);
	});

	it("item 4 — 改 defaults.ai 不扇出重设 UA / level / healthCheck", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		patchGlobals(c, (g) => {
			g.defaults.ai.persona.name = "恶魔兔";
		});
		c.bus.emit("config-changed", "globals");
		// boot 各 1 次;改 AI 人设不应再扇出到 app section。
		expect(c.api.setUserAgent).toHaveBeenCalledTimes(1);
		expect(c.serviceCtx.setLevel).toHaveBeenCalledTimes(1);
		expect(c.loginFlow.setHealthCheckMs).not.toHaveBeenCalled();
		// AI 本身仍热更。
		expect(H.ai[0].updateConfig).toHaveBeenCalledTimes(1);
	});

	it("item 3 — 改全局配置:live.applyOps 收到全部订阅的 update op(刷新 per-sub 视图)", () => {
		const sub = makeEmptySubscription({ id: "sub-1", uid: "1" });
		const c = setup({ globals: aiGlobals(), subs: [sub] });
		active = c;
		patchGlobals(c, (g) => {
			g.defaults.ai.persona.name = "恶魔兔";
		});
		c.bus.emit("config-changed", "globals");
		const liveOps = H.live[0].applyOps.mock.calls.at(-1)?.[0];
		expect(liveOps).toHaveLength(1);
		expect(liveOps[0]).toMatchObject({ type: "update", uid: "1" });
	});

	it("回归:只改全局 cardLayout(不碰 cardStyle/ai/schedule 等)→ live.applyOps 与 dynamic.applyOps 都收到刷新(此前 layoutChanged 未接入热更 gate,保存版式后预览生效但实际推送仍用旧版式)", () => {
		const sub = makeEmptySubscription({ id: "sub-1", uid: "1" });
		const c = setup({ subs: [sub] });
		active = c;
		H.dynamic[0].applyOps.mockClear();
		H.live[0].applyOps.mockClear();
		patchGlobals(c, (g) => {
			const block = g.defaults.cardLayout.live[0];
			expect(block).toBeDefined();
			if (block) block.visible = false;
		});
		c.bus.emit("config-changed", "globals");

		const liveOps = H.live[0].applyOps.mock.calls.at(-1)?.[0];
		expect(liveOps).toHaveLength(1);
		expect(liveOps[0]).toMatchObject({ type: "update", uid: "1" });
		expect(liveOps[0].changes[0].cardLayout.live[0].visible).toBe(false);

		expect(H.dynamic[0].applyOps).toHaveBeenCalledTimes(1);
		const dynOps = H.dynamic[0].applyOps.mock.calls.at(-1)?.[0];
		expect(dynOps).toHaveLength(1);
		expect(dynOps[0]).toMatchObject({ type: "update", uid: "1" });
	});

	it("no-op:globals 未变的 config-changed 不热推任何子系统", () => {
		const c = setup();
		active = c;
		c.bus.emit("config-changed", "globals");
		expect(H.dynamic[0].updateConfig).not.toHaveBeenCalled();
		expect(H.dynamic[0].applyOps).not.toHaveBeenCalled();
		expect(H.live[0].updateConfig).not.toHaveBeenCalled();
		expect(H.live[0].applyOps).not.toHaveBeenCalled();
		// 仅 boot 推过一次。
		expect(c.api.setUserAgent).toHaveBeenCalledTimes(1);
	});

	it("targets scope:仅 push.setMaster,早退不触发 dynamic.updateConfig", () => {
		const c = setup();
		active = c;
		c.bus.emit("config-changed", "targets");
		expect(H.push[0].setMaster).toHaveBeenCalledTimes(1);
		expect(H.dynamic[0].updateConfig).not.toHaveBeenCalled();
	});

	it("subscriptions / secrets scope:不 setMaster 不 updateConfig", () => {
		const c = setup();
		active = c;
		c.bus.emit("config-changed", "subscriptions");
		c.bus.emit("config-changed", "secrets");
		expect(H.push[0].setMaster).not.toHaveBeenCalled();
		expect(H.dynamic[0].updateConfig).not.toHaveBeenCalled();
		expect(H.live[0].updateConfig).not.toHaveBeenCalled();
	});
});

describe("createEngines — AI 热重载三态", () => {
	it("启用:lazy 构造 commentary 并下发给 dynamic/live", () => {
		const c = setup(); // 默认无 AI
		active = c;
		expect(H.ai).toHaveLength(0);
		patchGlobals(c, (g) => {
			(g.defaults.ai as Record<string, unknown>).apiKey = "k";
			(g.defaults.ai as Record<string, unknown>).baseUrl = "https://api.example.com";
		});
		c.bus.emit("config-changed", "globals");
		expect(H.ai).toHaveLength(1);
		expect(H.ai[0].start).toHaveBeenCalledTimes(1);
		expect(H.dynamic[0].setAi).toHaveBeenCalledWith(H.ai[0]);
		expect(H.live[0].setCommentary).toHaveBeenCalledWith(H.ai[0]);
	});

	it("停用:commentary.stop + dynamic.setAi(undefined) + live.setCommentary(null)", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		expect(H.ai).toHaveLength(1);
		patchGlobals(c, (g) => {
			(g.defaults.ai as Record<string, unknown>).apiKey = "";
		});
		c.bus.emit("config-changed", "globals");
		expect(H.ai[0].stop).toHaveBeenCalledTimes(1);
		expect(H.dynamic[0].setAi).toHaveBeenCalledWith(undefined);
		expect(H.live[0].setCommentary).toHaveBeenCalledWith(null);
		// 不应构造新实例。
		expect(H.ai).toHaveLength(1);
	});

	it("仍启用但改配置:增量 updateConfig,不重建实例", () => {
		const c = setup({ globals: aiGlobals() });
		active = c;
		patchGlobals(c, (g) => {
			g.defaults.ai.model = "gpt-4o";
		});
		c.bus.emit("config-changed", "globals");
		expect(H.ai).toHaveLength(1);
		expect(H.ai[0].updateConfig).toHaveBeenCalledTimes(1);
	});
});

describe("createEngines — image 配色热更", () => {
	it("puppeteer 在位:globals 变更 → imageRenderer.updateConfig 带新配色", () => {
		const c = setup({ puppeteer: true });
		active = c;
		patchGlobals(c, (g) => {
			g.defaults.cardStyle.cardColorStart = "#123456";
		});
		c.bus.emit("config-changed", "globals");
		const last = H.image[0].updateConfig.mock.calls.at(-1)?.[0];
		expect(last.cardColorStart).toBe("#123456");
		// cardStyle 变更不在 app section → 不扇出重设 UA(仅 boot 1 次)。
		expect(c.api.setUserAgent).toHaveBeenCalledTimes(1);
	});

	it("font / 数据区 show 开关改完直透 ImageRenderer 同名字段(全链路不桥接)", () => {
		const c = setup({ puppeteer: true });
		active = c;
		// boot 时构造的 ImageRenderer 已收到 default(PingFang / 数据区三项全开)。
		const bootConfig = H.image[0].opts.config;
		expect(bootConfig).toMatchObject({
			font: "PingFang SC, sans-serif",
			showPopularity: true,
			showArea: true,
			showFans: true,
		});

		patchGlobals(c, (g) => {
			g.defaults.cardStyle.font = "Noto Sans CJK SC";
			g.defaults.cardStyle.showPopularity = false;
			g.defaults.cardStyle.showArea = false;
			g.defaults.cardStyle.showFans = false;
		});
		c.bus.emit("config-changed", "globals");
		const last = H.image[0].updateConfig.mock.calls.at(-1)?.[0];
		expect(last).toMatchObject({
			font: "Noto Sans CJK SC",
			showPopularity: false,
			showArea: false,
			showFans: false,
		});
	});
});

describe("createEngines — 订阅 / 鉴权事件转译", () => {
	it("subscription-changed:dynamic.applyOps + live.applyOps", () => {
		const c = setup();
		active = c;
		c.bus.emit("subscription-changed", []);
		expect(H.dynamic[0].applyOps).toHaveBeenCalledTimes(1);
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
	it("dispose 停全引擎并解绑 bus(后续 config-changed 不再生效)", () => {
		const c = setup();
		active = c;
		const dyn = H.dynamic[0];
		const live = H.live[0];
		const push = H.push[0];
		c.runtime.dispose();
		active = null; // 避免 afterEach 二次 dispose
		expect(dyn.stop).toHaveBeenCalledTimes(1);
		expect(live.stop).toHaveBeenCalledTimes(1);
		expect(push.stop).toHaveBeenCalledTimes(1);
		// bus handle 已解绑:dispose 后再发 config-changed 不应再 updateConfig。
		c.bus.emit("config-changed", "globals");
		expect(dyn.updateConfig).not.toHaveBeenCalled();
	});

	it("P2-I:dispose 幂等 — 二次调用(index.ts 显式 + onDispose 双路径)不重复 stop", () => {
		const c = setup();
		active = c;
		const dyn = H.dynamic[0];
		const live = H.live[0];
		const push = H.push[0];
		c.runtime.dispose();
		c.runtime.dispose(); // 双调
		active = null;
		expect(dyn.stop).toHaveBeenCalledTimes(1);
		expect(live.stop).toHaveBeenCalledTimes(1);
		expect(push.stop).toHaveBeenCalledTimes(1);
	});
});

// 回归:禁用一个 UP 时,dynamic 与 live 必须同步停推。
// 此前 subscriptionOpsToLive 的 update 分支不看 sub.enabled,把禁用翻译成带
// live:true 的 update op,LiveEngine(常驻 WS、事件驱动)listener 一直挂着照推;
// dynamic 因有 cron getSubs() 兜底才显得「正常」。修复:op 翻译层显式 gate enabled。
describe("createEngines — 订阅禁用/启用转译", () => {
	function makeSub(uid: string, enabled: boolean): Subscription {
		const s = makeEmptySubscription({ id: `sub-${uid}`, uid });
		s.enabled = enabled;
		return s;
	}

	it("禁用订阅 update:live.applyOps 收到 delete、dynamic.applyOps 收到 dynamic:false", () => {
		const sub = makeSub("100", false);
		const c = setup({ subs: [sub] });
		active = c;
		c.bus.emit("subscription-changed", [{ type: "update", sub }]);

		expect(H.live[0].applyOps.mock.calls.at(-1)?.[0]).toEqual([{ type: "delete", uid: "100" }]);
		expect(H.dynamic[0].applyOps.mock.calls.at(-1)?.[0]).toEqual([
			{ type: "update", uid: "100", changes: [{ scope: "dynamic", dynamic: false }] },
		]);
	});

	it("启用订阅 update:live.applyOps 收到完整 update(非 delete),dynamic 为 dynamic:true", () => {
		const sub = makeSub("200", true);
		const c = setup({ subs: [sub] });
		active = c;
		c.bus.emit("subscription-changed", [{ type: "update", sub }]);

		const liveOps = H.live[0].applyOps.mock.calls.at(-1)?.[0];
		expect(liveOps).toHaveLength(1);
		expect(liveOps[0].type).toBe("update");
		expect(liveOps[0].uid).toBe("200");
		expect(H.dynamic[0].applyOps.mock.calls.at(-1)?.[0]).toEqual([
			{ type: "update", uid: "200", changes: [{ scope: "dynamic", dynamic: true }] },
		]);
	});

	it("禁用订阅 add:不向 live.applyOps 下发 add op", () => {
		const sub = makeSub("300", false);
		const c = setup({ subs: [sub] });
		active = c;
		c.bus.emit("subscription-changed", [{ type: "add", sub }]);

		expect(H.live[0].applyOps.mock.calls.at(-1)?.[0]).toEqual([]);
	});

	it("add op 携带 per-UP 覆盖(imageGroup / 动态模板),不再只带卡片样式", () => {
		// 回归 add gap:此前 dynamic add op 只投影 customCardStyle,新增即带 per-UP
		// imageGroup / filter / 模板覆盖的订阅首推会用全局,要等下次全量刷新。现走
		// buildDynamicSubViewSingle 全量投影。
		const sub = makeSub("600", true);
		sub.overrides.imageGroup = { enable: false };
		sub.overrides.templates = { dynamic: "🔔 {name} {url}", dynamicVideo: "🎬 {name} {url}" };
		const c = setup({ subs: [sub] });
		active = c;
		c.bus.emit("subscription-changed", [{ type: "add", sub }]);

		const dynOps = H.dynamic[0].applyOps.mock.calls.at(-1)?.[0];
		expect(dynOps).toHaveLength(1);
		expect(dynOps[0].type).toBe("add");
		const view = dynOps[0].sub;
		expect(view.uid).toBe("600");
		expect(view.dynamic).toBe(true);
		expect(view.imageGroupEnable).toBe(false);
		expect(view.customDynamicTemplate).toBe("🔔 {name} {url}");
		expect(view.customVideoTemplate).toBe("🎬 {name} {url}");
	});

	it("add op 携带 per-UP cardLayout(live 全量描述符 / dynamic 切片)", () => {
		const sub = makeSub("800", true);
		// per-UP 整份覆盖:把 live 的 cover 块关掉。
		sub.overrides.cardLayout = {
			...DEFAULT_CARD_LAYOUT,
			live: DEFAULT_CARD_LAYOUT.live.map((b) => (b.id === "cover" ? { ...b, visible: false } : b)),
		};
		const c = setup({ subs: [sub] });
		active = c;
		c.bus.emit("subscription-changed", [{ type: "add", sub }]);

		// live add op 带整份 cardLayout,cover 关闭被透传。
		const liveView = H.live[0].applyOps.mock.calls.at(-1)?.[0][0].sub;
		expect(liveView.cardLayout.live.find((b: { id: string }) => b.id === "cover")?.visible).toBe(
			false,
		);

		// dynamic add op 带 dynamic 切片(本例未改动,等于默认版式:含分割线与 additional 块)。
		const dynView = H.dynamic[0].applyOps.mock.calls.at(-1)?.[0][0].sub;
		expect(dynView.dynamicLayout?.map((b: { id: string }) => b.id)).toEqual([
			"header",
			"divider-1",
			"content",
			"additional",
			"divider-2",
			"stats",
		]);
	});

	it("禁用订阅 add:dynamic add op 仍下发但 dynamic:false(engine applyOps 的 !op.sub.dynamic 拦截)", () => {
		// buildDynamicSubViewSingle 的 `dynamic: sub.enabled && eff.features.dynamic`
		// 门必须对 disabled sub 产出 false —— 与旧 add 路径 hasDyn(disabled→false) 等价。
		// engine 侧 applyOps add 分支 `if(!op.sub.dynamic) break` 据此不启动轮询。
		const sub = makeSub("700", false);
		const c = setup({ subs: [sub] });
		active = c;
		c.bus.emit("subscription-changed", [{ type: "add", sub }]);

		const dynOps = H.dynamic[0].applyOps.mock.calls.at(-1)?.[0];
		expect(dynOps).toHaveLength(1);
		expect(dynOps[0].type).toBe("add");
		expect(dynOps[0].sub.uid).toBe("700");
		expect(dynOps[0].sub.dynamic).toBe(false);
	});

	it("remove op:live 与 dynamic 均收到 delete(无视 enabled)", () => {
		const sub = makeSub("400", true);
		const c = setup({ subs: [sub] });
		active = c;
		c.bus.emit("subscription-changed", [{ type: "remove", id: sub.id, uid: "400" }]);

		expect(H.live[0].applyOps.mock.calls.at(-1)?.[0]).toEqual([{ type: "delete", uid: "400" }]);
		expect(H.dynamic[0].applyOps.mock.calls.at(-1)?.[0]).toEqual([{ type: "delete", uid: "400" }]);
	});

	it("连续 disable→enable→disable:live 翻译在 delete / update 间正确切换", () => {
		const sub = makeSub("500", true);
		const c = setup({ subs: [sub] });
		active = c;
		const liveOpsOf = () => H.live[0].applyOps.mock.calls.at(-1)?.[0];

		// disable
		sub.enabled = false;
		c.bus.emit("subscription-changed", [{ type: "update", sub }]);
		expect(liveOpsOf()).toEqual([{ type: "delete", uid: "500" }]);

		// re-enable → 完整 update(LiveEngine.applyOps 见无 listener 走 lookupFullSub 重建)
		sub.enabled = true;
		c.bus.emit("subscription-changed", [{ type: "update", sub }]);
		expect(liveOpsOf()).toHaveLength(1);
		expect(liveOpsOf()[0].type).toBe("update");

		// disable again
		sub.enabled = false;
		c.bus.emit("subscription-changed", [{ type: "update", sub }]);
		expect(liveOpsOf()).toEqual([{ type: "delete", uid: "500" }]);
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

	it("buildDynamicSubViewSingle / buildLiveSubViewSingle 折叠 eff.messageLayout 的对应切片", () => {
		const g = makeDefaultGlobalConfig();
		const sub = makeEmptySubscription({ id: "s1", uid: "1" });
		const dyn = buildDynamicSubViewSingle(sub, subRt, g);
		expect(dyn.messageLayout).toEqual(DEFAULT_MESSAGE_LAYOUT.dynamic);
		const live = buildLiveSubViewSingle(sub, subRt, g);
		expect(live.messageLayout).toEqual(DEFAULT_MESSAGE_LAYOUT.live);
	});

	it("per-UP messageLayout 覆盖折叠进两端视图(整份覆盖 + normalize)", () => {
		const g = makeDefaultGlobalConfig();
		const sub = makeEmptySubscription({ id: "s1", uid: "1" });
		sub.overrides.messageLayout = {
			...DEFAULT_MESSAGE_LAYOUT,
			dynamic: {
				blocks: [
					{ id: "text", type: "text", visible: true },
					{ id: "card", type: "card", visible: false },
				],
				separator: " | ",
			},
		};
		const dyn = buildDynamicSubViewSingle(sub, subRt, g);
		expect(dyn.messageLayout?.blocks.slice(0, 2).map((b: { id: string }) => b.id)).toEqual([
			"text",
			"card",
		]);
		expect(dyn.messageLayout?.separator).toBe(" | ");
		// normalize 追加缺失的 link 块
		expect(dyn.messageLayout?.blocks.map((b: { type: string }) => b.type)).toContain("link");
	});

	it("dynamicPushLike.broadcastDynamicSequence → BilibiliPush 收到 payload 数组", async () => {
		const c = setup();
		active = c;
		const seq = H.dynamic[0].opts.push.broadcastDynamicSequence;
		expect(seq).toBeDefined();
		await seq(
			"1",
			[
				[{ type: "image", buffer: Buffer.from("img"), mime: "image/jpeg" }],
				[{ type: "text", text: "正文" }],
			],
			"dynamic",
		);
		expect(H.push[0].broadcastToFeature).toHaveBeenCalledTimes(1);
		const [uid, feature, payloads, opts] = H.push[0].broadcastToFeature.mock.calls[0];
		expect(uid).toBe("1");
		expect(feature).toBe("dynamic");
		expect(Array.isArray(payloads)).toBe(true);
		expect(payloads).toHaveLength(2);
		expect(payloads[0].kind).toBe("image");
		expect(payloads[1]).toEqual({ kind: "text", text: "正文" });
		// kind="dynamic" 不抑制 @全体(维持 feature 决定的旧行为)
		expect(opts).toBeUndefined();
	});

	it("livePushLike.broadcastSequenceToTargets → feature 映射 + allowAtAll(开播=3)", async () => {
		const c = setup();
		active = c;
		const seq = H.live[0].opts.push.broadcastSequenceToTargets;
		expect(seq).toBeDefined();
		const msg1 = standaloneContentBuilder.message([
			standaloneContentBuilder.image(Buffer.from("img"), "image/jpeg"),
		]);
		const msg2 = standaloneContentBuilder.message([standaloneContentBuilder.text("开播文案")]);
		await seq("1", [msg1, msg2], 3);
		expect(H.push[0].broadcastToFeature).toHaveBeenCalledTimes(1);
		const [uid, feature, payloads, opts] = H.push[0].broadcastToFeature.mock.calls[0];
		expect(uid).toBe("1");
		expect(feature).toBe("live");
		expect(payloads).toHaveLength(2);
		expect(payloads[0].kind).toBe("image");
		expect(payloads[1]).toEqual({ kind: "text", text: "开播文案" });
		expect(opts).toEqual({ allowAtAll: true });
	});

	it("回归镜像:只改全局 messageLayout → live.applyOps 与 dynamic.applyOps 都收到刷新", () => {
		const sub = makeEmptySubscription({ id: "sub-1", uid: "1" });
		const c = setup({ subs: [sub] });
		active = c;
		H.dynamic[0].applyOps.mockClear();
		H.live[0].applyOps.mockClear();
		patchGlobals(c, (g) => {
			const block = g.defaults.messageLayout.dynamic.blocks.find((b) => b.type === "link");
			expect(block).toBeDefined();
			if (block) block.visible = false;
		});
		c.bus.emit("config-changed", "globals");

		const liveOps = H.live[0].applyOps.mock.calls.at(-1)?.[0];
		expect(liveOps).toHaveLength(1);
		expect(liveOps[0]).toMatchObject({ type: "update", uid: "1" });
		// live 的 update change 带上 messageLayout(live 切片)
		expect(liveOps[0].changes[0].messageLayout).toEqual(
			c.configStore.getGlobals().defaults.messageLayout.live,
		);

		expect(H.dynamic[0].applyOps).toHaveBeenCalledTimes(1);
		const dynOps = H.dynamic[0].applyOps.mock.calls.at(-1)?.[0];
		expect(dynOps[0]).toMatchObject({ type: "update", uid: "1" });
	});
});
