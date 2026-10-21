/**
 * 场次的拉取式计时(`fetchLiveStatus`,ADR-0021 决策 27 与 10-14 的 🔗;ADR-0026 决策 4)。
 *
 * 来源实现了 `fetchLiveStatus`,核心就按**每一场自己的开播时刻**起算、定时问它一次:
 * - 在播:记进在播表、发 `tick`(周期「正在直播」开着推送那头才推卡);没开周期也核,间隔默认 1 小时;
 * - 已下播:当漏收的下播,走下播同一条路;当场结束记 `poll`,断流宽限等满记 `grace-expired`,时刻是
 *   发现的那一刻;
 * - 取不到:跳过这一轮、记日志,计时器留着,**不停止监听**;
 * - 断流等待到期:再核一次,还在播就接续同一场;
 * - 重启 / 来源登记 / 订阅开始要监听:手里没场次的问一次,在播就认出一场(`trigger: "poll"`)。
 *
 * ⚠️ 假定时器:推进时间一律 `advanceTimersByTimeAsync`,别用 `waitFor`。
 */

import type {
	Identity,
	LiveSessionChange,
	LiveStatusResult,
	Subscription,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createLiveSessionEngine, type LiveSessionEngine } from "../live-sessions.js";
import { createLiveTable, type LiveTable } from "../live-table.js";

const POLL_KEY = "acme.poll";
const SUB = makeExtensionSubscription({
	id: "e0000000-0000-4000-8000-0000000000a1",
	extensionId: POLL_KEY,
	externalId: "ext-1",
});
const SUB_B = makeExtensionSubscription({
	id: "e0000000-0000-4000-8000-0000000000a2",
	extensionId: POLL_KEY,
	externalId: "ext-2",
});
/** 11:59:00 挂上,开播时刻 11:58:30。 */
const NOW = Date.UTC(2026, 9, 20, 11, 59, 0);
const STARTED = Date.UTC(2026, 9, 20, 11, 58, 30);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms: number): string => new Date(ms).toISOString();

const logger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

interface PollSettings {
	liveStreaming: boolean;
	streamingIntervalHours: number;
	liveEndGrace: boolean;
	liveEndGraceMinutes: number;
}

let bus: ReturnType<typeof createNodeMessageBus>;
let table: LiveTable;
let sessions: LiveSessionEngine;
let changes: LiveSessionChange[];
let settings: PollSettings;
let subs: Map<string, Subscription>;
let wanted: Set<string>;
let fetchStatus: ReturnType<
	typeof vi.fn<(identity: Identity, signal: AbortSignal) => Promise<LiveStatusResult>>
>;
/** 这个来源键认不认得 `fetchLiveStatus`。 */
let pollable: boolean;

const timers = {
	setTimeout: (fn: () => void, ms: number) => {
		const h = setTimeout(fn, ms);
		return { dispose: () => clearTimeout(h) };
	},
};

const liveResult = (title = "轮询到的标题", startedAt?: number): LiveStatusResult => ({
	ok: true,
	kind: "live",
	...(startedAt === undefined ? {} : { startedAt: new Date(startedAt).toISOString() }),
	details: { title, totalViewers: 50 },
});

function build(): void {
	table = createLiveTable({ bus });
	sessions = createLiveSessionEngine({
		bus,
		logger,
		table,
		subscription: (id) => subs.get(id),
		sourceStatus: { running: (key) => key === POLL_KEY },
		fans: () => 1000,
		settings: () => settings,
		timers,
		liveStatus: { has: (key) => pollable && key === POLL_KEY, fetch: fetchStatus },
		subscriptions: () => [...subs.values()],
		wantsLive: (sub) => wanted.has(sub.id),
	});
	sessions.onChange((change) => changes.push(change));
}

/** 开播信号:开播时刻 11:58:30。 */
function signalStart(sub: Subscription = SUB, startedAt: number = STARTED): void {
	sessions.apply({
		kind: "start",
		subscriptionId: sub.id,
		identity: sub.identity,
		startedAt: new Date(startedAt).toISOString(),
		details: { title: "开播标题" },
	});
}

