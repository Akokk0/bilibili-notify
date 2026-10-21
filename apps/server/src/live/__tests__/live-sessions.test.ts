/**
 * 拓展订阅的直播场次(`createLiveSessionEngine`,ADR-0020 决策 6;ADR-0019 决策 53 / 57 / 58 / 61)。
 *
 * 喂一条真的总线、一张真的在播表,时钟走假定时器,看场次的每一次变化:
 * - 一场从开播事件开始,或从 BN 开始看之后见到的在播状态开始;下播只由事件结束(决策 53);
 * - 断流接续:下播先压着,等待期间再开播是同一场、开播时刻不变;等满了才结束,结束时刻是下播事件到达那一刻
 *   (决策 58);
 * - 拓展停了 / 订阅停用或删了 / 关机:当场结束,原因分得清(决策 61);
 * - 与推送开关无关(ADR-0020 决策 4);每一种场次变化都发上总线(`live-session-changed`)。
 *
 * ⚠️ 这个文件用假定时器:别用 `waitFor` / `findBy*`(会死锁),推进时间一律 `advanceTimersByTimeAsync`。
 */

import type {
	LiveDetails,
	LiveSessionChange,
	Subscription,
	SubscriptionReport,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import {
	createLiveSessionEngine,
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
const logger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

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
/** 总线上听到的每一发 `live-session-changed`。 */
let frames: LiveSessionChange[];
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
				return { kind: c.kind, reason: c.reason, endedAt: c.endedAt };
			case "status":
				return { kind: c.kind, isLive: c.isLive };
			case "unmatched-end":
				return { kind: c.kind, endedAt: c.endedAt };
			default:
				return { kind: c.kind };
		}
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	bus = createNodeMessageBus();
	bus.on("live-session-changed", (event) => frames.push(event));
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
	for (const fn of Object.values(logger)) fn.mockClear();
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

		expect(summary()).toEqual([
			{ kind: "start", trigger: "start-signal", startedAt: iso(T0 - MINUTE) },
		]);
		const session = sessions.get(SUB.id);
		expect(session).toMatchObject({
			subscriptionId: SUB.id,
			sourceKey: EXT,
			startedAt: iso(T0 - MINUTE),
			detectedAt: iso(T0),
			followersAtStart: 12_345,
			lastDetails: { totalViewers: 40 },
		});
	});

	it("交给监听者的场次是纯数据,时刻用 ISO", () => {
		start({
			has: () => true,
			fetch: async () => ({ ok: false, code: "unused", message: "unused" }),
		});
		liveStart({ startedAt: T0 - MINUTE });

		const change = changes[0];
		if (change?.kind !== "start") throw new Error("expected a start change");
		expect(change.session).toEqual(JSON.parse(JSON.stringify(change.session)));
		expect(change.session).not.toHaveProperty("busStartedAt");
		expect(change.session.startedAt).toBe(iso(T0 - MINUTE));
		expect(change.session.detectedAt).toBe(iso(T0));

		const current = sessions.get(SUB.id);
		expect(current).toEqual(JSON.parse(JSON.stringify(current)));
		expect(current).not.toHaveProperty("busStartedAt");
		expect(current?.detectedAt).toBe(iso(T0));
	});

	it("BN 开始看之后见到在播:认出一场,开播时刻取状态带的;没带就空着,之后的状态带了再补上", () => {
		start();
		liveStatus();
		expect(summary()).toEqual([{ kind: "start", trigger: "status-signal", startedAt: undefined }]);
		expect(sessions.get(SUB.id)?.detectedAt).toBe(iso(T0));

		liveStatus({ startedAt: T0 - HOUR, totalViewers: 9 });
		expect(summary().at(-1)).toEqual({ kind: "status", isLive: true });
		expect(sessions.get(SUB.id)).toMatchObject({
			startedAt: iso(T0 - HOUR),
			lastDetails: { totalViewers: 9 },
		});
	});

	it("不在播的状态不动这一场:BN 不拿状态的翻转猜下播(决策 53)", () => {
		start();
		liveStart();
		report({ kind: "liveStatus", value: { live: false } });
		expect(summary()).toEqual([
			{ kind: "start", trigger: "start-signal", startedAt: iso(T0) },
			{ kind: "status", isLive: false },
		]);
		expect(sessions.get(SUB.id)).toBeDefined();
	});

	it("没报下播就又开播了:上一场在新的一场开播时收掉", () => {
		start();
		liveStart();
		vi.advanceTimersByTime(HOUR);
		liveStart({ startedAt: Date.now(), title: "第二场" });
		expect(summary()).toEqual([
			{ kind: "start", trigger: "start-signal", startedAt: iso(T0) },
			{ kind: "end", reason: "superseded", endedAt: iso(T0 + HOUR) },
			{ kind: "start", trigger: "start-signal", startedAt: iso(T0 + HOUR) },
		]);
	});

	it("在播状态报了另一个开播时刻:上一场 superseded 收掉,再按状态认出新的一场", () => {
		start();
		liveStart({ startedAt: T0 - MINUTE, title: "第一场", totalViewers: 40 });
		vi.advanceTimersByTime(HOUR);
		liveStatus({ startedAt: T0 + HOUR + MINUTE, totalViewers: 5 });

		expect(summary()).toEqual([
			{ kind: "start", trigger: "start-signal", startedAt: iso(T0 - MINUTE) },
			{ kind: "end", reason: "superseded", endedAt: iso(T0 + HOUR) },
			{
				kind: "start",
				trigger: "status-signal",
				startedAt: iso(T0 + HOUR + MINUTE),
			},
		]);
		expect(sessions.get(SUB.id)).toMatchObject({
			startedAt: iso(T0 + HOUR + MINUTE),
			lastDetails: { totalViewers: 5 },
			peakTotalViewers: 5,
		});
		expect(changes[1]).toMatchObject({
			kind: "end",
			session: { peakTotalViewers: 40 },
		});
		expect(table.get(SUB.id)).toMatchObject({
			startedAt: T0 + HOUR + MINUTE,
			details: { totalViewers: 5 },
		});
		expect(table.get(SUB.id)?.details).not.toHaveProperty("title");
		expect(
			frames.map((frame) => [
				frame.kind,
				frame.kind === "end" ? frame.reason : frame.kind === "start" ? frame.trigger : undefined,
			]),
		).toEqual([
			["start", "start-signal"],
			["end", "superseded"],
			["start", "status-signal"],
		]);
	});

	it("在播状态带的开播时刻与手里相同:仍当这一场,只发 status", () => {
		start();
		liveStart({ startedAt: T0 - MINUTE });
		liveStatus({ startedAt: T0 - MINUTE, totalViewers: 20 });

		expect(summary()).toEqual([
			{ kind: "start", trigger: "start-signal", startedAt: iso(T0 - MINUTE) },
			{ kind: "status", isLive: true },
		]);
		expect(sessions.get(SUB.id)).toMatchObject({
			startedAt: iso(T0 - MINUTE),
			lastDetails: { totalViewers: 20 },
		});
	});

	it("断流等待里的在播状态带另一个开播时刻:照旧接续同一场,不按状态分场", () => {
		settings = { ...settings, liveEndGrace: true, liveEndGraceMinutes: 3 };
		start();
		liveStart({ startedAt: T0 - MINUTE });
		liveEnd();
		liveStatus({ startedAt: T0 + HOUR, totalViewers: 30 });

		expect(summary()).toEqual([
			{ kind: "start", trigger: "start-signal", startedAt: iso(T0 - MINUTE) },
			{ kind: "ending" },
			{ kind: "status", isLive: true },
		]);
		expect(sessions.get(SUB.id)).toMatchObject({
			startedAt: iso(T0 - MINUTE),
			pendingEnd: { endedAt: iso(T0) },
			lastDetails: { totalViewers: 30 },
		});
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
		expect(summary().at(-1)).toEqual({
			kind: "end",
			reason: "signal",
			endedAt: iso(T0 + 2 * HOUR),
		});
		expect(sessions.get(SUB.id)).toBeUndefined();
	});

	it("结束原因分得清:来源报的下播当场结束是 signal,断流等待到期是 grace-expired", async () => {
		start();
		liveStart();
		liveEnd();
		settings = { ...settings, liveEndGrace: true, liveEndGraceMinutes: 3 };
		liveStart({ startedAt: Date.now() });
		liveEnd();
		await vi.advanceTimersByTimeAsync(3 * MINUTE);

		expect(changes.flatMap((change) => (change.kind === "end" ? [change.reason] : []))).toEqual([
			"signal",
			"grace-expired",
		]);
	});

	it("下播事件来了手里却没有这一场:照实说,不编一场出来", () => {
		start();
		liveEnd({ startedAt: T0 - HOUR });
		expect(summary()).toEqual([{ kind: "unmatched-end", endedAt: iso(T0) }]);
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
		expect(sessions.get(SUB.id)?.pendingEnd?.endedAt).toBe(iso(T0 + HOUR));

		await vi.advanceTimersByTimeAsync(1);
		expect(summary().at(-1)).toEqual({
			kind: "end",
			reason: "grace-expired",
			endedAt: iso(T0 + HOUR),
		});
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
		expect(sessions.get(SUB.id)).toEqual(first);
		expect(sessions.get(SUB.id)?.startedAt).toBe(iso(T0));
		expect(sessions.get(SUB.id)?.pendingEnd).toBeUndefined();

		// 真下播:结束时刻是这一次下播事件到达的那一刻。
		liveEnd();
		const endedAt = Date.now();
		await vi.advanceTimersByTimeAsync(3 * MINUTE);
		expect(summary().at(-1)).toEqual({
			kind: "end",
			reason: "grace-expired",
			endedAt: iso(endedAt),
		});
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
			{ kind: "end", reason: "grace-expired", endedAt: iso(T0) },
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
			{ kind: "start", trigger: "start-signal", startedAt: iso(T0) },
			{ kind: "ending" },
			{ kind: "resume" },
			{ kind: "ending" },
			{ kind: "end", reason: "grace-expired", endedAt: iso(endedAt) },
		]);
		// 统计照样看得到这一场:一帧开始、一帧结束,断流那一下不算两场。
		expect(frames.filter((f) => f.kind === "start" || f.kind === "end").map((f) => f.kind)).toEqual(
			["start", "end"],
		);
	});

	it("推送中途全关掉:这一场不结束", () => {
		start();
		liveStart();
		settings = { ...settings, liveStart: false, liveEnd: false };
		bus.emit("config-changed", { scope: "globals" });
		bus.emit("subscription-changed", { ops: [{ kind: "update", sub: SUB }] });
		liveStatus();
		expect(summary().map((c) => c.kind)).toEqual(["start", "status"]);
		expect(sessions.get(SUB.id)?.startedAt).toBe(iso(T0));
	});
});

