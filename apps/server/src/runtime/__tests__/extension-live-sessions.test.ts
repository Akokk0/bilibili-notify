/**
 * 拓展订阅的直播场次(`createExtensionLiveSessions`,ADR-0020 决策 6;ADR-0019 决策 53 / 57 / 58 / 61)。
 *
 * 喂一条真的总线、一张真的在播表,时钟走假定时器,看场次的每一次变化:
 * - 一场从开播事件开始,或从 BN 开始看之后见到的在播状态开始;下播只由事件结束(决策 53);
 * - 断流接续:下播先压着,等待期间再开播是同一场、开播时刻不变;等满了才结束,结束时刻是下播事件到达那一刻
 *   (决策 58);
 * - 拓展停了 / 订阅停用或删了 / 关机:当场结束,原因分得清(决策 61)。
 *
 * ⚠️ 这个文件用假定时器:别用 `waitFor` / `findBy*`(会死锁),推进时间一律 `advanceTimersByTimeAsync`。
 */

import type { Subscription, SubscriptionReport } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import type { LiveWorkSettings } from "../engines.js";
import { createExtensionLiveTable, type ExtensionLiveTable } from "../extension-live.js";
import {
	createExtensionLiveSessions,
	type ExtensionLiveSessionChange,
	type ExtensionLiveSessions,
} from "../extension-live-sessions.js";
import { createNodeMessageBus } from "../message-bus.js";

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
	"live" | "liveEnd" | "liveEndGrace" | "liveEndGraceMinutes"
>;

let bus: ReturnType<typeof createNodeMessageBus>;
let table: ExtensionLiveTable;
let sessions: ExtensionLiveSessions;
let changes: ExtensionLiveSessionChange[];
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

function start(): void {
	table = createExtensionLiveTable({ bus, timers });
	sessions = createExtensionLiveSessions({
		bus,
		logger,
		table,
		subscription: (id) => subs.get(id),
		running: (id) => running.has(id),
		fans: () => fans,
		settings: () => settings,
		timers,
	});
	sessions.onChange((change) => changes.push(change));
}

