/**
 * 订阅源那一口(ADR-0019 决策 9–11 / 52):拓展注册一个订阅源、宿主经它的解析门问「这是哪个人」,
 * 拓展读自己名下的订阅。
 *
 * 钉在装载器这一层(`loadExtensions()`),用一个装进装载根的 v2 小拓展 —— 注册口、清单核对、
 * 解析门的超时 / 报错 / 形状校验、订阅的现读与变更通知,全是真的那一段。
 *
 * 每一格都带着一条**宿主不信拓展的自述**的规矩:
 * - 注册的口必须是清单 `contributes` 开了的口(同推送源);
 * - 拓展交回来的候选宿主先核形状,不合规矩的说清哪儿不合(不吞原因);
 * - 拓展只读得到**自己名下**的订阅 —— 归属是宿主从 ctx 认的,不由它说。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Disposable, Logger, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createAdapterRegistry } from "../../platforms/registry.js";
import type { ExtensionContext } from "../context.js";
import { type LoadedExtensions, loadExtensions } from "../loader.js";
import { createExtensionMounts } from "../mount.js";
import { createExtensionUpgrades } from "../upgrade.js";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bn-ext-sub-source-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const SUBSCRIPTION = {
	display: { label: "抖音", shortLabel: "抖", color: "#fe2c55" },
	events: ["post", "liveStart", "liveEnd"],
};

/**
 * 手放一份拓展进装载根(默认 v2,`contributes` 照给的写;给 `manifest` 就整份照它)。代码由
 * `importModule` 换进来,盘上那份只为了让它被扫出来。
 */
async function plant(
	id: string,
	contributes: Record<string, unknown>,
	manifest?: Record<string, unknown>,
): Promise<void> {
	const dir = join(root, id);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "extension.json"),
		JSON.stringify(
			manifest ?? {
				id,
				name: `${id} 拓展`,
				description: "测试用",
				version: "0.1.0",
				apiVersion: 2,
				contributes,
			},
		),
	);
	await writeFile(join(dir, "index.mjs"), "export function activate() {}");
}

interface SubscriptionRow {
	id: string;
	extensionId: string;
	externalId: string;
	enabled: boolean;
}

/**
 * 起一个真装载器。`activate` 按 id 分给每个拓展(换掉 import 那一步:这里要钉的是注册口与解析门,
 * 不是 ESM 的模块缓存)。订阅表与它的变更通知由测试手上握着。
 */
async function boot(
	activate: Record<string, (ctx: ExtensionContext) => void | Promise<void>>,
	opts: { enabled?: (id: string) => boolean; subscriptions?: SubscriptionRow[] } = {},
) {
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
	};
	let rows = opts.subscriptions ?? [];
	const listeners = new Set<() => void>();
	const enabled = opts.enabled ?? (() => true);
	const loaded: LoadedExtensions = await loadExtensions({
		root,
		host,
		mounts: createExtensionMounts(),
		adapters: createAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		subscriptions: () => rows,
		onSubscriptionsChanged: (fn): Disposable => {
			listeners.add(fn);
			return { dispose: () => listeners.delete(fn) };
		},
		settings: () => undefined,
		onSettingsChanged: () => ({ dispose() {} }),
		inbound: {},
		upgrades: createExtensionUpgrades(),
		isEnabled: enabled,
		maxFailures: 3,
		importModule: async (specifier) => {
			const id = Object.keys(activate).find((key) => specifier.includes(`/${key}/`));
			const fn = id ? activate[id] : undefined;
			if (!fn) throw new Error(`测试没给 ${specifier} 准备 activate`);
			return { activate: fn };
		},
	});
	return {
		loaded,
		lines,
		/** 订阅表换了一份,并照宿主那样喊一声「动过了」。 */
		setSubscriptions(next: SubscriptionRow[]) {
			rows = next;
			for (const fn of [...listeners]) fn();
		},
		listenerCount: () => listeners.size,
	};
}

const CANDIDATE = { id: "MS4wLjABAAAA-x", name: "抖音作者", fans: 12 };

