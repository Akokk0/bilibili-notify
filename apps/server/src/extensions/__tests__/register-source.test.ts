/**
 * `ctx.registerSource(def)`(第 3 版订阅源的注册口):宿主这一侧的规矩。
 *
 * 钉在 `createExtensionContext` 上,宿主注入的「登进来源登记表」换成一个记账的替身(真的那个是推送链路的
 * `registerSource`,从真入口的接线钉在 `__tests__/extension-source-e2e.test.ts`)。每一格都带着一条
 * **宿主不信拓展的自述**的规矩:
 *
 * - 注册的口必须是清单开了的口;一个拓展只登一次;`start` / `stop` / `searchCreators` 缺一不可;
 * - 登记是异步的、把手同步交回;`start` 抛了,登记落定回失败(装载器据此判这次加载失败);
 * - 来源键是拓展 id、被拒的问题上报记 warn —— 归属与等级是宿主的判断,拓展说了不算;
 * - 收摊:撤登记(拓展的 `stop` 先于 `ctx.signal` 中止),登记途中收摊的当场撤。
 */

import type {
	Disposable,
	ExtensionManifest,
	Logger,
	PostReport,
	ServiceContext,
	SourceContext,
} from "@bilibili-notify/internal";
import type { ExtensionSourceContext, SourceDef } from "@bilibili-notify/internal/extension";
import { describe, expect, it } from "vite-plus/test";
import { noExtensionI18n } from "../../__tests__/support/extension-locales.js";
import { ignoredProblems } from "../../__tests__/support/ignored-problems.js";
import { integrationIo } from "../../__tests__/support/integration-io.js";
import { memoryStores } from "../../__tests__/support/memory-key-value-store.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import type { PipelineRuntime } from "../../runtime/pipeline.js";
import {
	type CreateExtensionContextOptions,
	createExtensionContext,
	type ReportDiscrepancy,
} from "../context.js";
import { createExtensionMounts } from "../mount.js";
import { createExtensionUpgrades } from "../upgrade.js";

const SOURCE_MANIFEST: ExtensionManifest = {
	id: "douyin",
	name: "抖音拓展",
	description: "测试用",
	version: "1.0.0",
	apiVersion: 3,
	contributes: {
		subscription: {
			label: "抖音",
			shortLabel: "抖",
			color: "#fe2c55",
			supportedFeatures: ["post", "liveStart", "liveStreaming", "liveEnd"],
		},
	},
};

const PUSH_ONLY_MANIFEST: ExtensionManifest = {
	id: "douyin",
	name: "抖音拓展",
	description: "测试用",
	version: "1.0.0",
	apiVersion: 3,
	contributes: { push: { label: "抖", shortLabel: "抖", color: "#fe2c55" } },
};

function sourceManifest(
	supportedFeatures: readonly ("post" | "liveStart" | "liveStreaming" | "liveEnd")[],
): ExtensionManifest {
	return {
		id: "douyin",
		name: "抖音拓展",
		description: "测试用",
		version: "1.0.0",
		apiVersion: 3,
		contributes: {
			subscription: {
				label: "抖音",
				supportedFeatures,
			},
		},
	} as unknown as ExtensionManifest;
}

type RegisterEntry = Parameters<PipelineRuntime["registerSource"]>[0];

