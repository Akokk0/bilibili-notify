/**
 * 统计的**拓展适配**(`extension-source.ts`,ADR-0020 决策 4 / 5 / 6 / 7 / 8 / 9 / 16 / 17)。
 *
 * 照 bootstrap 那样接一整套:真总线、真统计仓与粉丝仓(临时目录)、记录器、在播表与场次(引擎里建的那一份)。
 * 看的是**盘上**:作品行、直播帧、粉丝样本、「在记」小账的行。
 *
 * - 启用着就记、与推送开关无关;停用的、不认识的一样都不记(停用的资料照收也不记,决策 4);
 * - 作品:带视频 → `video`,其余 → `post`,按发布时刻(决策 5);
 * - 场次跟着 `extension-live-session` 开 / 关,每种结束原因都关;峰值照抄结束帧带的本场累计观看(决策 6 / 7,
 *   怎么算的在场次那边测);BN 重启之后按开播时刻接回同一场,峰值不被后一段拽小;
 * - 粉丝:资料带粉丝数就记,不密过 B 站那边的粉丝轮询(决策 8);
 * - 「在记」小账(ADR-0027 决策 2 / 13):这个小时收到过任何上报 = 来源在跑,按作品 / 直播开关记当前整点小时;
 *   资料带粉丝数记粉丝;同一小时同一项只一行,重启后也不重复;开关关着不落作品行、不开新场次;
 * - 删订阅四份文件全删,停用留着。
 */

import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	makeEmptySubscription,
	type Subscription,
	type SubscriptionReport,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { createFollowersStore, FOLLOWERS_DIR } from "../../followers/store.js";
import { createExtensionLiveTable } from "../../runtime/extension-live.js";
import {
	createExtensionLiveSessions,
	type ExtensionLiveSessions,
} from "../../runtime/extension-live-sessions.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createStatsRecorder, type StatsRecorderHandle } from "../recorder.js";
import { createStatsStore } from "../store.js";

const EXT = "douyin";
const SUB = makeExtensionSubscription({
	id: "e3000000-0000-4000-8000-000000000001",
	extensionId: EXT,
	externalId: "sec-uid-1",
});
const OFF = makeExtensionSubscription({
	id: "e3000000-0000-4000-8000-000000000002",
	extensionId: EXT,
	externalId: "sec-uid-2",
	enabled: false,
});
const T0 = Date.UTC(2026, 8, 24, 4, 0, 0);
const MINUTE = 60_000;
const URL = "https://live.douyin.com/1";
const logger = { debug() {}, info() {}, warn() {}, error() {} };

/** 毫秒 → 盘上的 ISO。 */
const iso = (ms: number) => new Date(ms).toISOString();

let dataDir: string;
let clock: number;
let subs: Subscription[];
let running: boolean;
let fansCron: string;
/** 订阅的作品开关 / 直播类开关(有效值,真线上由 bootstrap 算好交给适配)。 */
let switches: { posts: boolean; live: boolean };
/** 这一轮起的几套(重启的用例起两套),收尾时一起拆。 */
let worlds: World[];

interface World {
	bus: ReturnType<typeof createNodeMessageBus>;
	recorder: StatsRecorderHandle;
	sessions: ExtensionLiveSessions;
	/** 照 index.ts 关机那一串走一遍:拓展收摊 → 引擎拆(场次在这里补关机那一帧)→ 记录器收尾。 */
	shutdown(): Promise<void>;
}

const timers = {
	setTimeout: (fn: () => void, ms: number) => {
		const h = setTimeout(fn, ms);
		return { dispose: () => clearTimeout(h) };
	},
};

/**
 * 起一套:在播表、场次、记录器。**故意与线上反着挂**(线上记录器在 bootstrap 里先挂,场次在引擎里后建)——
 * 统计不该靠谁先听到同一条上报。
 *
 * `slowDiskMs`:直播帧落盘慢这么久(磁盘忙)—— 关机那条用它,不然「返回时落没落盘」全看运气。
 */
