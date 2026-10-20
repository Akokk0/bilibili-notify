/**
 * 拓展订阅的直播场次(`createLiveSessionEngine`,ADR-0020 决策 6;ADR-0019 决策 53 / 57 / 58 / 61)。
 *
 * 喂一条真的总线、一张真的在播表,时钟走假定时器,看场次的每一次变化:
 * - 一场从开播事件开始,或从 BN 开始看之后见到的在播状态开始;下播只由事件结束(决策 53);
 * - 断流接续:下播先压着,等待期间再开播是同一场、开播时刻不变;等满了才结束,结束时刻是下播事件到达那一刻
 *   (决策 58);
 * - 拓展停了 / 订阅停用或删了 / 关机:当场结束,原因分得清(决策 61);
 * - 与推送开关无关(ADR-0020 决策 4);一场的开始与结束发上总线(`extension-live-session`),给统计记场次。
 *
 * ⚠️ 这个文件用假定时器:别用 `waitFor` / `findBy*`(会死锁),推进时间一律 `advanceTimersByTimeAsync`。
 */

import type {
	ExtensionLiveSessionEvent,
	LiveDetails,
	Subscription,
	SubscriptionReport,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import {
	createLiveSessionEngine,
	type LiveSessionChange,
	type LiveSessionEngine,
	type LiveStatusReader,
	liveSubscriptionPushable,
} from "../live-sessions.js";
import type { LiveWorkSettings } from "../live-settings.js";
import { createLiveTable, type LiveTable } from "../live-table.js";

const EXT = "douyin";
const SUB = makeExtensionSubscription({ extensionId: EXT, externalId: "sec-uid-1" });
const OTHER = makeExtensionSubscription({
	id: "e0000000-0000-4000-8000-000000000002",
	extensionId: "kuaishou",
	externalId: "ks-1",
});
const T0 = Date.UTC(2026, 8, 24, 4, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const URL = "https://live.douyin.com/123";
const logger = { debug() {}, info() {}, warn() {}, error() {} };

type GraceSettings = Pick<
	LiveWorkSettings,
	| "liveStart"
	| "liveEnd"
	| "liveEndGrace"
	| "liveEndGraceMinutes"
	| "liveStreaming"
	| "streamingIntervalHours"
>;

let bus: ReturnType<typeof createNodeMessageBus>;
let table: LiveTable;
let sessions: LiveSessionEngine;
let changes: LiveSessionChange[];
/** 总线上听到的每一发 `extension-live-session`。 */
let frames: ExtensionLiveSessionEvent[];
let settings: GraceSettings;
let subs: Map<string, Subscription>;
let running: Set<string>;
let fans: number | undefined;

const timers = {
	setTimeout: (fn: () => void, ms: number) => {
		const h = setTimeout(fn, ms);
		return { dispose: () => clearTimeout(h) };
	},
};

function start(liveStatus?: LiveStatusReader): void {
	table = createLiveTable({ bus, timers });
	sessions = createLiveSessionEngine({
		bus,
		logger,
		table,
		subscription: (id) => subs.get(id),
		sourceStatus: { running: (id) => running.has(id) },
		fans: () => fans,
		settings: () => settings,
		...(liveStatus === undefined ? {} : { liveStatus }),
		timers,
	});
	sessions.onChange((change) => changes.push(change));
}

/** 毫秒 → 总线上的 ISO。 */
const iso = (ms: number) => new Date(ms).toISOString();

/** 毫秒 → ISO;没给就没有。 */
const isoOr = (ms: number | undefined) => (ms === undefined ? undefined : iso(ms));

/** 上报里直播那几格(测试里只用到这几样)→ 中立详情。 */
function detailsOf(value: {
	url?: string;
	title?: string;
	category?: string;
	viewers?: number;
	totalViewers?: number;
	likes?: number;
}): LiveDetails {
	const { url, title, category, viewers, totalViewers, likes } = value;
	return Object.fromEntries(
		Object.entries({ url, title, category, currentViewers: viewers, totalViewers, likes }).filter(
			([, cell]) => cell !== undefined,
		),
	) as LiveDetails;
}

/**
 * 这里用上报的写法描述「来了什么」,翻成中立信号直调引擎(引擎的输入就是 `LiveSignal`;拓展上报怎么翻、
 * 图怎么存见 `extension-live.test.ts`)。下播的时刻是调用那一刻。
 */
function report(r: SubscriptionReport, sub: Subscription = SUB): void {
	const base = { subscriptionId: sub.id, identity: sub.identity };
	switch (r.kind) {
		case "liveStart":
			sessions.apply({
				...base,
				kind: "start",
				startedAt: isoOr(r.value.startedAt),
				details: detailsOf(r.value),
			});
			return;
		case "liveStatus":
			sessions.apply({
				...base,
				kind: "status",
				isLive: r.value.live,
				startedAt: isoOr(r.value.startedAt),
				details: detailsOf(r.value),
			});
			return;
		case "liveEnd":
			sessions.apply({
				...base,
				kind: "end",
				endedAt: iso(Date.now()),
				startedAt: isoOr(r.value.startedAt),
				details: detailsOf(r.value),
			});
			return;
		default:
			throw new Error(`测试里不会有 ${r.kind}`);
	}
}

const liveStart = (
	over: Partial<Extract<SubscriptionReport, { kind: "liveStart" }>["value"]> = {},
	sub?: Subscription,
) =>
	report(
		{ kind: "liveStart", value: { url: URL, startedAt: Date.now(), title: "第一场", ...over } },
		sub,
	);
const liveEnd = (
	over: Partial<Extract<SubscriptionReport, { kind: "liveEnd" }>["value"]> = {},
	sub?: Subscription,
) => report({ kind: "liveEnd", value: { url: URL, ...over } }, sub);
const liveStatus = (
	over: Partial<Extract<SubscriptionReport, { kind: "liveStatus" }>["value"]> = {},
	sub?: Subscription,
) => report({ kind: "liveStatus", value: { live: true, url: URL, ...over } }, sub);

/** 变化的要点:种类 + 开始的触发 / 结束的原因与时刻 —— 断言只看这几样。 */
function summary(): Array<Record<string, unknown>> {
	return changes.map((c) => {
		switch (c.kind) {
			case "start":
				return { kind: c.kind, trigger: c.trigger, startedAt: c.session.startedAt };
			case "end":
				return { kind: c.kind, reason: c.reason, at: c.at };
			case "status":
				return { kind: c.kind, live: c.live };
			case "unmatched-end":
				return { kind: c.kind, at: c.at };
			default:
				return { kind: c.kind };
		}
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	bus = createNodeMessageBus();
	bus.on("extension-live-session", (event) => frames.push(event));
	changes = [];
	frames = [];
	settings = {
		liveStart: true,
		liveEnd: true,
		liveEndGrace: false,
		liveEndGraceMinutes: 2,
		liveStreaming: false,
		streamingIntervalHours: 1,
	};
	subs = new Map([
		[SUB.id, SUB],
		[OTHER.id, OTHER],
	]);
	running = new Set([EXT, "kuaishou"]);
	fans = 12_345;
});

afterEach(() => {
	sessions?.dispose();
	table?.dispose();
	vi.useRealTimers();
});

describe("一场从哪开始", () => {
	it("开播事件开一场:开播时刻取事件的,记下此刻资料里的粉丝数与在播表那一行", () => {
		start();
		liveStart({ startedAt: T0 - MINUTE, totalViewers: 40 });

		expect(summary()).toEqual([{ kind: "start", trigger: "start-signal", startedAt: T0 - MINUTE }]);
		const session = sessions.get(SUB.id);
		expect(session).toMatchObject({
			subscriptionId: SUB.id,
			sourceKey: EXT,
			startedAt: T0 - MINUTE,
			detectedAt: T0,
			followersAtStart: 12_345,
			lastDetails: { totalViewers: 40 },
		});
	});

	it("BN 开始看之后见到在播:认出一场,开播时刻取状态带的;没带就空着,之后的状态带了再补上", () => {
		start();
		liveStatus();
		expect(summary()).toEqual([{ kind: "start", trigger: "status-signal", startedAt: undefined }]);
		expect(sessions.get(SUB.id)?.detectedAt).toBe(T0);

		liveStatus({ startedAt: T0 - HOUR, totalViewers: 9 });
		expect(summary().at(-1)).toEqual({ kind: "status", live: true });
		expect(sessions.get(SUB.id)).toMatchObject({
			startedAt: T0 - HOUR,
			lastDetails: { totalViewers: 9 },
		});
	});

	it("不在播的状态不动这一场:BN 不拿状态的翻转猜下播(决策 53)", () => {
		start();
		liveStart();
		report({ kind: "liveStatus", value: { live: false } });
		expect(summary()).toEqual([
			{ kind: "start", trigger: "start-signal", startedAt: T0 },
			{ kind: "status", live: false },
		]);
		expect(sessions.get(SUB.id)).toBeDefined();
	});

	it("没报下播就又开播了:上一场在新的一场开播时收掉", () => {
		start();
		liveStart();
		vi.advanceTimersByTime(HOUR);
		liveStart({ startedAt: Date.now(), title: "第二场" });
		expect(summary()).toEqual([
			{ kind: "start", trigger: "start-signal", startedAt: T0 },
			{ kind: "end", reason: "superseded", at: T0 + HOUR },
			{ kind: "start", trigger: "start-signal", startedAt: T0 + HOUR },
		]);
	});

	it("停用的订阅、拓展没在跑:上报一概不记", () => {
		subs.set(SUB.id, { ...SUB, enabled: false });
		start();
		liveStart();
		liveStatus();
		subs.set(SUB.id, SUB);
		running.delete(EXT);
		liveStart();
		liveStatus();
		expect(changes).toEqual([]);
		expect(sessions.get(SUB.id)).toBeUndefined();
	});
});

describe("引擎是唯一写在播表的:先写表、再改场次", () => {
	it("开播 / 在播状态写进表(时刻进门是 ISO、表里是毫秒),不在播的状态与下播出表", () => {
		start();
		liveStart({ startedAt: T0 - MINUTE, title: "第一场", viewers: 7 });
		expect(table.get(SUB.id)).toMatchObject({
			sourceKey: EXT,
			startedAt: T0 - MINUTE,
			details: { title: "第一场", currentViewers: 7, url: URL },
		});
		liveStatus({ totalViewers: 99 });
		expect(table.get(SUB.id)?.details).toMatchObject({ title: "第一场", totalViewers: 99 });
		report({ kind: "liveStatus", value: { live: false } });
		expect(table.get(SUB.id)).toBeUndefined();

		liveStart();
		liveEnd();
		expect(table.get(SUB.id)).toBeUndefined();
	});

	it("订阅停用 / 来源没在跑的信号不碰在播表", () => {
		start();
		running.delete(EXT);
		liveStart();
		liveStatus();
		expect(table.list()).toEqual([]);
	});
});

describe("来源在不在跑只问中立的读口,不认拓展名单", () => {
	it("读口说一个不在拓展名单里的键在跑,场次照记;说没在跑就不记", () => {
		const bili = makeExtensionSubscription({
			id: "e0000000-0000-4000-8000-000000000004",
			extensionId: "bilibili",
			externalId: "100",
		});
		subs.set(bili.id, bili);
		start();
		liveStart({}, bili);
		expect(changes).toEqual([]);
		running.add("bilibili");
		liveStart({}, bili);
		expect(sessions.get(bili.id)).toBeDefined();
	});
});

describe("这条订阅现在还该推吗(liveSubscriptionPushable)", () => {
	const reader = { running: (key: string) => key === EXT };

	it("订阅还在、启用着、它的来源在跑 —— 三样都得是,不认来源是哪一种", () => {
		expect(liveSubscriptionPushable(SUB, reader)).toBe(true);
		expect(liveSubscriptionPushable(undefined, reader)).toBe(false);
		expect(liveSubscriptionPushable({ ...SUB, enabled: false }, reader)).toBe(false);
		expect(liveSubscriptionPushable(OTHER, reader)).toBe(false);
		expect(liveSubscriptionPushable(OTHER, { running: () => true })).toBe(true);
	});
});

describe("一场到哪结束", () => {
	it("断流接续没开:下播事件一到这一场就结束,结束时刻是事件到达那一刻", () => {
		start();
		liveStart();
		vi.advanceTimersByTime(2 * HOUR);
		liveEnd();
		expect(summary().at(-1)).toEqual({ kind: "end", reason: "ended", at: T0 + 2 * HOUR });
		expect(sessions.get(SUB.id)).toBeUndefined();
	});

	it("下播事件来了手里却没有这一场:照实说,不编一场出来", () => {
		start();
		liveEnd({ startedAt: T0 - HOUR });
		expect(summary()).toEqual([{ kind: "unmatched-end", at: T0 }]);
		expect(sessions.get(SUB.id)).toBeUndefined();
	});
});

describe("断流接续(决策 58)", () => {
	beforeEach(() => {
		settings = { ...settings, liveEndGrace: true, liveEndGraceMinutes: 3 };
	});

	it("等满了才结束,结束时刻是下播事件到达那一刻(等的那几分钟不算)", async () => {
		start();
		liveStart();
		await vi.advanceTimersByTimeAsync(HOUR);
		liveEnd();
		expect(summary().at(-1)).toEqual({ kind: "ending" });
		await vi.advanceTimersByTimeAsync(3 * MINUTE - 1);
		expect(summary().map((c) => c.kind)).toEqual(["start", "ending"]);
		expect(sessions.get(SUB.id)?.pendingEnd?.endedAt).toBe(T0 + HOUR);

		await vi.advanceTimersByTimeAsync(1);
		expect(summary().at(-1)).toEqual({ kind: "end", reason: "ended", at: T0 + HOUR });
		expect(sessions.get(SUB.id)).toBeUndefined();
	});

	it("等待期间又开播:同一场接着播,开播时刻沿用第一次的,不结束", async () => {
		start();
		liveStart();
		const first = sessions.get(SUB.id);
		await vi.advanceTimersByTimeAsync(HOUR);
		liveEnd();
		await vi.advanceTimersByTimeAsync(MINUTE);
		liveStart({ startedAt: Date.now() });
		await vi.advanceTimersByTimeAsync(10 * MINUTE);

		expect(summary().map((c) => c.kind)).toEqual(["start", "ending", "resume"]);
		expect(sessions.get(SUB.id)).toBe(first);
		expect(first?.startedAt).toBe(T0);
		expect(first?.pendingEnd).toBeUndefined();

		// 真下播:结束时刻是这一次下播事件到达的那一刻。
		liveEnd();
		const endedAt = Date.now();
		await vi.advanceTimersByTimeAsync(3 * MINUTE);
		expect(summary().at(-1)).toEqual({ kind: "end", reason: "ended", at: endedAt });
	});

	it("等待期间又报下播:忽略,结束时刻仍是第一次那一刻", async () => {
		start();
		liveStart();
		liveEnd();
		await vi.advanceTimersByTimeAsync(MINUTE);
		liveEnd();
		await vi.advanceTimersByTimeAsync(3 * MINUTE);
		expect(summary().slice(1)).toEqual([
			{ kind: "ending" },
			{ kind: "end", reason: "ended", at: T0 },
		]);
	});
});

// ADR-0020 决策 4:统计记的是「UP 做了什么」,与推送推没推无关。原来场次长在推送计时器里,开播与下播推送
// 都关着时这一场直接扔掉,统计就永远看不到这一场。
describe("与推送开关无关(ADR-0020 决策 4)", () => {
	it("开播与下播推送都关着:照样开一场、断流接续照样等、下播照样结束", async () => {
		settings = {
			liveStart: false,
			liveEnd: false,
			liveEndGrace: true,
			liveEndGraceMinutes: 3,
			liveStreaming: false,
			streamingIntervalHours: 1,
		};
		start();
		liveStart();
		expect(sessions.get(SUB.id)).toBeDefined();
		await vi.advanceTimersByTimeAsync(HOUR);
		liveEnd();
		await vi.advanceTimersByTimeAsync(MINUTE);
		liveStart({ startedAt: Date.now() });
		await vi.advanceTimersByTimeAsync(HOUR);
		liveEnd();
		const endedAt = Date.now();
		await vi.advanceTimersByTimeAsync(3 * MINUTE);

		expect(summary()).toEqual([
			{ kind: "start", trigger: "start-signal", startedAt: T0 },
			{ kind: "ending" },
			{ kind: "resume" },
			{ kind: "ending" },
			{ kind: "end", reason: "ended", at: endedAt },
		]);
		// 统计照样看得到这一场:一帧开始、一帧结束,断流那一下不算两场。
		expect(frames.map((f) => f.phase)).toEqual(["start", "end"]);
	});

	it("推送中途全关掉:这一场不结束", () => {
		start();
		liveStart();
		settings = { ...settings, liveStart: false, liveEnd: false };
		bus.emit("config-changed", { scope: "globals" });
		bus.emit("subscription-changed", { ops: [{ kind: "update", sub: SUB }] });
		liveStatus();
		expect(summary().map((c) => c.kind)).toEqual(["start", "status"]);
		expect(sessions.get(SUB.id)?.startedAt).toBe(T0);
	});
});

describe("作废(决策 61)", () => {
	it("拓展停了:它名下的当场结束(原因分得清),等着的下播不再等;别的拓展的不动", async () => {
		settings = { ...settings, liveEndGrace: true };
		start();
		liveStart();
		liveStart({}, OTHER);
		await vi.advanceTimersByTimeAsync(HOUR);
		liveEnd();
		bus.emit("extension-stopped", { extensionId: EXT });
		await vi.advanceTimersByTimeAsync(HOUR);

		const ends = changes.filter((c) => c.kind === "end");
		expect(ends).toEqual([
			expect.objectContaining({
				subscriptionId: SUB.id,
				reason: "extension-stopped",
				at: T0 + HOUR,
			}),
		]);
		expect(sessions.get(SUB.id)).toBeUndefined();
		expect(sessions.get(OTHER.id)).toBeDefined();
	});

	it("订阅停用 / 删了:当场结束,原因分得清", () => {
		start();
		liveStart();
		liveStart({}, OTHER);
		const disabled = { ...SUB, enabled: false };
		bus.emit("subscription-changed", { ops: [{ kind: "update", sub: disabled }] });
		bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: OTHER }] });
		expect(changes.filter((c) => c.kind === "end")).toEqual([
			expect.objectContaining({ subscriptionId: SUB.id, reason: "disabled" }),
			expect.objectContaining({ subscriptionId: OTHER.id, reason: "removed" }),
		]);
	});

	it("关机:在播的全部结束,原因是关机;之后的上报不再记", () => {
		start();
		liveStart();
		vi.advanceTimersByTime(HOUR);
		sessions.dispose();
		expect(summary().at(-1)).toEqual({ kind: "end", reason: "shutdown", at: T0 + HOUR });
		liveStart();
		expect(summary().map((c) => c.kind)).toEqual(["start", "end"]);
	});
});