function harness(
	opts: {
		manifest?: ExtensionManifest;
		/** 登记表那头:不给 = 立刻成功(调 `source.start` 之后交回把手)。 */
		host?: (entry: RegisterEntry, record: HostRecord) => Promise<Disposable>;
		withoutHost?: boolean;
	} = {},
) {
	const lines: string[] = [];
	const logger: Logger = {
		info: (m) => lines.push(`info ${m}`),
		warn: (m) => lines.push(`warn ${m}`),
		error: (m) => lines.push(`error ${m}`),
		debug: (m) => lines.push(`debug ${m}`),
	};
	const host = {
		logger,
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose() {},
	} as unknown as ServiceContext;
	const record: HostRecord = { entries: [], disposed: 0, posts: [], started: [] };
	const discrepancies: ReportDiscrepancy[] = [];
	const rows = [
		{ id: "sub-1", extensionId: "douyin", externalId: "u1", enabled: true },
		{ id: "sub-2", extensionId: "douyin", externalId: "u1", enabled: false },
		{ id: "sub-3", extensionId: "other", externalId: "u1", enabled: true },
	];
	const registerSource: CreateExtensionContextOptions["registerSource"] = opts.withoutHost
		? undefined
		: async (entry) => {
				record.entries.push(entry);
				if (opts.host) return opts.host(entry, record);
				return defaultHost(entry, record);
			};
	const runtime = createExtensionContext({
		...integrationIo(),
		...noExtensionI18n(),
		id: "douyin",
		manifest: opts.manifest ?? SOURCE_MANIFEST,
		host,
		loggerOf: () => logger,
		stores: { ...memoryStores(), redact() {} },
		problems: ignoredProblems,
		mounts: createExtensionMounts({ logger: silentLogger }),
		adapters: createPlatformAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		subscriptionIdsOf: ({ sourceKey, externalId }) =>
			rows
				.filter((row) => row.extensionId === sourceKey && row.externalId === externalId)
				.map((row) => row.id),
		onReportDiscrepancy: (discrepancy) => discrepancies.push(discrepancy),
		settings: () => undefined,
		onSettingsChanged: () => ({ dispose() {} }),
		upgrades: createExtensionUpgrades(),
		inbound: {},
		...(registerSource ? { registerSource } : {}),
		fallbackCreatorName: (identity) => `资料名-${identity.sourceKey}-${identity.externalId}`,
	});
	return { runtime, ctx: runtime.ctx, lines, record, discrepancies };
}

interface HostRecord {
	entries: RegisterEntry[];
	disposed: number;
	/** 来源 `start` 之后核心那一份 ctx 收到的作品。 */
	posts: Array<[string, PostReport]>;
	/** 每次 `source.start` 时拓展 `stop` 之外的记账:`stop` 被叫时 `signal` 是不是已经中止。 */
	started: string[];
}

/** 推送链路那头的替身:登记即 `start`(核心 ctx 换成只记作品的),撤登记叫来源的 `stop`,幂等。 */
async function defaultHost(entry: RegisterEntry, record: HostRecord): Promise<Disposable> {
	const core = {
		logger: entry.logger,
		signal: entry.integration.signal,
		onDispose() {},
		reportPost: (externalId: string, report: PostReport) => record.posts.push([externalId, report]),
		reportLive() {},
		reportProfile() {},
	} as unknown as SourceContext;
	await entry.source.start(core);
	let removed = false;
	return {
		dispose() {
			if (removed) return;
			removed = true;
			record.disposed += 1;
			void entry.source.stop();
		},
	};
}

function def(over: Partial<SourceDef> = {}): SourceDef {
	return {
		start() {},
		stop() {},
		searchCreators: async () => ({ ok: true, candidates: [] }),
		// 夹具清单声明了开播 + 下播,登记时核要交(见「没交 fetchLiveStatus」那条)。
		fetchLiveStatus: async () => ({ ok: true, kind: "offline" }),
		...over,
	};
}