function boot(opts: { slowDiskMs?: number } = {}): World {
	const now = () => new Date(clock);
	const bus = createNodeMessageBus();
	const real = createStatsStore({ dataRoot: dataDir, logger, now });
	const delay = opts.slowDiskMs;
	const store: typeof real =
		delay === undefined
			? real
			: {
					...real,
					async closeLiveSession(...args) {
						await new Promise((resolve) => setTimeout(resolve, delay));
						return real.closeLiveSession(...args);
					},
				};
	const table = createExtensionLiveTable({ bus, timers, now: () => clock });
	const sessions = createExtensionLiveSessions({
		bus,
		logger,
		table,
		subscription: (id) => subs.find((sub) => sub.id === id),
		running: () => running,
		fans: () => undefined,
		settings: () => ({ liveEndGrace: false, liveEndGraceMinutes: 2 }),
		timers,
		now: () => clock,
	});
	const recorder = createStatsRecorder({
		bus,
		store,
		fans: createFollowersStore({ dataRoot: dataDir, logger }),
		fansCron: () => fansCron,
		logger,
		now,
		subscriptions: () =>
			subs.map((sub) => ({
				id: sub.id,
				identity: sub.identity,
				enabled: sub.enabled,
				recordsPosts: sub.enabled && switches.posts,
				recordsLive: sub.enabled && switches.live,
			})),
	});
	let down = false;
	const world: World = {
		bus,
		recorder,
		sessions,
		async shutdown() {
			if (down) return;
			down = true;
			sessions.dispose();
			table.dispose();
			await recorder.closeOpenSessions();
			recorder.dispose();
		},
	};
	worlds.push(world);
	return world;
}

function report(bus: World["bus"], r: SubscriptionReport, sub: Subscription = SUB): void {
	bus.emit("subscription-reported", {
		extensionId: sub.identity.sourceKey,
		externalId: sub.identity.externalId,
		subscriptionIds: [sub.id],
		report: r,
	});
}

type Value<K extends SubscriptionReport["kind"]> = Extract<
	SubscriptionReport,
	{ kind: K }
>["value"];
const post = (over: Partial<Value<"post">> = {}): SubscriptionReport => ({
	kind: "post",
	value: { id: "p1", url: "https://www.douyin.com/p1", publishedAt: T0 - MINUTE, ...over },
});
const liveStart = (over: Partial<Value<"liveStart">> = {}): SubscriptionReport => ({
	kind: "liveStart",
	value: { url: URL, startedAt: clock, ...over },
});
const liveStatus = (over: Partial<Value<"liveStatus">> = {}): SubscriptionReport => ({
	kind: "liveStatus",
	value: { live: true, url: URL, ...over },
});
const liveEnd = (over: Partial<Value<"liveEnd">> = {}): SubscriptionReport => ({
	kind: "liveEnd",
	value: { url: URL, ...over },
});
const profile = (over: Partial<Value<"profile">> = {}): SubscriptionReport => ({
	kind: "profile",
	value: { ...over },
});

/** 一个 jsonl 的每一行;文件不在是 `undefined`(与「在、但空」分得开)。 */
async function lines(dir: string, id: string): Promise<unknown[] | undefined> {
	try {
		const raw = await readFile(join(dataDir, dir, `${id}.jsonl`), "utf8");
		return raw
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}
const dynRows = (id = SUB.id) => lines(join("stats", "posts"), id);
const liveFrames = (id = SUB.id) => lines(join("stats", "live"), id);
const fansRows = (id = SUB.id) => lines(join(...FOLLOWERS_DIR), id);
const recordingRows = (id = SUB.id) => lines(join("stats", "recording"), id);
/** 某个时刻所在的整点小时,账里的一行。 */
const hourRow = (kind: "posts" | "live" | "followers", at = T0) => {
	const from = Math.floor(at / 3_600_000) * 3_600_000;
	return { kind, startedAt: iso(from), endedAt: iso(from + 3_600_000) };
};

async function exists(path: string): Promise<boolean> {
	try {
		await access(join(dataDir, path));
		return true;
	} catch {
		return false;
	}
}

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-stats-ext-"));
	clock = T0;
	subs = [SUB, OFF];
	running = true;
	fansCron = "*/10 * * * *";
	switches = { posts: true, live: true };
	worlds = [];
});

afterEach(async () => {
	for (const world of worlds) await world.shutdown();
	await rm(dataDir, { recursive: true, force: true });
});

