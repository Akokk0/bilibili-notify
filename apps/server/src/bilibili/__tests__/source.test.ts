/**
 * B 站来源:`start(ctx)` 里造并启动动态引擎,`stop()` 里停它。
 *
 * 引擎用真的 `DynamicEngine`(假 `Api`,全程不外连);cron 换成惰性的假件,好数启停与新节奏。
 * 最后一组是「不用假名单」的端到端:真订阅仓 + 真来源上下文 + 真引擎,停用 / 启用 / 改全局作品开关逐个走一遍。
 */

import {
	BILIBILI_GUARD_PROGRAM,
	type IntegrationContext,
	type Logger,
	type PostReport,
	type SourceContext,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { deferred } from "../../__tests__/support/track-context.js";
import {
	makeIntegration,
	makeLogger,
	makeSub,
	makeWorld,
	SOURCE_KEY,
} from "../../subscriptions/__tests__/fixtures.js";
import { registerBuiltinSource } from "../../subscriptions/builtin-sources.js";
import { createSourceRegistry } from "../../subscriptions/registry.js";
import type { Api } from "../api/index.js";
import { type BiliSettings, BiliSettingsSchema } from "../settings.js";
import { createBiliSource } from "../source.js";

const cronMock = vi.hoisted(() => {
	const instances: Array<{
		cronTime: string;
		isActive: boolean;
		startCount: number;
		stopCount: number;
	}> = [];
	class FakeCronJob {
		isActive = false;
		startCount = 0;
		stopCount = 0;
		constructor(
			public cronTime: string,
			public onTick: () => void,
		) {
			instances.push(this);
		}
		start(): void {
			this.isActive = true;
			this.startCount++;
		}
		stop(): void {
			this.isActive = false;
			this.stopCount++;
		}
	}
	return { instances, FakeCronJob };
});
vi.mock("cron", () => ({ CronJob: cronMock.FakeCronJob }));

beforeEach(() => {
	cronMock.instances.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
});

const EMPTY_FEED = {
	code: 0,
	message: "ok",
	data: { has_more: false, items: [] as unknown[], offset: "", update_baseline: "", update_num: 0 },
};

/** 一条文字动态:作者是 `uid`,发布时间是 `pubTs`(秒)。 */
const item = (uid: number, pubTs: number, id = `id-${uid}-${pubTs}`) => ({
	basic: {},
	id_str: id,
	type: "DYNAMIC_TYPE_WORD",
	modules: {
		module_author: {
			face: "",
			following: false,
			jump_url: "",
			label: "",
			mid: uid,
			name: "UP",
			pub_action: "",
			pub_time: "",
			pub_ts: pubTs,
			type: "",
		},
		module_dynamic: {
			desc: { text: "正文", rich_text_nodes: [{ text: "正文", type: "RICH_TEXT_NODE_TYPE_TEXT" }] },
		},
	},
});

/** 配置仓替身:设置可换,换了发一次 `integration-settings`(与真仓一样只交 scope)。 */
function makeConfigStore(initial: Partial<BiliSettings> = {}) {
	let current = BiliSettingsSchema.parse(initial);
	const handlers = new Set<(scope: string) => void>();
	const disposed = vi.fn();
	return {
		store: {
			getIntegrationSettings: () => structuredClone(current),
			onChange: (handler: (scope: string) => void) => {
				handlers.add(handler);
				return {
					dispose() {
						disposed();
						handlers.delete(handler);
					},
				};
			},
		} as never,
		set(patch: Partial<BiliSettings>) {
			current = BiliSettingsSchema.parse({ ...current, ...patch });
			for (const h of [...handlers]) h("integration-settings");
		},
		listeners: () => handlers.size,
		disposed,
	};
}

function makeDeps(over: { cron?: string; fetchAllDynamic?: () => unknown } = {}) {
	const config = makeConfigStore(over.cron ? { dynamicCron: over.cron } : {});
	const fetchImage = vi.fn();
	return {
		config,
		fetchImage,
		deps: {
			api: { fetchAllDynamic: over.fetchAllDynamic ?? (async () => EMPTY_FEED) } as unknown as Api,
			bus: makeWorld().bus,
			push: { sendPrivateMsg: vi.fn(async () => {}) },
			imageFetcher: { fetchImage },
			configStore: config.store,
			setTimeout: () => ({ dispose() {} }),
		},
	};
}

/** 假来源上下文:名单与回调可控,`onSubscriptionsChanged` 的把手记下有没有被摘。 */
function makeCtx(roster: Array<{ externalId: string; post: boolean }> = []) {
	const watchers: Array<() => void> = [];
	const watchDisposed = vi.fn();
	const reportPost = vi.fn<(id: string, report: PostReport) => void>();
	const ctx = {
		logger: makeLogger() as Logger,
		subscriptions: () =>
			roster.map((r) => ({
				externalId: r.externalId,
				features: new Set(r.post ? (["post"] as const) : []),
			})),
		onSubscriptionsChanged: (fn: () => void) => {
			watchers.push(fn);
			return { dispose: watchDisposed };
		},
		reportPost,
	} as unknown as SourceContext;
	return { ctx, watchers, watchDisposed, reportPost };
}

describe("createBiliSource", () => {
	it("描述符的 postNoun 是「动态」", () => {
		expect(createBiliSource(makeDeps().deps).descriptor.postNoun).toBe("动态");
	});

	it("描述符交出大航海这一套会员体系", () => {
		expect(createBiliSource(makeDeps().deps).descriptor.membershipPrograms).toEqual([
			BILIBILI_GUARD_PROGRAM,
		]);
	});

	it("start 后引擎在跑、dynamic() 拿得到;stop 后 dynamic() 是 undefined、两个把手都摘了", async () => {
		const { deps, config } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx, watchDisposed } = makeCtx([{ externalId: "1", post: true }]);
		expect(source.dynamic()).toBeUndefined();
		await source.start(ctx);
		expect(source.dynamic()?.isActive).toBe(true);
		expect(cronMock.instances[0]?.isActive).toBe(true);
		expect(config.listeners()).toBe(1);

		await source.stop();
		expect(source.dynamic()).toBeUndefined();
		expect(cronMock.instances[0]?.isActive).toBe(false);
		expect(watchDisposed).toHaveBeenCalledTimes(1);
		expect(config.disposed).toHaveBeenCalledTimes(1);
		expect(config.listeners()).toBe(0);
	});

	it("stop 的同步段里就停干净(登记表不等它)", () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }]);
		return source.start(ctx).then(() => {
			void source.stop();
			// 没有 await:此刻已经停了。
			expect(source.dynamic()).toBeUndefined();
			expect(cronMock.instances[0]?.isActive).toBe(false);
		});
	});

	it("重复 start 抛", async () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx } = makeCtx();
		await source.start(ctx);
		await expect(source.start(ctx)).rejects.toThrow("already started");
		await source.stop();
	});

	it("名单变了的回调接到引擎:新增一个开着作品的人就起 cron", async () => {
		const { deps } = makeDeps();
		const source = createBiliSource(deps);
		const roster: Array<{ externalId: string; post: boolean }> = [];
		const { ctx, watchers } = makeCtx(roster);
		await source.start(ctx);
		expect(cronMock.instances).toHaveLength(0); // 空名单不起 job
		roster.push({ externalId: "1", post: true });
		for (const w of watchers) w();
		expect(cronMock.instances).toHaveLength(1);
		expect(cronMock.instances[0]?.isActive).toBe(true);
		await source.stop();
	});

	it("初始 cron 取自 B 站设置;cron 变了引擎换节奏,别的设置变了不动", async () => {
		const { deps, config } = makeDeps({ cron: "*/3 * * * *" });
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }]);
		await source.start(ctx);
		expect(cronMock.instances[0]?.cronTime).toBe("*/3 * * * *");

		config.set({ healthCheckMinutes: 45 });
		expect(cronMock.instances).toHaveLength(1);

		config.set({ dynamicCron: "*/9 * * * *" });
		expect(cronMock.instances[0]?.stopCount).toBe(1);
		expect(cronMock.instances).toHaveLength(2);
		expect(cronMock.instances[1]?.cronTime).toBe("*/9 * * * *");
		await source.stop();
	});

	// 验红:去掉 `start` 里 catch 那段清理(`started.stop()`),这条红(cron 一直开着,而登记表不会替来源停它)。
	it("start 半路抛了:来源自己已经把引擎停掉、摘掉已挂上的把手,dynamic() 是 undefined", async () => {
		const { deps, config } = makeDeps();
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }]);
		// 引擎已 start(cron 起来了),再抛:模拟挂名单回调那一步失败。
		(ctx as { onSubscriptionsChanged: unknown }).onSubscriptionsChanged = () => {
			throw new Error("挂回调炸了");
		};
		await expect(source.start(ctx)).rejects.toThrow("挂回调炸了");
		expect(cronMock.instances[0]?.isActive).toBe(false);
		expect(source.dynamic()).toBeUndefined();
		expect(config.listeners()).toBe(0);
		// 能重来
		const fresh = makeCtx([{ externalId: "1", post: true }]);
		await source.start(fresh.ctx);
		expect(source.dynamic()).toBeDefined();
		await source.stop();
	});

	it("来源把 deps.imageFetcher 递给引擎:带图的动态去抓图", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-11T00:00:00Z") });
		const feed = {
			...EMPTY_FEED,
			data: {
				...EMPTY_FEED.data,
				items: [
					{
						...item(1, Math.floor(Date.parse("2026-10-11T00:00:10Z") / 1000)),
						modules: {
							...item(1, 0).modules,
							module_author: {
								...item(1, 0).modules.module_author,
								pub_ts: Math.floor(Date.parse("2026-10-11T00:00:10Z") / 1000),
							},
							module_dynamic: {
								desc: { text: "图", rich_text_nodes: [] },
								major: { opus: { pics: [{ url: "https://i0.hdslb.com/bfs/new_dyn/a.jpg" }] } },
							},
						},
					},
				],
			},
		};
		const { deps, fetchImage } = makeDeps({ fetchAllDynamic: async () => feed });
		fetchImage.mockResolvedValue({ ok: false, code: "unavailable", message: "x" });
		const source = createBiliSource(deps);
		const { ctx } = makeCtx([{ externalId: "1", post: true }]);
		await source.start(ctx);
		vi.setSystemTime(new Date("2026-10-11T00:00:20Z"));
		await source.dynamic()?.detectNow();
		expect(fetchImage).toHaveBeenCalled();
		await source.stop();
	});
});