// 统计(ADR-0020 决策 6)只认总线:一场的开始与结束各一帧,按订阅 id。断流接续里的那一下、直播状态、
// 手里没有这一场的下播都不上总线 —— 那些不是场次的边界。
describe("总线上的场次事件(给统计)", () => {
	it("开播事件开一场:一帧开始,开播时刻取事件的,触发是开播事件", () => {
		start();
		liveStart({ startedAt: T0 - MINUTE });
		expect(frames).toEqual([
			{
				phase: "start",
				subscriptionId: SUB.id,
				extensionId: EXT,
				startedAt: iso(T0 - MINUTE),
				at: iso(T0),
				trigger: "liveStart",
			},
		]);
	});

	it("状态认出的一场:开播时刻取状态带的;没带就取收到的那一刻", () => {
		start();
		liveStatus({ startedAt: T0 - HOUR });
		liveStatus({}, OTHER);
		expect(frames).toEqual([
			expect.objectContaining({
				phase: "start",
				subscriptionId: SUB.id,
				startedAt: iso(T0 - HOUR),
				trigger: "liveStatus",
			}),
			expect.objectContaining({
				phase: "start",
				subscriptionId: OTHER.id,
				extensionId: "kuaishou",
				startedAt: iso(T0),
				at: iso(T0),
				trigger: "liveStatus",
			}),
		]);
	});

	it("一场的开始帧与结束帧带同一个开播时刻 —— 之后的状态补上了真开播时刻也不换(不然两帧对不上)", () => {
		start();
		liveStatus({}, OTHER);
		vi.advanceTimersByTime(MINUTE);
		liveStatus({ startedAt: T0 - HOUR }, OTHER);
		vi.advanceTimersByTime(HOUR);
		liveEnd({}, OTHER);
		expect(frames.map((f) => [f.phase, f.startedAt])).toEqual([
			["start", iso(T0)],
			["end", iso(T0)],
		]);
	});

	it("断流接续:等待期间又开播不发任何帧;真下播等满了才发结束帧,结束时刻是那次下播事件到达的时刻", async () => {
		settings = { ...settings, liveEndGrace: true, liveEndGraceMinutes: 3 };
		start();
		liveStart();
		await vi.advanceTimersByTimeAsync(HOUR);
		liveEnd();
		await vi.advanceTimersByTimeAsync(MINUTE);
		liveStart({ startedAt: Date.now() });
		await vi.advanceTimersByTimeAsync(HOUR);
		expect(frames.map((f) => f.phase)).toEqual(["start"]);

		liveEnd();
		const endedAt = Date.now();
		await vi.advanceTimersByTimeAsync(3 * MINUTE - 1);
		expect(frames.map((f) => f.phase)).toEqual(["start"]);
		await vi.advanceTimersByTimeAsync(1);
		expect(frames).toEqual([
			expect.objectContaining({ phase: "start", startedAt: iso(T0) }),
			{
				phase: "end",
				subscriptionId: SUB.id,
				extensionId: EXT,
				startedAt: iso(T0),
				at: iso(endedAt),
				reason: "ended",
			},
		]);
	});

	it("结束原因分得清:拓展停了、订阅停用、订阅删了、没报下播又开播、关机", () => {
		const third = makeExtensionSubscription({
			id: "e0000000-0000-4000-8000-000000000003",
			extensionId: EXT,
			externalId: "sec-uid-3",
		});
		subs.set(third.id, third);
		start();
		liveStart();
		liveStart({}, OTHER);
		liveStart({}, third);
		vi.advanceTimersByTime(MINUTE);
		liveStart({ startedAt: Date.now() }, third);
		bus.emit("subscription-changed", {
			ops: [{ kind: "update", sub: { ...OTHER, enabled: false } }],
		});
		bus.emit("extension-stopped", { extensionId: EXT });
		const endsSoFar = frames.filter((f) => f.phase === "end");
		expect(endsSoFar.map((f) => [f.subscriptionId, f.phase === "end" && f.reason])).toEqual([
			[third.id, "superseded"],
			[OTHER.id, "disabled"],
			[SUB.id, "extension-stopped"],
			[third.id, "extension-stopped"],
		]);

		liveStart({}, OTHER);
		bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: OTHER }] });
		liveStart();
		sessions.dispose();
		const last = frames.filter((f) => f.phase === "end").slice(4);
		expect(last.map((f) => [f.subscriptionId, f.phase === "end" && f.reason])).toEqual([
			[OTHER.id, "removed"],
			[SUB.id, "shutdown"],
		]);
	});

	it("拓展停了又跑起来:按开播时刻接回同一场 —— 结束帧之后的开始帧带着原来那个开播时刻", () => {
		start();
		liveStart({ startedAt: T0 - HOUR });
		vi.advanceTimersByTime(MINUTE);
		bus.emit("extension-stopped", { extensionId: EXT });
		vi.advanceTimersByTime(MINUTE);
		liveStatus({ startedAt: T0 - HOUR });
		expect(frames).toEqual([
			expect.objectContaining({ phase: "start", startedAt: iso(T0 - HOUR), trigger: "liveStart" }),
			expect.objectContaining({
				phase: "end",
				startedAt: iso(T0 - HOUR),
				at: iso(T0 + MINUTE),
				reason: "extension-stopped",
			}),
			expect.objectContaining({
				phase: "start",
				startedAt: iso(T0 - HOUR),
				at: iso(T0 + 2 * MINUTE),
				trigger: "liveStatus",
			}),
		]);
	});

	it("BN 重启:关机补一帧结束;新起来的一份见到在播,开始帧带着原来那个开播时刻", () => {
		start();
		liveStart({ startedAt: T0 - HOUR });
		vi.advanceTimersByTime(MINUTE);
		sessions.dispose();
		table.dispose();
		vi.advanceTimersByTime(MINUTE);
		start();
		liveStatus({ startedAt: T0 - HOUR });
		expect(
			frames.map((f) => [f.phase, f.startedAt, f.phase === "end" ? f.reason : f.trigger]),
		).toEqual([
			["start", iso(T0 - HOUR), "liveStart"],
			["end", iso(T0 - HOUR), "shutdown"],
			["start", iso(T0 - HOUR), "liveStatus"],
		]);
	});

	it("不是场次边界的不上总线:直播状态、下播进断流等待、手里没有这一场的下播", async () => {
		settings = { ...settings, liveEndGrace: true };
		start();
		liveEnd();
		report({ kind: "liveStatus", value: { live: false } });
		expect(frames).toEqual([]);
		liveStart();
		liveStatus({ totalViewers: 3 });
		liveEnd();
		expect(frames.map((f) => f.phase)).toEqual(["start"]);
	});
});