describe("作品(决策 5)", () => {
	it("带视频的记 video、其余记 post;按订阅 id 落,时刻是发布时刻", async () => {
		const { bus, recorder } = boot();
		report(bus, post({ id: "v1", publishedAt: T0 - 5 * MINUTE, video: { title: "一支视频" } }));
		report(bus, post({ id: "t1", publishedAt: T0 - 3 * MINUTE, text: "一条图文" }));
		await recorder.flush();
		expect(await dynRows()).toEqual([
			expect.objectContaining({ id: "v1", hasVideo: true, publishedAt: iso(T0 - 5 * MINUTE) }),
			expect.objectContaining({ id: "t1", hasVideo: false, publishedAt: iso(T0 - 3 * MINUTE) }),
		]);
	});

	it("同一条作品报两次只留一行", async () => {
		const { bus, recorder } = boot();
		report(bus, post({ id: "dup" }));
		report(bus, post({ id: "dup" }));
		await recorder.flush();
		expect(await dynRows()).toHaveLength(1);
	});
});

describe("作品行多收的五格(ADR-0027 决策 4 / 12,先翻成中立的 Post 再取)", () => {
	it("带视频、话题、正文的上报:五格都对(期望值手写)", async () => {
		const { bus, recorder } = boot();
		report(
			bus,
			post({
				id: "full",
				url: "https://www.douyin.com/video/full",
				publishedAt: T0 - 5 * MINUTE,
				text: "今天去了海边 #旅行#",
				topics: ["旅行"],
				video: { title: "海边一日", duration: 125 },
			}),
		);
		await recorder.flush();
		expect(await dynRows()).toEqual([
			{
				id: "full",
				hasVideo: true,
				publishedAt: iso(T0 - 5 * MINUTE),
				url: "https://www.douyin.com/video/full",
				title: "海边一日",
				summary: "今天去了海边 #旅行#\n视频标题：海边一日",
				topic: "旅行",
				videoDurationSec: 125,
			},
		]);
	});

	it("纯文字的上报:只有链接与摘要,其余格不写", async () => {
		const { bus, recorder } = boot();
		report(bus, post({ id: "plain", url: "https://www.douyin.com/plain", text: "一句话" }));
		await recorder.flush();
		const [row] = (await dynRows()) ?? [];
		expect(row).toEqual({
			id: "plain",
			hasVideo: false,
			publishedAt: iso(T0 - MINUTE),
			url: "https://www.douyin.com/plain",
			summary: "一句话",
		});
	});

	it("超长正文:摘要正好 200 个字符", async () => {
		const { bus, recorder } = boot();
		report(bus, post({ id: "long", text: "字".repeat(1000) }));
		await recorder.flush();
		const [row] = (await dynRows()) ?? [];
		expect([...String((row as { summary?: string }).summary)]).toHaveLength(200);
	});

	it("翻成 Post 失败:这一行还在,只是没有这五格", async () => {
		const { bus, recorder } = boot();
		const broken = post({ id: "broken" });
		Object.defineProperty(broken.value, "text", {
			get() {
				throw new Error("翻不了");
			},
			enumerable: true,
		});
		report(bus, broken);
		await recorder.flush();
		expect(await dynRows()).toEqual([
			{ id: "broken", hasVideo: false, publishedAt: iso(T0 - MINUTE) },
		]);
	});

	it("统计不因为翻译而把图写进图库:带配图、封面的上报之后,数据根下没有图库目录", async () => {
		const { bus, recorder } = boot();
		const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
		report(
			bus,
			post({ id: "pics", text: "有图", images: [png], video: { title: "片", cover: png } }),
		);
		await recorder.flush();
		expect(await dynRows()).toHaveLength(1);
		expect(await exists("images")).toBe(false);
	});

	it("作品开关关着:不落行(㉖f),这五格也就无从谈起", async () => {
		switches = { posts: false, live: true };
		const { bus, recorder } = boot();
		report(bus, post({ id: "off", text: "不该记" }));
		await recorder.flush();
		expect(await dynRows()).toBeUndefined();
	});
});

