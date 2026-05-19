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

import type { GlobalConfig } from "@bilibili-notify/internal";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStore } from "../../config/store.js";
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
	DynamicEngine: class {
		opts: any;
		start = vi.fn();
		stop = vi.fn();
		updateConfig = vi.fn();
		setAi = vi.fn();
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
const { createEngines, liveTypeToFeature, liveTypeAllowsAtAll } = await import("../engines.js");

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

function setup(opts?: { globals?: GlobalConfig; puppeteer?: boolean }): Ctx {
	const serviceCtx = makeServiceCtx();
	const configStore = makeConfigStore(opts?.globals ?? makeDefaultGlobalConfig());
	const api = { setUserAgent: vi.fn() };
	const loginFlow = { setHealthCheckMs: vi.fn() };
	const bus = createNodeMessageBus();
	const runtime = createEngines({
		serviceCtx: serviceCtx as unknown as NodeServiceContext,
		api: api as any,
		loginFlow: loginFlow as any,
		configStore: configStore as unknown as ConfigStore,
		historyStore: { append: vi.fn(async () => {}) } as any,
		subscriptionStore: { list: () => [], findByUid: () => undefined } as any,
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

	it("puppeteer 在位:构造 ImageRenderer 并 start", () => {
		const c = setup({ puppeteer: true });
		active = c;
		expect(H.image).toHaveLength(1);
		expect(H.image[0].start).toHaveBeenCalledTimes(1);
	});
});

describe("createEngines — config-changed globals 热重载", () => {
	it("一次 globals 变更同步热推 dynamic/live/level/UA/health/master", () => {
		const c = setup();
		active = c;
		patchGlobals(c, (g) => {
			g.app.dynamicCron = "*/9 * * * *";
			g.app.healthCheckMinutes = 45;
		});
		c.bus.emit("config-changed", "globals");

		expect(H.dynamic[0].updateConfig).toHaveBeenCalledTimes(1);
		expect(H.live[0].updateConfig).toHaveBeenCalledTimes(1);
		// boot 1 次 + globals 1 次 = 2。
		expect(c.serviceCtx.setLevel).toHaveBeenCalledTimes(2);
		// boot 1 次 + globals 1 次 = 2。
		expect(c.api.setUserAgent).toHaveBeenCalledTimes(2);
		expect(c.loginFlow.setHealthCheckMs).toHaveBeenCalledWith(45 * 60_000);
		expect(H.push[0].setMaster).toHaveBeenCalledTimes(1);
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