describe("作废(决策 61)", () => {
	it("来源停了:日志带出这个起因", () => {
		start();
		liveStart();
		bus.emit("extension-stopped", { extensionId: EXT });

		expect(logger.debug.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"来源停了",
		);
	});

	it("订阅停用了:日志带出这个起因", () => {
		start();
		liveStart();
		bus.emit("subscription-changed", {
			ops: [{ kind: "update", sub: { ...SUB, enabled: false } }],
		});

		expect(logger.debug.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"订阅停用了",
		);
	});

	it("订阅删了:日志带出这个起因", () => {
		start();
		liveStart();
		bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: SUB }] });

		expect(logger.debug.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"订阅删了",
		);
	});

	it("关机:日志带出这个起因", () => {
		start();
		liveStart();
		sessions.dispose();

		expect(logger.debug.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"关机",
		);
	});

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
				reason: "stopped",
				endedAt: iso(T0 + HOUR),
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
			expect.objectContaining({ subscriptionId: SUB.id, reason: "stopped" }),
			expect.objectContaining({ subscriptionId: OTHER.id, reason: "stopped" }),
		]);
	});

	it("关机:在播的全部结束,原因是关机;之后的上报不再记", () => {
		start();
		liveStart();
		vi.advanceTimersByTime(HOUR);
		sessions.dispose();
		expect(summary().at(-1)).toEqual({
			kind: "end",
			reason: "stopped",
			endedAt: iso(T0 + HOUR),
		});
		liveStart();
		expect(summary().map((c) => c.kind)).toEqual(["start", "end"]);
	});
});