describe("记谁(决策 4)", () => {
	it("没有推送目标也照记 —— 「开着」只看开关、不看有没有目标;粉丝只看订阅启用", async () => {
		const { bus, recorder } = boot();
		report(bus, post({ id: "quiet" }));
		report(bus, profile({ fans: 42 }));
		await recorder.flush();
		expect(await dynRows()).toEqual([expect.objectContaining({ id: "quiet" })]);
		expect(await fansRows()).toEqual([{ sampledAt: iso(T0), followers: 42 }]);
	});

	it("停用的订阅一样都不记 —— 它的资料照样报上来(ADR-0019 决策 62),粉丝与「在记」也不记", async () => {
		const { bus, recorder } = boot();
		report(bus, profile({ fans: 42, name: "停着的人" }), OFF);
		report(bus, post({ id: "off-post" }), OFF);
		report(bus, liveStatus({ totalViewers: 10 }), OFF);
		// 对照:同一串换成启用着的就记 —— 证明监听确实在跑、不是空转。
		report(bus, post({ id: "on-post" }));
		await recorder.flush();
		expect(await dynRows()).toEqual([expect.objectContaining({ id: "on-post" })]);
		expect(await dynRows(OFF.id)).toBeUndefined();
		expect(await fansRows(OFF.id)).toBeUndefined();
		expect(await recordingRows(OFF.id)).toBeUndefined();
		expect(await liveFrames(OFF.id)).toBeUndefined();
	});

	it("不认识的订阅 id(刚删的、别处来的)什么都不记", async () => {
		const ghost = makeExtensionSubscription({ id: "e3000000-0000-4000-8000-00000000dead" });
		const { bus, recorder } = boot();
		report(bus, post({ id: "ghost" }), ghost);
		report(bus, profile({ fans: 1 }), ghost);
		await recorder.flush();
		expect(await dynRows(ghost.id)).toBeUndefined();
		expect(await fansRows(ghost.id)).toBeUndefined();
		expect(await recordingRows(ghost.id)).toBeUndefined();
	});
});

/** 盘上配好的场次(读的人看到的样子)。 */
const sessionsOnDisk = () =>
	createStatsStore({ dataRoot: dataDir, logger }).listLiveSessions(SUB.id, "");

describe("直播场次(决策 6)", () => {
	it("开播事件开一场、下播关一场:开播时刻取事件的,结束时刻是下播到达那一刻", async () => {
		const world = boot();
		const startedAt = T0 - 5 * MINUTE;
		report(world.bus, liveStart({ startedAt }));
		clock = T0 + 60 * MINUTE;
		report(world.bus, liveEnd());
		await world.recorder.flush();
		expect(await liveFrames()).toEqual([
			{ kind: "start", occurredAt: iso(startedAt) },
			{ kind: "end", occurredAt: iso(T0 + 60 * MINUTE) },
		]);
	});

	it("推送开关全关着,场次照记(ADR-0020 决策 4)", async () => {
		subs = [
			makeExtensionSubscription({
				...SUB,
				overrides: { features: { liveStart: false, liveEnd: false } },
			}),
		];
		const world = boot();
		report(world.bus, liveStart());
		report(world.bus, liveEnd());
		await world.recorder.flush();
		expect((await liveFrames())?.map((f) => (f as { kind: string }).kind)).toEqual([
			"start",
			"end",
		]);
	});

	it("只见过在播状态(BN 起来之前就开播了)也认出一场,开播时刻取状态带的", async () => {
		const world = boot();
		report(world.bus, liveStatus({ startedAt: T0 - 90 * MINUTE }));
		clock = T0 + MINUTE;
		report(world.bus, liveEnd());
		await world.recorder.flush();
		expect(await sessionsOnDisk()).toEqual([
			{ startedAt: iso(T0 - 90 * MINUTE), endedAt: iso(T0 + MINUTE) },
		]);
	});

	it("每种结束都是「观测到此为止」:拓展停了 / 订阅停用 / 关机都补一帧下播", async () => {
		// 拓展停了。
		const world = boot();
		report(world.bus, liveStart({ startedAt: T0 }));
		clock = T0 + 10 * MINUTE;
		world.bus.emit("extension-stopped", { extensionId: EXT });
		// 拓展又跑起来、又开一场;这回是订阅停用了。
		clock = T0 + 20 * MINUTE;
		report(world.bus, liveStart({ startedAt: T0 + 20 * MINUTE }));
		clock = T0 + 30 * MINUTE;
		const disabled = { ...SUB, enabled: false };
		subs = [disabled, OFF];
		world.bus.emit("subscription-changed", {
			ops: [{ type: "update", sub: disabled, prev: SUB }] as never,
		});
		// 再启用、再开一场;这回是关机。
		subs = [SUB, OFF];
		world.bus.emit("subscription-changed", {
			ops: [{ type: "update", sub: SUB, prev: disabled }] as never,
		});
		clock = T0 + 40 * MINUTE;
		report(world.bus, liveStart({ startedAt: T0 + 40 * MINUTE }));
		clock = T0 + 50 * MINUTE;
		await world.shutdown();
		expect(await sessionsOnDisk()).toEqual([
			{ startedAt: iso(T0), endedAt: iso(T0 + 10 * MINUTE) },
			{ startedAt: iso(T0 + 20 * MINUTE), endedAt: iso(T0 + 30 * MINUTE) },
			{ startedAt: iso(T0 + 40 * MINUTE), endedAt: iso(T0 + 50 * MINUTE) },
		]);
	});

	it("没报下播又开播:上一场在新一场开播那刻收掉,两场各是各的", async () => {
		const world = boot();
		report(world.bus, liveStart({ startedAt: T0 }));
		clock = T0 + 30 * MINUTE;
		report(world.bus, liveStart({ startedAt: T0 + 30 * MINUTE }));
		clock = T0 + 60 * MINUTE;
		report(world.bus, liveEnd());
		await world.recorder.flush();
		expect(await sessionsOnDisk()).toEqual([
			{ startedAt: iso(T0), endedAt: iso(T0 + 30 * MINUTE) },
			{ startedAt: iso(T0 + 30 * MINUTE), endedAt: iso(T0 + 60 * MINUTE) },
		]);
	});

	it("BN 重启之后按开播时刻接回同一场:还是一场,结束时刻取后来那次真下播", async () => {
		const first = boot();
		report(first.bus, liveStatus({ startedAt: T0, totalViewers: 100 }));
		clock = T0 + 10 * MINUTE;
		await first.shutdown();

		clock = T0 + 15 * MINUTE;
		const second = boot();
		report(second.bus, liveStatus({ startedAt: T0, totalViewers: 300 }));
		clock = T0 + 60 * MINUTE;
		report(second.bus, liveEnd());
		await second.recorder.flush();
		expect(await sessionsOnDisk()).toEqual([
			{ startedAt: iso(T0), endedAt: iso(T0 + 60 * MINUTE), peakTotalViewers: 300 },
		]);
	});
});