// ADR-0020 决策 7:统计的峰值 = 本场累计观看。累计只增不减,所以就是这一场报过的最大 `totalViewers`;
// 场次在这里算,这一场报过什么也只有这里全看得见 —— 结束帧带着它,统计照抄。
describe("本场累计观看(ADR-0020 决策 7)", () => {
	/** 这一轮总线上的结束帧:订阅 id 与带的累计观看。 */
	const ends = () =>
		frames.flatMap((f) => (f.phase === "end" ? [[f.subscriptionId, f.totalViewers]] : []));

	it("取开播 / 直播状态 / 下播报过的最大 totalViewers;此刻在线再大也不算", () => {
		start();
		liveStart({ totalViewers: 100, viewers: 90_000 });
		liveStatus({ totalViewers: 800, viewers: 90_000 });
		liveStatus({ viewers: 99_999 });
		expect(sessions.get(SUB.id)?.peakTotalViewers).toBe(800);
		liveEnd({ totalViewers: 900 });
		expect(ends()).toEqual([[SUB.id, 900]]);
	});

	it("报小了的那一份不往下拽(只留最大的)", () => {
		start();
		liveStart({ totalViewers: 500 });
		liveStatus({ totalViewers: 300 });
		liveEnd();
		expect(ends()).toEqual([[SUB.id, 500]]);
	});

	it("只报此刻在线的平台:结束帧不带这一格,不拿在线顶替", () => {
		start();
		liveStart({ viewers: 50 });
		liveStatus({ viewers: 60 });
		liveEnd({ viewers: 70 });
		const end = frames.find((f) => f.phase === "end");
		expect(end).toBeDefined();
		expect(end).not.toHaveProperty("totalViewers");
	});

	it("靠在播状态认出的一场:认出它的那一份就算(BN 半路起来,这个数已经很大了)", () => {
		start();
		liveStatus({ startedAt: T0 - HOUR, totalViewers: 50_000 });
		liveEnd();
		expect(ends()).toEqual([[SUB.id, 50_000]]);
	});

	it("不在播的状态(还没等到下播事件)报的也算这一场的", () => {
		start();
		liveStart({ totalViewers: 10 });
		report({ kind: "liveStatus", value: { live: false, totalViewers: 70 } });
		liveEnd();
		expect(ends()).toEqual([[SUB.id, 70]]);
	});

	it("断流接续是同一场:接着取,不从头来", async () => {
		settings = { ...settings, liveEndGrace: true, liveEndGraceMinutes: 3 };
		start();
		liveStart({ totalViewers: 10 });
		liveEnd({ totalViewers: 40 });
		await vi.advanceTimersByTimeAsync(MINUTE);
		// 平台那头断流重开,累计从头数了 —— 但在 BN 这里还是同一场,前面那 40 不丢。
		liveStart({ startedAt: Date.now(), totalViewers: 5 });
		liveStatus({ totalViewers: 30 });
		liveEnd();
		await vi.advanceTimersByTimeAsync(3 * MINUTE);
		expect(ends()).toEqual([[SUB.id, 40]]);
	});

	it("新的一场从头取:没报下播又开播,新一场开播带的数不算到上一场头上", () => {
		start();
		liveStart({ startedAt: T0, totalViewers: 10 });
		liveStatus({ totalViewers: 700 });
		vi.advanceTimersByTime(HOUR);
		liveStart({ startedAt: Date.now(), totalViewers: 5 });
		liveEnd();
		expect(ends()).toEqual([
			[SUB.id, 700],
			[SUB.id, 5],
		]);
	});

	it("下播之后再开的一场也从头取:上一场的数、两场之间不在播的状态都带不过来", () => {
		start();
		liveStart({ totalViewers: 400 });
		liveEnd();
		report({ kind: "liveStatus", value: { live: false, totalViewers: 9_999 } });
		liveStart({ startedAt: Date.now() });
		liveEnd();
		expect(ends()).toEqual([
			[SUB.id, 400],
			[SUB.id, undefined],
		]);
	});

	it("拓展停了 / 订阅停用 / 关机补的结束帧同样带着", () => {
		start();
		liveStart({ totalViewers: 1 });
		liveStart({ totalViewers: 2 }, OTHER);
		bus.emit("subscription-changed", {
			ops: [{ kind: "update", sub: { ...OTHER, enabled: false } }],
		});
		bus.emit("extension-stopped", { extensionId: EXT });
		subs.set(SUB.id, SUB);
		liveStart({ startedAt: Date.now(), totalViewers: 3 });
		expect(
			frames.filter((f) => f.phase === "end").map((f) => f.phase === "end" && f.reason),
		).toEqual(["disabled", "extension-stopped"]);
		sessions.dispose();
		expect(ends()).toEqual([
			[OTHER.id, 2],
			[SUB.id, 1],
			[SUB.id, 3],
		]);
	});
});