/** 一枚最小的图片 data URL(1×1 PNG)。 */
const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("注册订阅源", () => {
	it("清单开了订阅那一口 → 注册得上,解析门把主人粘的原话交给拓展、候选原样交回", async () => {
		await plant("douyin", { subscription: SUBSCRIPTION });
		const seen: Array<{ query: string; signal: AbortSignal }> = [];
		const { loaded } = await boot({
			douyin(ctx) {
				ctx.registerSubscriptionSource({
					lookup(query, signal) {
						seen.push({ query, signal });
						return [CANDIDATE];
					},
				});
			},
		});
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([["douyin", "running"]]);
		expect(await loaded.lookup("douyin", "https://v.douyin.com/abc/")).toEqual({
			ok: true,
			candidates: [CANDIDATE],
		});
		expect(seen.map((s) => s.query)).toEqual(["https://v.douyin.com/abc/"]);
		expect(seen[0]?.signal.aborted).toBe(false);
	});

	it("清单只开了推送那一口 → 注册订阅源当场抛、点名 contributes.subscription;解析门问不到", async () => {
		await plant("bridge", { push: { display: SUBSCRIPTION.display } });
		const { loaded } = await boot({
			bridge(ctx) {
				ctx.registerSubscriptionSource({ lookup: () => [CANDIDATE] });
			},
		});
		const entry = loaded.list()[0];
		expect(entry?.state).toBe("failed");
		expect(entry?.detail).toContain("contributes.subscription");
		expect(await loaded.lookup("bridge", "x")).toBeUndefined();
	});

	/** v1 的契约里没有订阅源这一口 —— 老格式的 `provides` 里写着 subscription 也注册不了。 */
	it("v1 清单(provides 写着 subscription)→ 注册当场抛,说清只有 v2 开得了", async () => {
		await plant(
			"douyin",
			{},
			{
				id: "douyin",
				name: "抖音订阅",
				description: "测试用",
				version: "0.0.1",
				apiVersion: 1,
				provides: ["subscription"],
			},
		);
		const { loaded } = await boot({
			douyin(ctx) {
				ctx.registerSubscriptionSource({ lookup: () => [CANDIDATE] });
			},
		});
		expect(loaded.list()[0]?.state).toBe("failed");
		expect(loaded.list()[0]?.detail).toContain("v2");
	});

	it("注册两次 → 第二次抛;解析门还是第一次那一个(一个拓展就是一个平台)", async () => {
		await plant("douyin", { subscription: SUBSCRIPTION });
		let second: unknown;
		const { loaded } = await boot({
			douyin(ctx) {
				ctx.registerSubscriptionSource({ lookup: () => [] });
				try {
					ctx.registerSubscriptionSource({ lookup: () => [CANDIDATE] });
				} catch (err) {
					second = err;
				}
			},
		});
		expect((second as Error | undefined)?.message).toMatch(
			/already registered a subscription source/,
		);
		expect(await loaded.lookup("douyin", "x")).toEqual({ ok: true, candidates: [] });
	});

	it("没交解析门(第三方 JS 不受类型约束)→ 注册当场抛,不等到每次查询都炸成「不是函数」", async () => {
		await plant("douyin", { subscription: SUBSCRIPTION });
		const { loaded } = await boot({
			douyin(ctx) {
				ctx.registerSubscriptionSource({} as never);
			},
		});
		expect(loaded.list()[0]?.state).toBe("failed");
		expect(loaded.list()[0]?.detail).toContain("lookup");
	});
});