describe("峰值 = 结束帧带的本场累计观看(决策 7)", () => {
	// 取最大、断流接续接着取、新一场从头取、不拿在线顶替 —— 这些在场次那边算(extension-live-sessions.test.ts
	// 「本场累计观看」),这里只看统计把结束帧带的数照抄进盘。

	it("关一场的峰值就是结束帧带的 totalViewers", async () => {
		const world = boot();
		report(world.bus, liveStart({ totalViewers: 100, viewers: 90_000 }));
		report(world.bus, liveStatus({ totalViewers: 800 }));
		report(world.bus, liveEnd({ totalViewers: 900 }));
		await world.recorder.flush();
		expect(await liveFrames()).toEqual([
			{ kind: "start", occurredAt: iso(T0) },
			{ kind: "end", occurredAt: iso(T0), peakTotalViewers: 900 },
		]);
	});

	it("结束帧没带(平台只报此刻在线):这一场不带峰值", async () => {
		const world = boot();
		report(world.bus, liveStart({ viewers: 50 }));
		report(world.bus, liveEnd({ viewers: 70 }));
		await world.recorder.flush();
		const [session] = await sessionsOnDisk();
		expect(session).toBeDefined();
		expect(session).not.toHaveProperty("peakTotalViewers");
	});

	it("结束帧直接发在总线上也照抄(不经上报)", async () => {
		const world = boot();
		const frame = { subscriptionId: SUB.id, extensionId: EXT, startedAt: iso(T0), at: iso(T0) };
		world.bus.emit("extension-live-session", { ...frame, phase: "start", trigger: "liveStart" });
		world.bus.emit("extension-live-session", {
			...frame,
			phase: "end",
			at: iso(T0 + MINUTE),
			reason: "ended",
			totalViewers: 4_321,
		});
		await world.recorder.flush();
		expect(await liveFrames()).toEqual([
			{ kind: "start", occurredAt: iso(T0) },
			{ kind: "end", occurredAt: iso(T0 + MINUTE), peakTotalViewers: 4_321 },
		]);
	});

	it("BN 重启接回同一场,接回之后报的累计观看更小 / 没报:盘上这一场留着前一段更大的数", async () => {
		const first = boot();
		report(first.bus, liveStatus({ startedAt: T0, totalViewers: 500 }));
		clock = T0 + 10 * MINUTE;
		await first.shutdown();

		clock = T0 + 15 * MINUTE;
		const second = boot();
		report(second.bus, liveStatus({ startedAt: T0, totalViewers: 300 }));
		clock = T0 + 20 * MINUTE;
		await second.shutdown();

		clock = T0 + 25 * MINUTE;
		const third = boot();
		report(third.bus, liveStatus({ startedAt: T0 }));
		clock = T0 + 60 * MINUTE;
		report(third.bus, liveEnd());
		await third.recorder.flush();
		expect(await sessionsOnDisk()).toEqual([
			{ startedAt: iso(T0), endedAt: iso(T0 + 60 * MINUTE), peakTotalViewers: 500 },
		]);
	});
});