describe("ctx.registerSource:登记前的规矩", () => {
	it("清单没开 contributes.subscription:抛,而且不往登记表交", () => {
		const h = harness({ manifest: PUSH_ONLY_MANIFEST });
		expect(() => h.ctx.registerSource(def())).toThrow(/contributes\.subscription/);
		expect(h.record.entries).toEqual([]);
	});

	it("一个拓展只登一次:再登抛", () => {
		const h = harness();
		h.ctx.registerSource(def());
		expect(() => h.ctx.registerSource(def())).toThrow(/already registered a source/);
		expect(h.record.entries).toHaveLength(1);
	});

	it.each(["start", "stop", "searchCreators"] as const)(
		"没交 %s(第三方 JS 不受类型约束):当场抛,不往登记表交",
		(member) => {
			const h = harness();
			const broken = { ...def(), [member]: undefined } as unknown as SourceDef;
			expect(() => h.ctx.registerSource(broken)).toThrow(new RegExp(member));
			expect(h.record.entries).toEqual([]);
		},
	);

	it("清单声明了开播 + 下播却没交 fetchLiveStatus:当场抛(点名它),不往登记表交", () => {
		const h = harness();
		expect(() => h.ctx.registerSource(def({ fetchLiveStatus: undefined }))).toThrow(
			/fetchLiveStatus/,
		);
		expect(h.record.entries).toEqual([]);
	});

	it("清单只声明了开播:没交 fetchLiveStatus 照常登", () => {
		const h = harness({
			manifest: {
				...SOURCE_MANIFEST,
				contributes: {
					subscription: {
						label: "抖音",
						shortLabel: "抖",
						color: "#fe2c55",
						supportedFeatures: ["post", "liveStart"],
					},
				},
			},
		});
		h.ctx.registerSource(def({ fetchLiveStatus: undefined }));
		expect(h.record.entries).toHaveLength(1);
	});

	it("只在 supportedFeatures 声明 liveStreaming 才要求 fetchLiveStatus", () => {
		const periodic = harness({
			manifest: sourceManifest(["post", "liveStart", "liveStreaming", "liveEnd"]),
		});
		expect(() => periodic.ctx.registerSource(def({ fetchLiveStatus: undefined }))).toThrow(
			/fetchLiveStatus/,
		);

		const eventOnly = harness({ manifest: sourceManifest(["post", "liveStart", "liveEnd"]) });
		expect(() => eventOnly.ctx.registerSource(def({ fetchLiveStatus: undefined }))).not.toThrow();
		expect(eventOnly.record.entries).toHaveLength(1);
	});

	it("宿主没接来源登记表:抛(写清是宿主没接,而不是拓展写错)", () => {
		const h = harness({ withoutHost: true });
		expect(() => h.ctx.registerSource(def())).toThrow(/source registry/);
	});

	it("收摊之后再登:拒(抛 already unloaded),不往登记表交", async () => {
		const h = harness();
		await h.runtime.dispose();
		expect(() => h.ctx.registerSource(def())).toThrow(/already unloaded/);
		expect(h.record.entries).toEqual([]);
	});
});