describe("解析门", () => {
	it("没在跑 / 不是订阅源 / 没装 → undefined(路由回 404),不是一张空候选", async () => {
		await plant("douyin", { subscription: SUBSCRIPTION });
		await plant("bridge", { push: { display: SUBSCRIPTION.display } });
		const { loaded } = await boot(
			{
				douyin(ctx) {
					ctx.registerSubscriptionSource({ lookup: () => [CANDIDATE] });
				},
				bridge() {},
			},
			{ enabled: (id) => id === "bridge" },
		);
		expect(loaded.list().map((e) => [e.id, e.state])).toEqual([
			["bridge", "running"],
			["douyin", "disabled"],
		]);
		expect(await loaded.lookup("douyin", "x")).toBeUndefined();
		expect(await loaded.lookup("bridge", "x")).toBeUndefined();
		expect(await loaded.lookup("nope", "x")).toBeUndefined();
	});

	it("头像是 png / jpeg / webp 的 data URL、带粉丝数 —— 原样交回", async () => {
		await plant("douyin", { subscription: SUBSCRIPTION });
		const candidates = [
			{ id: "a", name: "甲", avatar: PNG, fans: 0 },
			{ id: "b", name: "乙", avatar: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" },
			{ id: "c", name: "丙", avatar: "data:image/webp;base64,UklGRg==", fans: 1_000_000 },
		];
		const { loaded } = await boot({
			douyin(ctx) {
				ctx.registerSubscriptionSource({ lookup: async () => candidates });
			},
		});
		expect(await loaded.lookup("douyin", "x")).toEqual({ ok: true, candidates });
	});

	it("拓展抛了(同步或异步)→ failed,带它的原话", async () => {
		await plant("douyin", { subscription: SUBSCRIPTION });
		const { loaded } = await boot({
			douyin(ctx) {
				ctx.registerSubscriptionSource({
					lookup(query) {
						if (query === "sync") throw new Error("cookie 过期了");
						return Promise.reject(new Error("抖音网关回了 403"));
					},
				});
			},
		});
		expect(await loaded.lookup("douyin", "sync")).toEqual({
			ok: false,
			reason: "failed",
			message: "cookie 过期了",
		});
		expect(await loaded.lookup("douyin", "async")).toEqual({
			ok: false,
			reason: "failed",
			message: "抖音网关回了 403",
		});
	});

	/**
	 * 超时那一刻宿主已经不等了(面板那头是一句「超时」),它还接着问平台只是白挨风控 —— 所以 signal
	 * 当场中止,`reason` 是 `TimeoutError`(`AbortSignal.timeout()` 那个名字,拓展照惯例认得)。
	 */
	it("超时 → timeout;交给它的 signal 当场中止(TimeoutError),之前没中止", async () => {
		await plant("douyin", { subscription: SUBSCRIPTION });
		let seen: AbortSignal | undefined;
		const { loaded } = await boot({
			douyin(ctx) {
				ctx.registerSubscriptionSource({
					lookup(_query, signal) {
						seen = signal;
						return new Promise(() => {});
					},
				});
			},
		});
		const pending = loaded.lookup("douyin", "x", { timeoutMs: 20 });
		if (!seen) throw new Error("解析门应该当场被叫到,并拿到一个 signal");
		expect(seen.aborted).toBe(false);
		expect(await pending).toEqual({ ok: false, reason: "timeout" });
		expect(seen.aborted).toBe(true);
		expect((seen.reason as Error).name).toBe("TimeoutError");
	});

	/**
	 * 🔴 **不挡并发**(决策 52):与动作不同,查询没有「在跑时再按回 409」—— 主人一边打字一边查,
	 * 慢的那一发不该把后面的挡在门外。
	 */
	it("一发还没回来,另一发照样问得到;各回各的", async () => {
		await plant("douyin", { subscription: SUBSCRIPTION });
		let release: (() => void) | undefined;
		const { loaded } = await boot({
			douyin(ctx) {
				ctx.registerSubscriptionSource({
					lookup(query) {
						if (query !== "慢") return [];
						return new Promise((resolve) => {
							release = () => resolve([CANDIDATE]);
						});
					},
				});
			},
		});
		const slow = loaded.lookup("douyin", "慢");
		expect(await loaded.lookup("douyin", "快")).toEqual({ ok: true, candidates: [] });
		release?.();
		expect(await slow).toEqual({ ok: true, candidates: [CANDIDATE] });
	});

	/** 停用 / 收摊时还在跑的解析一并叫停(AbortError);之后再问就是「没在跑」。 */
	it("拓展停用 → 在跑的那一发 signal 中止(AbortError);之后再问是 undefined", async () => {
		await plant("douyin", { subscription: SUBSCRIPTION });
		let on = true;
		let seen: AbortSignal | undefined;
		const h = await boot(
			{
				douyin(ctx) {
					ctx.registerSubscriptionSource({
						lookup(_query, signal) {
							seen = signal;
							return new Promise((_resolve, reject) => {
								signal.addEventListener("abort", () => reject(signal.reason));
							});
						},
					});
				},
			},
			{ enabled: () => on },
		);
		const pending = h.loaded.lookup("douyin", "x");
		if (!seen) throw new Error("解析门应该当场被叫到,并拿到一个 signal");
		expect(seen.aborted).toBe(false);
		on = false;
		await h.loaded.sync();
		expect(seen.aborted).toBe(true);
		expect((seen.reason as Error).name).toBe("AbortError");
		// 它听了 signal 抛出来 —— 那一发照常收到它的原话,不会挂到超时。
		expect(await pending).toMatchObject({ ok: false, reason: "failed" });
		expect(await h.loaded.lookup("douyin", "x")).toBeUndefined();
	});

	/**
	 * 交回来的候选宿主**先核形状**(决策 52)。不合规矩的回 invalid,**点名哪一条、哪一格、为什么** ——
	 * 吞成一句「出错了」的话,拓展作者只能对着黑盒猜。
	 */
	it.each<[string, unknown, string]>([
		["不是数组", { id: "a", name: "甲" }, "(根)"],
		[
			"超过 20 条",
			Array.from({ length: 21 }, (_, i) => ({ id: `u${i}`, name: `第${i}个` })),
			"候选最多 20 条",
		],
		["名字是空串", [{ id: "a", name: "" }], "0.name: 名字不能是空串"],
		["名字超过 128 字", [{ id: "a", name: "名".repeat(129) }], "0.name: 名字不能超过 128 字"],
		["id 是空串", [{ id: "", name: "甲" }], "0.id: id 不能是空串"],
		["id 超过 256 字", [{ id: "x".repeat(257), name: "甲" }], "0.id: id 不能超过 256 字"],
		[
			"同一个 id 出现两次",
			[
				{ id: "a", name: "甲" },
				{ id: "a", name: "乙" },
			],
			'1.id: id "a" 出现了两次',
		],
		["粉丝数是负的", [{ id: "a", name: "甲", fans: -1 }], "0.fans: 粉丝数不能是负的"],
		["粉丝数不是整数", [{ id: "a", name: "甲", fans: 1.5 }], "0.fans: 粉丝数要是整数"],
		[
			"头像是 SVG",
			[{ id: "a", name: "甲", avatar: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }],
			"0.avatar: 头像只收 png / jpeg / webp",
		],
		[
			"头像是 http 地址",
			[{ id: "a", name: "甲", avatar: "https://p3.douyinpic.com/a.jpeg" }],
			"0.avatar: 头像只收 png / jpeg / webp",
		],
		[
			"头像超过 128 KiB",
			[{ id: "a", name: "甲", avatar: `data:image/png;base64,${"A".repeat(128 * 1024)}` }],
			"0.avatar: 头像不能超过 128 KiB",
		],
		["多一个键", [{ id: "a", name: "甲", url: "https://www.douyin.com/user/a" }], "url"],
	])("%s → invalid,说清哪儿不对", async (_label, payload, why) => {
		await plant("douyin", { subscription: SUBSCRIPTION });
		const { loaded, lines } = await boot({
			douyin(ctx) {
				ctx.registerSubscriptionSource({ lookup: () => payload as never });
			},
		});
		const outcome = await loaded.lookup("douyin", "x");
		expect(outcome).toMatchObject({ ok: false, reason: "invalid" });
		expect(outcome?.ok === false && "message" in outcome ? outcome.message : "").toContain(why);
		// 日志里也有一行 —— 面板那一句关掉了,还查得到。
		expect(lines.some((line) => line.startsWith("warn") && line.includes(why))).toBe(true);
	});
});

describe("读自己名下的订阅", () => {
	const ROWS = [
		// 宿主那头的一行比这宽(名字、路由……),只该交出去三格。
		{ id: "s1", extensionId: "douyin", externalId: "MS4-a", enabled: true, name: "甲", uid: 0 },
		{ id: "s2", extensionId: "douyin", externalId: "MS4-b", enabled: false, name: "乙", uid: 0 },
		{ id: "s3", extensionId: "kuaishou", externalId: "MS4-a", enabled: true, name: "丙", uid: 0 },
	];

	it("只给自己的、停用的也给、只给 id / externalId / enabled 三格;现读", async () => {
		await plant("douyin", { subscription: SUBSCRIPTION });
		let handle: ReturnType<ExtensionContext["registerSubscriptionSource"]> | undefined;
		const h = await boot(
			{
				douyin(ctx) {
					handle = ctx.registerSubscriptionSource({ lookup: () => [] });
				},
			},
			{ subscriptions: ROWS },
		);
		expect(handle?.subscriptions()).toEqual([
			{ id: "s1", externalId: "MS4-a", enabled: true },
			{ id: "s2", externalId: "MS4-b", enabled: false },
		]);
		h.setSubscriptions([ROWS[2] as SubscriptionRow]);
		expect(handle?.subscriptions()).toEqual([]);
	});

	it("订阅动过了 → 通知叫得到;拓展停用之后摘掉、不再叫", async () => {
		await plant("douyin", { subscription: SUBSCRIPTION });
		let on = true;
		let calls = 0;
		const h = await boot(
			{
				douyin(ctx) {
					ctx.registerSubscriptionSource({ lookup: () => [] }).onSubscriptionsChanged(() => {
						calls += 1;
					});
				},
			},
			{ enabled: () => on },
		);
		expect(h.listenerCount()).toBe(1);
		h.setSubscriptions(ROWS);
		expect(calls).toBe(1);

		on = false;
		await h.loaded.sync();
		expect(h.listenerCount()).toBe(0);
		h.setSubscriptions([]);
		expect(calls).toBe(1);
	});
});