const kinds = (): string[] => changes.map((c) => c.kind);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	bus = createNodeMessageBus();
	changes = [];
	settings = {
		liveStreaming: true,
		streamingIntervalHours: 2,
		liveEndGrace: false,
		liveEndGraceMinutes: 2,
	};
	subs = new Map([
		[SUB.id, SUB],
		[SUB_B.id, SUB_B],
	]);
	wanted = new Set([SUB.id, SUB_B.id]);
	pollable = true;
	fetchStatus = vi.fn(async () => liveResult());
	for (const fn of Object.values(logger)) fn.mockClear();
	build();
});

afterEach(() => {
	sessions?.dispose();
	table?.dispose();
	vi.useRealTimers();
});

describe("按每一场的开播时刻起算", () => {
	it("开播时刻 11:58:30、间隔 2 小时:13:58:30 才问,之后每 2 小时一次(不是从挂上的 11:59:00 起算)", async () => {
		signalStart();
		await vi.advanceTimersByTimeAsync(2 * HOUR - 31 * 1000); // 13:58:29
		expect(fetchStatus).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2 * 1000); // 13:58:31
		expect(fetchStatus).toHaveBeenCalledTimes(1);
		expect(fetchStatus).toHaveBeenCalledWith(
			{ sourceKey: POLL_KEY, externalId: "ext-1" },
			expect.any(AbortSignal),
		);
		// 下一次在 15:58:30。
		await vi.advanceTimersByTimeAsync(2 * HOUR - 3 * 1000); // 15:58:28
		expect(fetchStatus).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(4 * 1000); // 15:58:32
		expect(fetchStatus).toHaveBeenCalledTimes(2);
	});

	it("周期「正在直播」关着:间隔用默认 1 小时,照样核", async () => {
		settings.liveStreaming = false;
		signalStart();
		await vi.advanceTimersByTimeAsync(59 * MINUTE);
		expect(fetchStatus).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2 * MINUTE);
		expect(fetchStatus).toHaveBeenCalledTimes(1);
	});

	it("没带开播时刻的场次(状态认出的)从认出的那一刻起算", async () => {
		sessions.apply({
			kind: "status",
			isLive: true,
			subscriptionId: SUB.id,
			identity: SUB.identity,
			details: {},
		});
		await vi.advanceTimersByTimeAsync(2 * HOUR - 1000);
		expect(fetchStatus).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2000);
		expect(fetchStatus).toHaveBeenCalledTimes(1);
	});

	it("来源没实现 fetchLiveStatus:不挂计时器,一次都不问", async () => {
		pollable = false;
		signalStart();
		await vi.advanceTimersByTimeAsync(10 * HOUR);
		expect(fetchStatus).not.toHaveBeenCalled();
	});
});