// 统计(ADR-0020 决策 6)只认总线上的中立场次投影:每一种变化都发,载荷与进程内监听者看到的一致。
describe("总线上的场次事件(给统计)", () => {
	it("开播事件开一场:一帧 start,开播时刻与触发都取这一场的", () => {
		start();
		liveStart({ startedAt: T0 - MINUTE });
		expect(frames).toEqual([
			expect.objectContaining({
				kind: "start",
				subscriptionId: SUB.id,
				session: expect.objectContaining({
					subscriptionId: SUB.id,
					sourceKey: EXT,
					startedAt: iso(T0 - MINUTE),
					detectedAt: iso(T0),
				}),
				trigger: "start-signal",
			}),
		]);
	});

	it("状态认出的一场:开播时刻取状态带的;没带就空着,交给统计按认出时刻兜底", () => {
		start();
		liveStatus({ startedAt: T0 - HOUR });
		liveStatus({}, OTHER);
		expect(
			frames.map((change) =>
				change.kind === "start"
					? [change.session.subscriptionId, change.session.startedAt, change.trigger]
					: change.kind,
			),
		).toEqual([
			[SUB.id, iso(T0 - HOUR), "status-signal"],
			[OTHER.id, undefined, "status-signal"],
		]);
	});

	it("开始帧还没开播时刻:之后的状态补上,后续投影带着它", () => {
		start();
		liveStatus({}, OTHER);
		vi.advanceTimersByTime(MINUTE);
		liveStatus({ startedAt: T0 - HOUR }, OTHER);
		vi.advanceTimersByTime(HOUR);
		liveEnd({}, OTHER);
		expect(
			frames
				.filter((change) => change.kind === "start" || change.kind === "end")
				.map((change) =>
					change.kind === "start" || change.kind === "end"
						? [change.kind, change.session.startedAt]
						: [],
				),
		).toEqual([
			["start", undefined],
			["end", iso(T0 - HOUR)],
		]);
	});

	it("断流接续的每一段变化都上总线:ending / resume / 真结束各一帧", async () => {
		settings = { ...settings, liveEndGrace: true, liveEndGraceMinutes: 3 };
		start();
		liveStart();
		await vi.advanceTimersByTimeAsync(HOUR);
		liveEnd();
		await vi.advanceTimersByTimeAsync(MINUTE);
		liveStart({ startedAt: Date.now() });
		await vi.advanceTimersByTimeAsync(HOUR);
		expect(frames.map((change) => change.kind)).toEqual(["start", "ending", "resume"]);

		liveEnd();
		const endedAt = Date.now();
		await vi.advanceTimersByTimeAsync(3 * MINUTE - 1);
		expect(frames.map((change) => change.kind)).toEqual(["start", "ending", "resume", "ending"]);
		await vi.advanceTimersByTimeAsync(1);
		expect(frames.at(-1)).toEqual(
			expect.objectContaining({
				kind: "end",
				subscriptionId: SUB.id,
				endedAt: iso(endedAt),
				reason: "grace-expired",
				session: expect.objectContaining({ startedAt: iso(T0) }),
			}),
		);
	});

	it("结束原因分得清:停止的四种起因都是 stopped,没报下播又开播是 superseded", () => {
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
		const ends = () =>
			frames.flatMap((change) =>
				change.kind === "end" ? [[change.subscriptionId, change.reason]] : [],
			);
		expect(ends()).toEqual([
			[third.id, "superseded"],
			[OTHER.id, "stopped"],
			[SUB.id, "stopped"],
			[third.id, "stopped"],
		]);

		liveStart({}, OTHER);
		bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: OTHER }] });
		liveStart();
		sessions.dispose();
		expect(ends().slice(4)).toEqual([
			[OTHER.id, "stopped"],
			[SUB.id, "stopped"],
		]);
	});

	it("拓展停了又跑起来:同一开播时刻先 end 再 start", () => {
		start();
		liveStart({ startedAt: T0 - HOUR });
		vi.advanceTimersByTime(MINUTE);
		bus.emit("extension-stopped", { extensionId: EXT });
		vi.advanceTimersByTime(MINUTE);
		liveStatus({ startedAt: T0 - HOUR });
		expect(
			frames.map((change) =>
				change.kind === "start" || change.kind === "end"
					? [change.kind, change.session.startedAt]
					: [change.kind],
			),
		).toEqual([
			["start", iso(T0 - HOUR)],
			["end", iso(T0 - HOUR)],
			["start", iso(T0 - HOUR)],
		]);
	});

	it("BN 重启:关机补一帧 end;新起来的一份见到在播,start 带着原来那个开播时刻", () => {
		start();
		liveStart({ startedAt: T0 - HOUR });
		vi.advanceTimersByTime(MINUTE);
		sessions.dispose();
		table.dispose();
		vi.advanceTimersByTime(MINUTE);
		start();
		liveStatus({ startedAt: T0 - HOUR });
		expect(
			frames.map((change) =>
				change.kind === "start" || change.kind === "end"
					? [change.kind, change.session.startedAt]
					: [change.kind],
			),
		).toEqual([
			["start", iso(T0 - HOUR)],
			["end", iso(T0 - HOUR)],
			["start", iso(T0 - HOUR)],
		]);
	});

	it("每种变化都上总线:unmatched-end、不在播 status、在播 status、进断流等待", () => {
		settings = { ...settings, liveEndGrace: true };
		start();
		liveEnd();
		report({ kind: "liveStatus", value: { live: false } });
		liveStart();
		liveStatus({ totalViewers: 3 });
		liveEnd();
		expect(frames.map((change) => change.kind)).toEqual([
			"unmatched-end",
			"status",
			"start",
			"status",
			"ending",
		]);
		expect(frames[1]).toEqual({
			kind: "status",
			subscriptionId: SUB.id,
			isLive: false,
			session: undefined,
		});
		expect(frames[3]).toEqual(
			expect.objectContaining({
				kind: "status",
				subscriptionId: SUB.id,
				isLive: true,
				session: expect.objectContaining({ subscriptionId: SUB.id }),
			}),
		);
	});
});