describe("B 站来源 · 端到端(真订阅仓 + 真来源上下文 + 真动态引擎)", () => {
	const T0 = Date.parse("2026-10-11T00:00:00Z");
	const at = (sec: number) => Math.floor(T0 / 1000) + sec;
	const clock = (sec: number) => vi.setSystemTime(new Date(T0 + sec * 1000));

	async function boot(subs = [makeSub("sub-1", "1")]) {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
		const world = makeWorld(subs);
		let feedItems: unknown[] = [];
		const { deps, fetchImage } = makeDeps({
			fetchAllDynamic: async () => ({
				...EMPTY_FEED,
				data: { ...EMPTY_FEED.data, items: feedItems },
			}),
		});
		const source = createBiliSource({ ...deps, bus: world.bus });
		const enqueue = vi.fn<(event: { subscriptionId: string; postId: string }) => void>();
		const logger = makeLogger();
		const registry = createSourceRegistry();
		const registration = await registerBuiltinSource({
			registry,
			source,
			integration: makeIntegration() as IntegrationContext,
			sourceKey: SOURCE_KEY,
			subscriptions: world.store,
			defaults: () => world.globals.defaults,
			bus: world.bus,
			logger,
			enqueue: enqueue as never,
		});
		const feed = (...items: unknown[]) => {
			feedItems = items;
		};
		const round = async (sec: number, ...items: unknown[]) => {
			feed(...items);
			clock(sec);
			await source.dynamic()?.detectNow();
		};
		return { world, source, registration, enqueue, round, feed, fetchImage, logger };
	}

	it("对照:启用着、作品开关开着,新动态交出去", async () => {
		const { source, enqueue, round } = await boot();
		await round(20, item(1, at(10), "d1"));
		expect(enqueue.mock.calls.map(([e]) => [e.subscriptionId, e.postId])).toEqual([
			["sub-1", "d1"],
		]);
		await source.stop();
	});

	it("停用那条订阅 → 下一轮不交;重新启用 → 交(只交启用之后发的)", async () => {
		const { world, source, enqueue, round } = await boot();
		const sub = world.store.findById("sub-1");
		if (!sub) throw new Error("没有订阅");
		world.store.upsert({ ...sub, enabled: false });
		await round(40, item(1, at(30), "while-off"));
		expect(enqueue).not.toHaveBeenCalled();

		clock(50);
		world.store.upsert({ ...sub, enabled: true });
		// 启用前发的那条:锚点是「启用那一刻」,不交(已定 16)。
		await round(60, item(1, at(45), "before-on"));
		expect(enqueue).not.toHaveBeenCalled();
		await round(80, item(1, at(70), "after-on"));
		expect(enqueue.mock.calls.map(([e]) => e.postId)).toEqual(["after-on"]);
		await source.stop();
	});

	// 生产的形状:没人要动态时 cron 停着,关着期间没有「一轮」可跑,所以这里不手调 detectNow。
	// 验红:去掉 `applyRoster` 里「离开就删锚点」(留着旧锚点),这条与下一条红(关着期间的动态补推出来)。
	it("改全局作品开关 → 关了 cron 停;关着期间的动态,再开不补推,之后新发的照交", async () => {
		const { world, source, enqueue, round, feed } = await boot();
		world.globals.defaults.features.post = false;
		world.bus.emit("config-changed", { scope: "globals" });
		expect(cronMock.instances[0]?.isActive).toBe(false);
		feed(item(1, at(20), "while-off"));
		clock(50);

		world.globals.defaults.features.post = true;
		world.bus.emit("config-changed", { scope: "globals" });
		await round(80, item(1, at(20), "while-off"), item(1, at(70), "after-on"));
		expect(enqueue.mock.calls.map(([e]) => e.postId)).toEqual(["after-on"]);
		await source.stop();
	});

	it("唯一一条订阅关掉作品开关再打开:关着期间的动态不补推,之后新发的照交", async () => {
		const { world, source, enqueue, round, feed } = await boot();
		const sub = world.store.findById("sub-1");
		if (!sub) throw new Error("没有订阅");
		world.store.upsert({ ...sub, overrides: { ...sub.overrides, features: { post: false } } });
		expect(cronMock.instances[0]?.isActive).toBe(false);
		feed(item(1, at(20), "while-off"));
		clock(50);

		world.store.upsert({ ...sub, overrides: { ...sub.overrides, features: { post: true } } });
		await round(80, item(1, at(20), "while-off"), item(1, at(70), "after-on"));
		expect(enqueue.mock.calls.map(([e]) => e.postId)).toEqual(["after-on"]);
		await source.stop();
	});

	it("遗留的重复订阅(同一个 uid 两条、作品开关相反):这个人仍在要推的人里,动态照交", async () => {
		const { source, enqueue, round } = await boot([
			makeSub("sub-1", "1", { overrides: { features: { post: true } } }),
			makeSub("sub-2", "1", { overrides: { features: { post: false } } }),
		]);
		expect(cronMock.instances[0]?.isActive).toBe(true);
		await round(20, item(1, at(10), "d1"));
		expect(enqueue).toHaveBeenCalled();
		await source.stop();
	});

	// 验红:删掉 `DynamicEngine.stop()` 里清表的那句(`this.postAnchors = new Map()`),这条红。
	it("撤销登记时有一轮正卡在抓图:放行之后这条不交,来源上下文也没看到「停下还在上报」", async () => {
		const { source, registration, enqueue, feed, fetchImage, logger } = await boot();
		const gate = deferred<{ ok: false; code: string; message: string }>();
		fetchImage.mockReturnValue(gate.promise);
		const withPic = item(1, at(10), "in-flight");
		feed({
			...withPic,
			modules: {
				...withPic.modules,
				module_dynamic: {
					desc: { text: "图", rich_text_nodes: [] },
					major: { opus: { pics: [{ url: "https://i0.hdslb.com/bfs/new_dyn/a.jpg" }] } },
				},
			},
		});
		clock(20);
		const running = source.dynamic()?.detectNow();
		await vi.waitFor(() => expect(fetchImage).toHaveBeenCalled());

		registration.dispose();
		expect(source.dynamic()).toBeUndefined();
		gate.resolve({ ok: false, code: "unavailable", message: "x" });
		await running;

		expect(enqueue).not.toHaveBeenCalled();
		expect(logger.error.mock.calls.filter(([msg]) => String(msg).includes("已停下"))).toEqual([]);
	});
});