describe("关机(决策 6):开着的一场恰好一帧下播,关机返回时已经落盘", () => {
	it("拓展先收摊(extension-stopped)→ 引擎拆 → 记录器收尾:一帧,不多不少,带着峰值", async () => {
		const world = boot({ slowDiskMs: 50 });
		report(world.bus, liveStart({ startedAt: T0, totalViewers: 321 }));
		clock = T0 + 5 * MINUTE;
		// index.ts 的关机次序:拓展先收(它那面 ctx 收摊时发 extension-stopped),再拆引擎,最后 runtime 的钩子。
		world.bus.emit("extension-stopped", { extensionId: EXT });
		// 记录器收尾那一步晚一点到 —— 那一帧得是拓展停下那一刻的,而且只有它一帧。
		clock = T0 + 6 * MINUTE;
		await world.shutdown();
		// 不再等:关机返回之后进程就退了,帧必须已经在盘上。
		const frames = await liveFrames();
		expect(frames?.filter((f) => (f as { kind: string }).kind === "end")).toEqual([
			{ kind: "end", occurredAt: iso(T0 + 5 * MINUTE), peakTotalViewers: 321 },
		]);
	});

	it("拓展一直在跑、只有引擎拆场次时补的那一帧(shutdown):同样恰好一帧", async () => {
		const world = boot({ slowDiskMs: 50 });
		report(world.bus, liveStart({ startedAt: T0 }));
		clock = T0 + 5 * MINUTE;
		await world.shutdown();
		const frames = await liveFrames();
		expect(frames?.filter((f) => (f as { kind: string }).kind === "end")).toEqual([
			{ kind: "end", occurredAt: iso(T0 + 5 * MINUTE) },
		]);
	});
});

describe("粉丝(决策 8)", () => {
	it("资料带了粉丝数就记一个样本(时刻是收到那一刻);不密过 B 站粉丝轮询(默认每 10 分钟),留先到的", async () => {
		const world = boot();
		report(world.bus, profile({ fans: 100 }));
		clock = T0 + 5 * MINUTE;
		report(world.bus, profile({ fans: 110 }));
		clock = T0 + 10 * MINUTE;
		report(world.bus, profile({ fans: 120 }));
		await world.recorder.flush();
		expect(await fansRows()).toEqual([
			{ sampledAt: iso(T0), followers: 100 },
			{ sampledAt: iso(T0 + 10 * MINUTE), followers: 120 },
		]);
	});

	it("同一刻连着报两份:只记一个", async () => {
		const world = boot();
		report(world.bus, profile({ fans: 100 }));
		report(world.bus, profile({ fans: 101 }));
		await world.recorder.flush();
		expect(await fansRows()).toEqual([{ sampledAt: iso(T0), followers: 100 }]);
	});

	it("没带粉丝数的资料(平台不报)不记粉丝", async () => {
		const world = boot();
		report(world.bus, profile({ name: "只报名字" }));
		await world.recorder.flush();
		expect(await fansRows()).toBeUndefined();
	});

	it("间隔跟着 fansCron 走:改成每 2 分钟,2 分钟后那份就记", async () => {
		fansCron = "*/2 * * * *";
		const world = boot();
		report(world.bus, profile({ fans: 100 }));
		clock = T0 + 2 * MINUTE;
		report(world.bus, profile({ fans: 102 }));
		await world.recorder.flush();
		expect(await fansRows()).toEqual([
			{ sampledAt: iso(T0), followers: 100 },
			{ sampledAt: iso(T0 + 2 * MINUTE), followers: 102 },
		]);
	});

	it("fansCron 读不出来(面板上是自由文本):按默认的 10 分钟", async () => {
		fansCron = "每十分钟";
		const world = boot();
		report(world.bus, profile({ fans: 100 }));
		clock = T0 + 5 * MINUTE;
		report(world.bus, profile({ fans: 105 }));
		clock = T0 + 10 * MINUTE;
		report(world.bus, profile({ fans: 110 }));
		await world.recorder.flush();
		expect((await fansRows())?.map((row) => (row as { followers: number }).followers)).toEqual([
			100, 110,
		]);
	});

	it("BN 重启之后的第一份也不紧贴着重启前的最后一个样本", async () => {
		const first = boot();
		report(first.bus, profile({ fans: 100 }));
		await first.shutdown();
		clock = T0 + 3 * MINUTE;
		const second = boot();
		report(second.bus, profile({ fans: 103 }));
		clock = T0 + 10 * MINUTE;
		report(second.bus, profile({ fans: 110 }));
		await second.recorder.flush();
		expect((await fansRows())?.map((row) => (row as { followers: number }).followers)).toEqual([
			100, 110,
		]);
	});
});