function report(r: SubscriptionReport, sub: Subscription = SUB): void {
	const extensionId = sub.kind === "extension" ? sub.extensionId : "";
	const externalId = sub.kind === "extension" ? sub.externalId : "";
	bus.emit("subscription-reported", {
		extensionId,
		externalId,
		subscriptionIds: [sub.id],
		report: r,
	});
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
		switch (c.type) {
			case "start":
				return { type: c.type, trigger: c.trigger, startedAt: c.session.startedAt };
			case "end":
				return { type: c.type, reason: c.reason, at: c.at };
			case "status":
				return { type: c.type, live: c.live };
			case "unmatched-end":
				return { type: c.type, at: c.at };
			default:
				return { type: c.type };
		}
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	bus = createNodeMessageBus();
	changes = [];
	settings = { live: true, liveEnd: true, liveEndGrace: false, liveEndGraceMinutes: 2 };
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

		expect(summary()).toEqual([{ type: "start", trigger: "liveStart", startedAt: T0 - MINUTE }]);
		const session = sessions.get(SUB.id);
		expect(session).toMatchObject({
			subscriptionId: SUB.id,
			extensionId: EXT,
			startedAt: T0 - MINUTE,
			detectedAt: T0,
			fansAtStart: 12_345,
			lastRow: { totalViewers: 40 },
		});
	});

	it("BN 开始看之后见到在播:认出一场,开播时刻取状态带的;没带就空着,之后的状态带了再补上", () => {
		start();
		liveStatus();
		expect(summary()).toEqual([{ type: "start", trigger: "liveStatus", startedAt: undefined }]);
		expect(sessions.get(SUB.id)?.detectedAt).toBe(T0);

		liveStatus({ startedAt: T0 - HOUR, totalViewers: 9 });
		expect(summary().at(-1)).toEqual({ type: "status", live: true });
		expect(sessions.get(SUB.id)).toMatchObject({
			startedAt: T0 - HOUR,
			lastRow: { totalViewers: 9 },
		});
	});

	it("不在播的状态不动这一场:BN 不拿状态的翻转猜下播(决策 53)", () => {
		start();
		liveStart();
		report({ kind: "liveStatus", value: { live: false } });
		expect(summary()).toEqual([
			{ type: "start", trigger: "liveStart", startedAt: T0 },
			{ type: "status", live: false },
		]);
		expect(sessions.get(SUB.id)).toBeDefined();
	});

	it("没报下播就又开播了:上一场在新的一场开播时收掉", () => {
		start();
		liveStart();
		vi.advanceTimersByTime(HOUR);
		liveStart({ startedAt: Date.now(), title: "第二场" });
		expect(summary()).toEqual([
			{ type: "start", trigger: "liveStart", startedAt: T0 },
			{ type: "end", reason: "superseded", at: T0 + HOUR },
			{ type: "start", trigger: "liveStart", startedAt: T0 + HOUR },
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

describe("一场到哪结束", () => {
	it("断流接续没开:下播事件一到这一场就结束,结束时刻是事件到达那一刻", () => {
		start();
		liveStart();
		vi.advanceTimersByTime(2 * HOUR);
		liveEnd();
		expect(summary().at(-1)).toEqual({ type: "end", reason: "ended", at: T0 + 2 * HOUR });
		expect(sessions.get(SUB.id)).toBeUndefined();
	});

	it("下播事件来了手里却没有这一场:照实说,不编一场出来", () => {
		start();
		liveEnd({ startedAt: T0 - HOUR });
		expect(summary()).toEqual([{ type: "unmatched-end", at: T0 }]);
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
		expect(summary().at(-1)).toEqual({ type: "ending" });
		await vi.advanceTimersByTimeAsync(3 * MINUTE - 1);
		expect(summary().map((c) => c.type)).toEqual(["start", "ending"]);
		expect(sessions.get(SUB.id)?.pendingEnd?.endedAt).toBe(T0 + HOUR);

		await vi.advanceTimersByTimeAsync(1);
		expect(summary().at(-1)).toEqual({ type: "end", reason: "ended", at: T0 + HOUR });
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

		expect(summary().map((c) => c.type)).toEqual(["start", "ending", "resume"]);
		expect(sessions.get(SUB.id)).toBe(first);
		expect(first?.startedAt).toBe(T0);
		expect(first?.pendingEnd).toBeUndefined();

		// 真下播:结束时刻是这一次下播事件到达的那一刻。
		liveEnd();
		const endedAt = Date.now();
		await vi.advanceTimersByTimeAsync(3 * MINUTE);
		expect(summary().at(-1)).toEqual({ type: "end", reason: "ended", at: endedAt });
	});

	it("等待期间又报下播:忽略,结束时刻仍是第一次那一刻", async () => {
		start();
		liveStart();
		liveEnd();
		await vi.advanceTimersByTimeAsync(MINUTE);
		liveEnd();
		await vi.advanceTimersByTimeAsync(3 * MINUTE);
		expect(summary().slice(1)).toEqual([
			{ type: "ending" },
			{ type: "end", reason: "ended", at: T0 },
		]);
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
		bus.emit("extension-stopped", EXT);
		await vi.advanceTimersByTimeAsync(HOUR);

		const ends = changes.filter((c) => c.type === "end");
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
		bus.emit("subscription-changed", [{ type: "update", sub: disabled }]);
		bus.emit("subscription-changed", [{ type: "remove", sub: OTHER }]);
		expect(changes.filter((c) => c.type === "end")).toEqual([
			expect.objectContaining({ subscriptionId: SUB.id, reason: "disabled" }),
			expect.objectContaining({ subscriptionId: OTHER.id, reason: "removed" }),
		]);
	});

	it("关机:在播的全部结束,原因是关机;之后的上报不再记", () => {
		start();
		liveStart();
		vi.advanceTimersByTime(HOUR);
		sessions.dispose();
		expect(summary().at(-1)).toEqual({ type: "end", reason: "shutdown", at: T0 + HOUR });
		liveStart();
		expect(summary().map((c) => c.type)).toEqual(["start", "end"]);
	});
});