describe("问到的三种结果", () => {
	it("在播:新的格记进在播表、发 tick,场次还是这一场", async () => {
		signalStart();
		const before = sessions.get(SUB.id);
		expect(before).toBeDefined();
		fetchStatus.mockResolvedValue(liveResult("轮询后的新标题"));
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		expect(kinds()).toEqual(["start", "tick"]);
		expect(table.get(SUB.id)?.details.title).toBe("轮询后的新标题");
		expect(sessions.get(SUB.id)?.detectedAt).toBe(before?.detectedAt);
	});

	it("在播但开播时刻变了:上一场 superseded 收掉,按 poll 认出新的一场", async () => {
		signalStart();
		fetchStatus.mockResolvedValue(liveResult("新的一场", STARTED + HOUR + MINUTE));
		await vi.advanceTimersByTimeAsync(2 * HOUR);

		expect(kinds()).toEqual(["start", "end", "start"]);
		expect(changes[1]).toMatchObject({
			kind: "end",
			reason: "superseded",
			endedAt: iso(STARTED + 2 * HOUR),
		});
		expect(changes[2]).toMatchObject({
			kind: "start",
			trigger: "poll",
			session: { startedAt: iso(STARTED + HOUR + MINUTE) },
		});
		expect(sessions.get(SUB.id)).toMatchObject({
			startedAt: iso(STARTED + HOUR + MINUTE),
			lastDetails: { title: "新的一场" },
		});
	});

	it("已下播:当漏收的下播走下播的路,原因 poll,时刻是发现的那一刻(开播卡之后的时长算到这)", async () => {
		signalStart();
		fetchStatus.mockResolvedValue({ ok: true, kind: "offline" });
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		const end = changes.find((c) => c.kind === "end");
		expect(end).toMatchObject({
			kind: "end",
			reason: "poll",
			endedAt: iso(STARTED + 2 * HOUR),
		});
		expect(sessions.get(SUB.id)).toBeUndefined();
		expect(table.get(SUB.id)).toBeUndefined();
	});

	it("已下播且断流接续开着:先进等待,等满了记 grace-expired,结束时刻仍是发现的那一刻", async () => {
		settings.liveEndGrace = true;
		signalStart();
		fetchStatus.mockResolvedValue({ ok: true, kind: "offline" });
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		expect(kinds()).toEqual(["start", "ending"]);
		// 等待期间不再按周期问;到期那一次核对还是下播,才结束。
		await vi.advanceTimersByTimeAsync(2 * MINUTE);
		const end = changes.find((c) => c.kind === "end");
		expect(end).toMatchObject({ reason: "grace-expired", endedAt: iso(STARTED + 2 * HOUR) });
	});

	it("取不到(ok:false):这一轮跳过、记日志,场次还在,计时器留着,下一轮照样问", async () => {
		signalStart();
		fetchStatus.mockResolvedValue({ ok: false, code: "rate_limited", message: "被风控了" });
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		expect(fetchStatus).toHaveBeenCalledTimes(1);
		expect(sessions.get(SUB.id)).toBeDefined();
		expect(kinds()).toEqual(["start"]);
		expect(logger.warn).toHaveBeenCalled();
		fetchStatus.mockResolvedValue(liveResult());
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		expect(fetchStatus).toHaveBeenCalledTimes(2);
		expect(kinds()).toEqual(["start", "tick"]);
	});
});

describe("断流等待到期再核一次", () => {
	it("还在播:接续成同一场,不结束", async () => {
		settings.liveEndGrace = true;
		signalStart();
		const before = sessions.get(SUB.id);
		expect(before).toBeDefined();
		sessions.apply({
			kind: "end",
			endedAt: new Date(NOW).toISOString(),
			subscriptionId: SUB.id,
			identity: SUB.identity,
		});
		expect(kinds()).toEqual(["start", "ending"]);
		fetchStatus.mockResolvedValue(liveResult("还在播"));
		await vi.advanceTimersByTimeAsync(2 * MINUTE + 10);
		expect(fetchStatus).toHaveBeenCalledTimes(1);
		expect(kinds()).toEqual(["start", "ending", "resume"]);
		expect(sessions.get(SUB.id)?.detectedAt).toBe(before?.detectedAt);
		expect(table.get(SUB.id)?.details.title).toBe("还在播");
	});

	it("核到下播(或没取到):这一场结束,原因记 grace-expired", async () => {
		settings.liveEndGrace = true;
		signalStart();
		sessions.apply({
			kind: "end",
			endedAt: new Date(NOW).toISOString(),
			subscriptionId: SUB.id,
			identity: SUB.identity,
		});
		fetchStatus.mockResolvedValue({ ok: false, code: "unavailable", message: "没取到" });
		await vi.advanceTimersByTimeAsync(2 * MINUTE + 10);
		expect(changes.find((c) => c.kind === "end")).toMatchObject({
			reason: "grace-expired",
			endedAt: iso(NOW),
		});
	});
});