describe("「在记」小账(ADR-0027 决策 2 / 13)", () => {
	it("五种上报哪一种来了都算「来源在跑」:作品与直播两项记当前整点小时", async () => {
		const people = ["01", "02", "03", "04", "05"].map((n) =>
			makeExtensionSubscription({
				id: `e3000000-0000-4000-8000-0000000001${n}`,
				extensionId: EXT,
				externalId: `person-${n}`,
			}),
		);
		subs = people;
		const world = boot();
		const reports = [post(), profile({ name: "只报名字" }), liveStart(), liveStatus(), liveEnd()];
		for (const [i, r] of reports.entries()) report(world.bus, r, people[i]);
		await world.recorder.flush();
		for (const person of people) {
			expect(await recordingRows(person.id)).toEqual([hourRow("posts"), hourRow("live")]);
		}
	});

	it("同一小时同一项只落一行;换一个小时再落一行", async () => {
		const world = boot();
		report(world.bus, post());
		clock = T0 + MINUTE;
		report(world.bus, profile({ name: "又报了资料" }));
		clock = T0 + 59 * MINUTE;
		report(world.bus, liveStatus({ live: false }));
		await world.recorder.flush();
		expect(await recordingRows()).toEqual([hourRow("posts"), hourRow("live")]);
		clock = T0 + 61 * MINUTE;
		report(world.bus, profile({ name: "下一个小时" }));
		await world.recorder.flush();
		expect(await recordingRows()).toEqual([
			hourRow("posts"),
			hourRow("live"),
			hourRow("posts", T0 + 61 * MINUTE),
			hourRow("live", T0 + 61 * MINUTE),
		]);
	});

	it("BN 重启之后同一小时不重复落(第一次写之前读一次盘把这个小时已有的种进去)", async () => {
		const first = boot();
		report(first.bus, post());
		await first.shutdown();
		clock = T0 + 4 * MINUTE;
		const second = boot();
		report(second.bus, post({ id: "p2" }));
		await second.recorder.flush();
		expect(await recordingRows()).toEqual([hourRow("posts"), hourRow("live")]);
	});

	it("资料带粉丝数就记粉丝(不管粉丝样本被稀释掉没有);没带粉丝数的资料不记", async () => {
		const world = boot();
		report(world.bus, profile({ name: "没带粉丝" }));
		await world.recorder.flush();
		expect(await recordingRows()).not.toContainEqual(hourRow("followers"));
		report(world.bus, profile({ fans: 7 }));
		clock = T0 + MINUTE;
		// 第二条粉丝样本被稀释掉(不足 10 分钟),账照样只有这一小时的一行。
		report(world.bus, profile({ fans: 8 }));
		await world.recorder.flush();
		expect(await fansRows()).toHaveLength(1);
		expect(
			((await recordingRows()) ?? []).filter((r) => (r as { kind: string }).kind === "followers"),
		).toEqual([hourRow("followers")]);
	});

	it("作品开关关着:作品不落行、也不记 posts;直播与粉丝照记", async () => {
		switches = { posts: false, live: true };
		const world = boot();
		report(world.bus, post({ id: "quiet" }));
		report(world.bus, profile({ fans: 3 }));
		await world.recorder.flush();
		expect(await dynRows()).toBeUndefined();
		expect(await recordingRows()).toEqual([hourRow("live"), hourRow("followers")]);
	});

	it("直播类开关都关着:不开新场次、不记 live;作品照记", async () => {
		switches = { posts: true, live: false };
		const world = boot();
		report(world.bus, liveStart());
		report(world.bus, post());
		await world.recorder.flush();
		expect(await liveFrames()).toBeUndefined();
		expect(await recordingRows()).toEqual([hourRow("posts")]);
	});

	it("一场进行中把直播类开关关掉:这一场照常收尾(下播事件到了就关),之后的开播不再开场", async () => {
		const world = boot();
		report(world.bus, liveStart());
		await world.recorder.flush();
		switches = { posts: true, live: false };
		// 全局默认改了,适配的订阅快照作废、下次取到新的开关。
		world.bus.emit("config-changed", { scope: "globals" });
		clock = T0 + 30 * MINUTE;
		report(world.bus, liveEnd());
		await world.recorder.flush();
		expect(await liveFrames()).toEqual([
			{ kind: "start", occurredAt: iso(T0) },
			{ kind: "end", occurredAt: iso(T0 + 30 * MINUTE) },
		]);
		clock = T0 + 40 * MINUTE;
		report(world.bus, liveStart({ startedAt: clock }));
		await world.recorder.flush();
		expect(await liveFrames()).toHaveLength(2);
	});

	it("B 站订阅的事件不经拓展适配落「在记」(B 站的由登录状态定时记,没登录就没有)", async () => {
		subs = [
			SUB,
			makeEmptySubscription({ id: "b-7", identity: { sourceKey: "bilibili", externalId: "7" } }),
		];
		const world = boot();
		world.bus.emit("dynamic-detected", {
			uid: "7",
			id: "d1",
			type: "DYNAMIC_TYPE_AV",
			ts: iso(T0),
		});
		await world.recorder.flush();
		expect(await dynRows("b-7")).toEqual([{ id: "d1", hasVideo: true, publishedAt: iso(T0) }]);
		expect(await exists(join("stats", "recording", "b-7.jsonl"))).toBe(false);
	});
});