// ADR-0020 决策 7:统计的峰值 = 本场累计观看。累计只增不减,所以就是这一场报过的最大 `totalViewers`;
// 场次在这里算,这一场报过什么也只有这里全看得见 —— 结束帧带着它,统计照抄。
describe("本场累计观看(ADR-0020 决策 7)", () => {
	/** 这一轮总线上的结束帧:订阅 id 与带的累计观看。 */
	const ends = () =>
		frames.flatMap((f) =>
			f.kind === "end" ? [[f.subscriptionId, f.session.peakTotalViewers]] : [],
		);

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
		const end = frames.find((f) => f.kind === "end");
		expect(end).toBeDefined();
		expect(end?.kind === "end" && end.session).not.toHaveProperty("peakTotalViewers");
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
		expect(frames.filter((f) => f.kind === "end").map((f) => f.kind === "end" && f.reason)).toEqual(
			["stopped", "stopped"],
		);
		sessions.dispose();
		expect(ends()).toEqual([
			[OTHER.id, 2],
			[SUB.id, 1],
			[SUB.id, 3],
		]);
	});
});

describe("本场互动汇总", () => {
	const endOfCurrent = (): Extract<LiveSessionChange, { kind: "end" }> => {
		liveEnd();
		const change = changes.at(-1);
		if (change?.kind !== "end") throw new Error("expected an end change");
		return change;
	};

	it("两个人各发两条弹幕:条数逐条累计,人数按 viewer.id 去重", () => {
		start();
		liveStart();
		for (let index = 0; index < 2; index += 1) {
			sessions.noteInteraction(SUB.id, {
				kind: "viewerChat",
				viewer: { id: "viewer-1", name: "同名" },
				text: "第一条",
			});
			sessions.noteInteraction(SUB.id, {
				kind: "viewerChat",
				viewer: { id: "viewer-2", name: "同名" },
				text: "第二条",
			});
		}

		expect(endOfCurrent().session.interactions).toEqual({
			viewerChatCount: 4,
			viewerChatSenderCount: 2,
		});
	});

	it("醒目留言按条累计,金额按币种分别求和", () => {
		start();
		liveStart();
		for (const superchat of [
			{ amount: 5, currency: "USD" },
			{ amount: 30, currency: "CNY" },
			{ amount: 20, currency: "CNY" },
		]) {
			sessions.noteInteraction(SUB.id, {
				kind: "superchat",
				viewer: { id: "supporter", name: "支持的观众" },
				text: "加油",
				...superchat,
			});
		}

		expect(endOfCurrent().session.interactions).toEqual({
			superchatCount: 3,
			superchatTotals: { USD: 5, CNY: 50 },
		});
	});

	it("会员按体系和档累计,赠送按正整数 count 计数", () => {
		start();
		liveStart();
		const membership = (
			tier: string,
			over: { action?: "new" | "renew" | "upgrade"; gift?: { gifter: string; count: number } } = {},
		) =>
			sessions.noteInteraction(SUB.id, {
				kind: "membership",
				viewer: { id: `member-${tier}`, name: "会员" },
				program: "p",
				tier: { key: tier, name: tier },
				...over,
			});
		membership("a");
		membership("a", { gift: { gifter: "member-a", count: 3 } });
		membership("b", { action: "renew" });

		expect(endOfCurrent().session.interactions).toEqual({
			membershipCounts: { p: { a: 4, b: 1 } },
		});
	});

	it("断流接续接着记,新的一场从零记", async () => {
		settings = { ...settings, liveEndGrace: true, liveEndGraceMinutes: 3 };
		start();
		liveStart();
		const chat = (id: string) =>
			sessions.noteInteraction(SUB.id, {
				kind: "viewerChat",
				viewer: { id, name: id },
				text: "还在这一场",
			});
		chat("before-gap");
		liveEnd();
		chat("during-gap");
		await vi.advanceTimersByTimeAsync(MINUTE);
		liveStart({ startedAt: Date.now() });
		chat("after-resume");
		liveEnd();
		await vi.advanceTimersByTimeAsync(3 * MINUTE);

		const firstEnd = changes.filter((change) => change.kind === "end").at(-1);
		expect(firstEnd?.session.interactions).toEqual({
			viewerChatCount: 3,
			viewerChatSenderCount: 3,
		});

		liveStart({ startedAt: Date.now() });
		chat("next-session");
		liveStatus({ startedAt: Date.now() + MINUTE });
		const secondEnd = changes.filter((change) => change.kind === "end").at(-1);
		expect(secondEnd).toMatchObject({
			reason: "superseded",
			session: {
				interactions: {
					viewerChatCount: 1,
					viewerChatSenderCount: 1,
				},
			},
		});
		expect(sessions.get(SUB.id)).not.toHaveProperty("interactions");
	});

	it("手里没有这一场时记一笔什么都不发生,之后开的场也不带", () => {
		start();
		sessions.noteInteraction(SUB.id, {
			kind: "viewerChat",
			viewer: { id: "too-early", name: "来早了" },
			text: "还没开播",
		});
		liveStart();
		expect(sessions.get(SUB.id)).not.toHaveProperty("interactions");
		expect(endOfCurrent().session).not.toHaveProperty("interactions");
	});

	it("一条互动都没记过:结束帧的场次没有 interactions", () => {
		start();
		liveStart();
		expect(endOfCurrent().session).not.toHaveProperty("interactions");
	});

	it("结束帧带着汇总时仍是纯数据,里面没有观众 id", () => {
		start();
		liveStart();
		sessions.noteInteraction(SUB.id, {
			kind: "viewerChat",
			viewer: { id: "private-viewer-id", name: "观众" },
			text: "你好",
		});
		sessions.noteInteraction(SUB.id, {
			kind: "membership",
			viewer: { id: "private-member-id", name: "会员" },
			program: "p",
			tier: { key: "a", name: "a" },
		});

		const session = endOfCurrent().session;
		expect(session).toEqual(JSON.parse(JSON.stringify(session)));
		expect(JSON.stringify(session)).not.toContain("private-viewer-id");
		expect(JSON.stringify(session)).not.toContain("private-member-id");
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