describe("ctx.registerSource:登记", () => {
	it("来源键是拓展 id,集成上下文是这个拓展的,被拒的问题上报记 warn,平台名取清单", async () => {
		const h = harness();
		h.ctx.registerSource(def());
		const entry = h.record.entries[0];
		expect(entry?.sourceKey).toBe("douyin");
		expect(entry?.rejectedProblemLevel).toBe("warn");
		expect(entry?.integration.signal).toBe(h.ctx.signal);
		expect(entry?.logger).toBe(h.ctx.logger);
		expect(entry?.source.descriptor.label).toBe("抖音");
	});

	it("登记项带清单名当写者名(报问题那一刻现取,与集成上下文同一个函数)", () => {
		const h = harness();
		h.ctx.registerSource(def());
		expect(h.record.entries[0]?.label?.()).toBe("抖音拓展");
	});

	it("同步交回把手,登记在后台落定:落定前 registrationsSettled 还没回,落定后回成功", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness({
			host: async (entry, record) => {
				await gate;
				return defaultHost(entry, record);
			},
		});
		const handle = h.ctx.registerSource(def());
		expect(typeof handle.dispose).toBe("function");
		let settled = false;
		const registration = h.runtime.registrationsSettled().then((result) => {
			settled = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		release();
		expect(await registration).toEqual({ ok: true });
	});

	it("没登记过 registrationsSettled 回成功(没有来源要等)", async () => {
		const h = harness();
		expect(await h.runtime.registrationsSettled()).toEqual({ ok: true });
	});

	it("拓展的 start 抛了:登记落定回失败,原话带着(装载器据此判这次加载失败)", async () => {
		const h = harness({
			host: async () => {
				throw new Error("连不上平台");
			},
		});
		h.ctx.registerSource(def());
		const result = await h.runtime.registrationsSettled();
		expect(result).toMatchObject({ ok: false });
		expect(result.ok ? "" : result.message).toContain("连不上平台");
	});

	it("登记走真的适配:拓展的 start 在登记里被叫,拿到的 ctx 上的作品报到核心那一份", async () => {
		let handed: ExtensionSourceContext | undefined;
		const h = harness();
		h.ctx.registerSource(
			def({
				start(ctx) {
					handed = ctx;
				},
			}),
		);
		await h.runtime.registrationsSettled();
		handed?.reportPost("u1", {
			postId: "p1",
			url: "https://douyin.invalid/p1",
			post: { publishedAt: "2026-09-23T12:00:00.000Z", text: "x" },
		});
		// 上报排在来源自己的串行队里(翻作品要读图库),等一拍。
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(h.record.posts).toHaveLength(1);
		// 作者名缺了:宿主注入的补名字口(资料名 → 身份标签),身份是 (拓展 id, 外部 id)。
		expect(h.record.posts[0]?.[1].post.creator.name).toBe("资料名-douyin-u1");
	});
});

describe("ctx.registerSource:上报出入", () => {
	it("整条拒了:记进上报出入(种类 live 也认),带上它名下指向这个人的订阅(停用的也算,别家的不算),并打 warn", async () => {
		let handed: ExtensionSourceContext | undefined;
		const h = harness();
		h.ctx.registerSource(
			def({
				start(ctx) {
					handed = ctx;
				},
			}),
		);
		await h.runtime.registrationsSettled();
		handed?.reportLive("u1", { kind: "pause" } as never);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(h.discrepancies).toHaveLength(1);
		expect(h.discrepancies[0]).toMatchObject({
			extensionId: "douyin",
			kind: "live",
			externalId: "u1",
			outcome: "rejected",
			subscriptionIds: ["sub-1", "sub-2"],
		});
		expect(h.lines.some((line) => line.startsWith("warn ") && line.includes("live"))).toBe(true);
	});
});

describe("ctx.registerSource:收摊", () => {
	it("把手的 dispose 撤登记,幂等", async () => {
		const h = harness();
		const handle = h.ctx.registerSource(def());
		await h.runtime.registrationsSettled();
		handle.dispose();
		handle.dispose();
		expect(h.record.disposed).toBe(1);
	});

	it("收摊撤登记:拓展的 stop 先于 ctx.signal 中止(契约:宿主先叫 stop,再中止 signal 并跑收尾钩子)", async () => {
		const abortedAtStop: boolean[] = [];
		const h = harness();
		h.ctx.registerSource(
			def({
				stop() {
					abortedAtStop.push(h.ctx.signal.aborted);
				},
			}),
		);
		await h.runtime.registrationsSettled();
		await h.runtime.dispose();
		expect(abortedAtStop).toEqual([false]);
		expect(h.ctx.signal.aborted).toBe(true);
		expect(h.record.disposed).toBe(1);
	});

	/**
	 * 把手是同步交回的,登记却在后台落定:落定之前拓展调 `dispose()` 也得作数 —— 契约说它幂等,
	 * 而且「调用后来源不再上报」。落定那一刻发现自己早被请求撤了,就当场撤、把 `stop` 叫到。
	 */
	it("登记落定前把手就 dispose:落定后当场撤,stop 被叫一次", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const stops: string[] = [];
		const h = harness({
			host: async (entry, record) => {
				await gate;
				return defaultHost(entry, record);
			},
		});
		const handle = h.ctx.registerSource(def({ stop: () => void stops.push("stop") }));
		handle.dispose();
		release();
		expect(await h.runtime.registrationsSettled()).toEqual({ ok: true });
		expect(h.record.disposed).toBe(1);
		expect(stops).toEqual(["stop"]);
	});

	it("登记途中收摊:登记落定的那一刻当场撤,不留孤儿", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const stops: string[] = [];
		const h = harness({
			host: async (entry, record) => {
				await gate;
				return defaultHost(entry, record);
			},
		});
		h.ctx.registerSource(def({ stop: () => void stops.push("stop") }));
		await h.runtime.dispose();
		release();
		expect(await h.runtime.registrationsSettled()).toEqual({ ok: true });
		expect(h.record.disposed).toBe(1);
		expect(stops).toEqual(["stop"]);
	});
});