describe("删订阅 / 停用(决策 10)", () => {
	/** 四份文件都写上:作品、粉丝、「在记」,外加一场开着的直播。 */
	async function fillAll(world: World): Promise<void> {
		report(world.bus, post());
		report(world.bus, profile({ fans: 9 }));
		report(world.bus, liveStart());
		await world.recorder.flush();
		expect(await dynRows()).toHaveLength(1);
		expect(await fansRows()).toHaveLength(1);
		expect(await recordingRows()).toHaveLength(3);
		expect(await liveFrames()).toHaveLength(1);
	}

	it("删了:作品 / 直播 / 「在记」/ 粉丝四份全删 —— 开着的那一场结束也不把直播文件写回来", async () => {
		const world = boot();
		await fillAll(world);
		subs = [OFF];
		world.bus.emit("subscription-changed", { ops: [{ type: "remove", sub: SUB }] });
		await world.recorder.flush();
		expect(await dynRows()).toBeUndefined();
		expect(await liveFrames()).toBeUndefined();
		expect(await recordingRows()).toBeUndefined();
		expect(await fansRows()).toBeUndefined();
		// 关机时也不给它补帧。
		await world.shutdown();
		expect(await liveFrames()).toBeUndefined();
	});

	it("停用:文件都留着,开着的那一场在停用那一刻关", async () => {
		const world = boot();
		await fillAll(world);
		clock = T0 + 7 * MINUTE;
		const disabled = { ...SUB, enabled: false };
		subs = [disabled, OFF];
		world.bus.emit("subscription-changed", {
			ops: [{ type: "update", sub: disabled, prev: SUB }] as never,
		});
		await world.recorder.flush();
		expect(await dynRows()).toHaveLength(1);
		expect(await fansRows()).toHaveLength(1);
		expect(await recordingRows()).toHaveLength(3);
		expect(await liveFrames()).toEqual([
			{ kind: "start", occurredAt: iso(T0) },
			{ kind: "end", occurredAt: iso(T0 + 7 * MINUTE) },
		]);
	});
});