describe("Devtools tickNow", () => {
	it("在播且这一场仍有效:立刻向来源核一次,回 true", async () => {
		const fetch = vi.fn(async () => ({
			ok: true as const,
			kind: "live" as const,
			details: { title: "刚才那场" },
		}));
		start({ has: () => true, fetch });
		liveStart();

		await expect(sessions.tickNow(SUB.id)).resolves.toBe(true);

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(SUB.identity, expect.any(AbortSignal));
	});

	it("没在播:不跑,回 false", async () => {
		const fetch = vi.fn();
		start({ has: () => true, fetch });
		await expect(sessions.tickNow(SUB.id)).resolves.toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("断流等待中:不提前到期,回 false", async () => {
		const fetch = vi.fn();
		settings.liveEndGrace = true;
		start({ has: () => true, fetch });
		liveStart();
		liveEnd();

		await expect(sessions.tickNow(SUB.id)).resolves.toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("断流等待到期时再核来源", () => {
	it("等待到期但 B站已重开(漏帧)→ 不下播,恢复复推", async () => {
		const fetch = vi.fn(async () => ({
			ok: true as const,
			kind: "live" as const,
			details: { title: "还在播" },
		}));
		settings.liveEndGrace = true;
		start({ has: () => true, fetch });
		liveStart();
		liveEnd();

		await vi.advanceTimersByTimeAsync((settings.liveEndGraceMinutes ?? 2) * MINUTE);

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(summary().some((change) => change.kind === "end")).toBe(false);
		expect(sessions.get(SUB.id)).toBeDefined();
	});
});