describe("重启 / 来源登记 / 订阅开始监听:手里没场次的问一次", () => {
	it("pollUnseen:在播就认出一场(trigger poll),写进在播表;不在播、没取到、不要监听的、已有场次的都不动", async () => {
		wanted = new Set([SUB.id]);
		fetchStatus.mockResolvedValue(liveResult("重启后认出的", STARTED));
		sessions.pollUnseen(POLL_KEY);
		await vi.advanceTimersByTimeAsync(0);
		// SUB_B 不在要监听的名单里:只问了 SUB 一条。
		expect(fetchStatus.mock.calls.map(([id]) => id.externalId)).toEqual(["ext-1"]);
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ kind: "start", trigger: "poll" });
		expect(sessions.get(SUB.id)?.startedAt).toBe(iso(STARTED));
		expect(table.get(SUB.id)?.details.title).toBe("重启后认出的");
		// 已有场次的不再问。
		fetchStatus.mockClear();
		sessions.pollUnseen(POLL_KEY);
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchStatus).not.toHaveBeenCalled();
	});

	it("问到不在播:不认场次", async () => {
		fetchStatus.mockResolvedValue({ ok: true, kind: "offline" });
		sessions.pollUnseen(POLL_KEY);
		await vi.advanceTimersByTimeAsync(0);
		expect(changes).toEqual([]);
		expect(sessions.get(SUB.id)).toBeUndefined();
	});

	it("订阅新加进来也问一次", async () => {
		const added = makeExtensionSubscription({
			id: "e0000000-0000-4000-8000-0000000000a3",
			extensionId: POLL_KEY,
			externalId: "ext-3",
		});
		// 来源登记时先问过一遍现有的(都不在播),之后新加的这一条才是「刚进入监听」。
		fetchStatus.mockResolvedValue({ ok: true, kind: "offline" });
		sessions.pollUnseen(POLL_KEY);
		await vi.advanceTimersByTimeAsync(0);
		fetchStatus.mockClear();
		subs.set(added.id, added);
		wanted.add(added.id);
		fetchStatus.mockResolvedValue(liveResult());
		bus.emit("subscription-changed", { ops: [{ kind: "add", sub: added }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchStatus.mock.calls.map(([id]) => id.externalId)).toEqual(["ext-3"]);
		expect(sessions.get(added.id)).toBeDefined();
	});
});

describe("只问刚进入监听的订阅", () => {
	const askedExternalIds = () => fetchStatus.mock.calls.map(([id]) => id.externalId);

	beforeEach(async () => {
		// 来源登记完问过一遍(都不在播),之后的变动才分得出「新进来的」。
		fetchStatus.mockResolvedValue({ ok: true, kind: "offline" });
		sessions.pollUnseen(POLL_KEY);
		await vi.advanceTimersByTimeAsync(0);
		expect(askedExternalIds()).toEqual(["ext-1", "ext-2"]);
		fetchStatus.mockClear();
	});

	it("订阅改了别的字段(仍启用着):不问", async () => {
		const edited = { ...SUB, cardSkin: "another-skin" } as Subscription;
		subs.set(SUB.id, edited);
		bus.emit("subscription-changed", { ops: [{ kind: "update", sub: edited }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchStatus).not.toHaveBeenCalled();
	});

	it("停用再启用:启用的那一刻问一次(只问它)", async () => {
		const off = { ...SUB, enabled: false } as Subscription;
		subs.set(SUB.id, off);
		bus.emit("subscription-changed", { ops: [{ kind: "update", sub: off }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchStatus).not.toHaveBeenCalled();
		subs.set(SUB.id, SUB);
		bus.emit("subscription-changed", { ops: [{ kind: "update", sub: SUB }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(askedExternalIds()).toEqual(["ext-1"]);
	});

	it("全局直播开关从关到开:那些订阅各问一次;再存一次不变的全局设置不再问", async () => {
		// 开关关着:两条都不要监听 → 出集合。
		wanted.clear();
		bus.emit("config-changed", { scope: "globals" });
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchStatus).not.toHaveBeenCalled();
		// 开关打开:两条各问一次。
		wanted = new Set([SUB.id, SUB_B.id]);
		bus.emit("config-changed", { scope: "globals" });
		await vi.advanceTimersByTimeAsync(0);
		expect(askedExternalIds()).toEqual(["ext-1", "ext-2"]);
		// 又存一次(没变):不再问。
		fetchStatus.mockClear();
		bus.emit("config-changed", { scope: "globals" });
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchStatus).not.toHaveBeenCalled();
	});
});

describe("来源停用 / 引擎关停:撤销在途的核对", () => {
	/** 摆一个挂起的核对:第一次问时记下 signal,调用方手动放行。 */
	function hangingFetch() {
		let seen: AbortSignal | undefined;
		let release: (result: LiveStatusResult) => void = () => {};
		fetchStatus.mockImplementationOnce((_identity, signal) => {
			seen = signal;
			return new Promise<LiveStatusResult>((resolve) => {
				release = resolve;
			});
		});
		return { signal: () => seen, release: (result: LiveStatusResult) => release(result) };
	}

	it("来源停了:在途的那次收到 abort;回答回来后不改场次、不发 tick", async () => {
		signalStart();
		const hang = hangingFetch();
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		expect(hang.signal()?.aborted).toBe(false);
		bus.emit("extension-stopped", { extensionId: POLL_KEY });
		expect(hang.signal()?.aborted).toBe(true);
		const changesBefore = changes.length;
		hang.release(liveResult("迟到的回答"));
		await vi.advanceTimersByTimeAsync(0);
		// 来源停了,这一场已经收掉;迟到的回答既不写在播表也不发 tick。
		expect(sessions.get(SUB.id)).toBeUndefined();
		expect(table.get(SUB.id)).toBeUndefined();
		expect(changes.slice(changesBefore).map((c) => c.kind)).toEqual([]);
	});

	it("停了之后再问用的是新的 signal(没被上一次的中止带坏)", async () => {
		signalStart();
		const hang = hangingFetch();
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		bus.emit("extension-stopped", { extensionId: POLL_KEY });
		hang.release({ ok: false, code: "aborted", message: "cancelled" });
		await vi.advanceTimersByTimeAsync(0);
		fetchStatus.mockClear();
		signalStart();
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		expect(fetchStatus.mock.calls[0]?.[1].aborted).toBe(false);
	});

	it("引擎关停:在途的那次收到 abort", async () => {
		signalStart();
		const hang = hangingFetch();
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		sessions.dispose();
		expect(hang.signal()?.aborted).toBe(true);
	});
});

describe("核对中途出错不断计时器", () => {
	it("听场次变化的监听者在 tick 时抛了一次:记 error,下一轮照样问", async () => {
		let boom = true;
		sessions.onChange((change) => {
			if (change.kind === "tick" && boom) {
				boom = false;
				throw new Error("listener boom");
			}
		});
		signalStart();
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		expect(fetchStatus).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		expect(fetchStatus).toHaveBeenCalledTimes(2);
	});

	it("断流等待到期接续时监听者抛了一次:记 error,这一场照样重挂核对", async () => {
		settings.liveEndGrace = true;
		let boom = true;
		sessions.onChange((change) => {
			if (change.kind === "resume" && boom) {
				boom = false;
				throw new Error("listener boom");
			}
		});
		signalStart();
		sessions.apply({
			kind: "end",
			endedAt: new Date(NOW).toISOString(),
			subscriptionId: SUB.id,
			identity: SUB.identity,
		});
		await vi.advanceTimersByTimeAsync(2 * MINUTE + 10);
		expect(logger.error).toHaveBeenCalled();
		expect(sessions.get(SUB.id)).toBeDefined();
		fetchStatus.mockClear();
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		expect(fetchStatus).toHaveBeenCalledTimes(1);
	});
});
