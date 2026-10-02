/**
 * 拓展订阅的直播推送与计时器(`bindExtensionLivePush`,ADR-0019 决策 53 / 56–58 / 61 / 67)。
 *
 * 喂一条真的总线、一张真的在播表(最新状态从它取),出卡与发送换成记账的替身,时钟走假定时器:
 * - 开播 / 下播卡只由事件触发(决策 53);
 * - 断流接续:下播先压着,等待期间再开播就两张都不发、沿用第一次的开播时刻(决策 58);
 * - 周期「正在直播」只在上次推送之后收到过新状态时推,否则跳过、记进上报问题框(决策 61);
 * - 重启补推只在 BN 起来后第一次见到这一场在播、且没见过它的开播事件时推一次(决策 57);
 * - 拓展停了 / 订阅停用或删了:计时器与等着的下播全部作废,不补推(决策 61);
 * - 粉丝那一格:开播记下资料里的粉丝数,下播拿最新那份相减(决策 56)。
 *
 * ⚠️ 这个文件用假定时器:别用 `waitFor` / `findBy*`(会死锁),推进时间一律 `advanceTimersByTimeAsync`。
 */

import type { ImageRenderer, LiveCardInput } from "@bilibili-notify/image";
import {
	defaultMessageKindLayout,
	type Subscription,
	type SubscriptionEventKind,
	type SubscriptionReport,
} from "@bilibili-notify/internal";
import { type LiveNotifySend, LivePushType } from "@bilibili-notify/live";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import {
	deferred,
	makeTrackingContext,
	type TrackingContext,
} from "../../__tests__/support/track-context.js";
import type { SubscriptionReportProblem } from "../../extensions/context.js";
import type { LiveWorkSettings } from "../engines.js";
import { createExtensionLiveTable, type ExtensionLiveTable } from "../extension-live.js";
import { bindExtensionLivePush } from "../extension-live-push.js";
import {
	createExtensionLiveSessions,
	type ExtensionLiveSessions,
} from "../extension-live-sessions.js";
import { createNodeMessageBus } from "../message-bus.js";

const EXT = "douyin";
const SUB = makeExtensionSubscription({ extensionId: EXT, externalId: "sec-uid-1" });
const T0 = Date.UTC(2026, 8, 24, 4, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const URL = "https://live.douyin.com/123";
const logger = { debug() {}, info() {}, warn() {}, error() {} };

/** 发出去的一张卡:哪条订阅、哪种推送、文字部件、卡上画的输入。 */
interface Sent {
	id: string;
	type: number;
	text: string;
	input: LiveCardInput | undefined;
}

function baseSettings(over: Partial<LiveWorkSettings> = {}): LiveWorkSettings {
	return {
		liveStart: true,
		liveStreaming: false,
		liveEnd: true,
		customCardStyle: { enable: false },
		messageLayout: defaultMessageKindLayout("live"),
		customLiveMsg: { enable: true },
		streamingIntervalHours: 1,
		catchUpOnBoot: false,
		liveEndGrace: false,
		liveEndGraceMinutes: 2,
		...over,
	};
}

let bus: ReturnType<typeof createNodeMessageBus>;
let table: ExtensionLiveTable;
let sessions: ExtensionLiveSessions;
let handle: { dispose(): void };
let sent: Sent[];
let problems: SubscriptionReportProblem[];
let settings: LiveWorkSettings;
let subs: Map<string, Subscription>;
let running: boolean;
/** 订阅资料(名字 / 粉丝数),现取。 */
let profile: { name?: string; fans?: number } | undefined;
/** 出卡:每张卡的输入按出卡顺序记下;`slowNext` 让下一张卡卡住,由测试放行。 */
let renderedInputs: LiveCardInput[];
let slowNext: Promise<void> | undefined;
/** 登记进 `track` 的后台活(切片 ③)。 */
let ctx: TrackingContext;
/** 拓展清单声明的事件(`contributes.subscription.events`);`undefined` = 现取不到(装载器还没起来)。 */
let declaredEvents: readonly SubscriptionEventKind[] | undefined;
/** 推送这头(`bindExtensionLivePush`)挂过的周期计时器的间隔,按挂的先后(场次 / 在播表自己的计时器不算)。 */
let periodicIntervals: number[];

function start(): void {
	const timers = {
		setTimeout: (fn: () => void, ms: number) => {
			const h = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(h) };
		},
		setInterval: (fn: () => void, ms: number) => {
			const h = setInterval(fn, ms);
			return { dispose: () => clearInterval(h) };
		},
	};
	table = createExtensionLiveTable({ bus, timers });
	sessions = createExtensionLiveSessions({
		bus,
		logger,
		table,
		subscription: (id) => subs.get(id),
		running: () => running,
		fans: () => profile?.fans,
		settings: () => settings,
		timers,
	});
	const renderer = {
		generateNeutralLiveCard: vi.fn(async (input: LiveCardInput) => {
			renderedInputs.push(input);
			const wait = slowNext;
			slowNext = undefined;
			if (wait) await wait;
			return Buffer.from("card");
		}),
	} as unknown as ImageRenderer;
	handle = bindExtensionLivePush({
		bus,
		logger,
		sessions,
		table,
		subscription: (id) => subs.get(id),
		profile: () => profile,
		settings: () => settings,
		cardStyle: () => undefined,
		sources: {
			running: () => running,
			readAvatar: async () => undefined,
			events: () => declaredEvents,
		},
		sendFor:
			(id): LiveNotifySend =>
			async (groups, type) => {
				const text = groups
					.flat()
					.flatMap((seg) => (seg.type === "text" ? [seg.text] : []))
					.join("\n");
				sent.push({ id, type, text, input: renderedInputs.at(-1) });
			},
		renderer: () => renderer,
		reportProblem: (problem) => problems.push(problem),
		serviceCtx: {
			setInterval: (fn, ms) => {
				periodicIntervals.push(ms);
				return timers.setInterval(fn, ms);
			},
			track: ctx.track,
		},
	});
}

function report(r: SubscriptionReport, ids: readonly string[] = [SUB.id]): void {
	bus.emit("subscription-reported", {
		extensionId: EXT,
		externalId: SUB.identity.externalId,
		subscriptionIds: [...ids],
		report: r,
	});
}

const liveStart = (
	over: Partial<Extract<SubscriptionReport, { kind: "liveStart" }>["value"]> = {},
) =>
	report({
		kind: "liveStart",
		value: { url: URL, startedAt: Date.now(), title: "第一场", viewers: 10, ...over },
	});
const liveEnd = (over: Partial<Extract<SubscriptionReport, { kind: "liveEnd" }>["value"]> = {}) =>
	report({ kind: "liveEnd", value: { url: URL, ...over } });
const liveStatus = (
	over: Partial<Extract<SubscriptionReport, { kind: "liveStatus" }>["value"]> = {},
) => report({ kind: "liveStatus", value: { live: true, url: URL, ...over } });

/** 让排在闸里的出卡、发送都跑完(不推进时钟)。 */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	bus = createNodeMessageBus();
	sent = [];
	problems = [];
	renderedInputs = [];
	slowNext = undefined;
	ctx = makeTrackingContext();
	periodicIntervals = [];
	declaredEvents = ["post", "liveStart", "liveEnd"];
	settings = baseSettings();
	subs = new Map([[SUB.id, SUB]]);
	running = true;
	profile = { name: "抖音甲", fans: 12_345 };
});

afterEach(() => {
	handle?.dispose();
	sessions?.dispose();
	table?.dispose();
	vi.useRealTimers();
});

describe("开播", () => {
	it("开播事件 → 推一张开播卡:文案套名字与开播时的粉丝数,卡上是事件里的格,链接是事件的 url", async () => {
		start();
		liveStart({ cover: PNG, category: "聊天", description: "简介", likes: 3, totalViewers: 40 });
		await settle();

		expect(sent).toHaveLength(1);
		const [card] = sent;
		expect(card?.type).toBe(3);
		expect(card?.text).toBe(`抖音甲 开播啦，当前粉丝数：1.2万\n${URL}`);
		expect(card?.input).toMatchObject({
			status: "start",
			author: { name: "抖音甲" },
			title: "第一场",
			area: "聊天",
			description: "简介",
			startedAt: T0,
			online: 10,
			likes: 3,
			totalViewers: 40,
			fans: 12_345,
		});
		expect(card?.input?.cover).toMatch(/^data:image\/png;base64,/);
	});
});

describe("下播", () => {
	it("断流接续没开:下播事件一到就推下播卡 —— 时长从开播算到下播,点赞 / 累计观看 / 粉丝数变化进输入", async () => {
		start();
		liveStart({ likes: 5, totalViewers: 100 });
		await settle();
		await vi.advanceTimersByTimeAsync(2 * HOUR + 13 * MINUTE);
		// 这场涨了 128 个粉丝(拓展报过资料更新);下播事件只带链接与点赞。
		profile = { name: "抖音甲", fans: 12_345 + 128 };
		liveEnd({ likes: 900 });
		await settle();

		expect(sent.map((s) => s.type)).toEqual([3, 9]);
		const end = sent[1];
		expect(end?.text).toBe(`抖音甲 下播啦，本次直播了 2小时13分，粉丝变化 +128\n${URL}`);
		expect(end?.input).toMatchObject({
			status: "end",
			startedAt: T0,
			// 事件带了的用事件的,没带的用这一场最后一份状态补。
			likes: 900,
			totalViewers: 100,
			title: "第一场",
			fansChanged: 128,
		});
	});

	it("开播时没有资料粉丝数:下播文案的粉丝变化空着,输入里也不给", async () => {
		profile = { name: "抖音甲" };
		start();
		liveStart();
		await settle();
		profile = { name: "抖音甲", fans: 50 };
		liveEnd();
		await settle();

		expect(sent[1]?.text).toBe(`抖音甲 下播啦，本次直播了 0秒，粉丝变化 \n${URL}`);
		expect(sent[1]?.input?.fansChanged).toBeUndefined();
	});

	it("BN 手里没有这一场(中途重启过、拓展没报过状态):照推下播卡,时长用事件带的开播时刻", async () => {
		start();
		liveEnd({ startedAt: T0 - HOUR });
		await settle();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.type).toBe(9);
		expect(sent[0]?.text).toContain("本次直播了 1小时");
		expect(sent[0]?.input?.startedAt).toBe(T0 - HOUR);
	});

	it("下播推送关着:下播卡不推", async () => {
		settings = baseSettings({ liveEnd: false });
		start();
		liveStart();
		liveEnd();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
	});
});

describe("断流接续", () => {
	beforeEach(() => {
		settings = baseSettings({ liveEndGrace: true, liveEndGraceMinutes: 3 });
	});

	it("下播先压着,等满才推下播卡;时长定格在下播事件到达那一刻", async () => {
		start();
		liveStart();
		await settle();
		await vi.advanceTimersByTimeAsync(HOUR);
		liveEnd();
		await vi.advanceTimersByTimeAsync(3 * MINUTE - 1);
		expect(sent.map((s) => s.type)).toEqual([3]);

		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, 9]);
		expect(sent[1]?.text).toContain("本次直播了 1小时，");
	});

	it("等待期间又开播:两张卡都不发,沿用第一次的开播时刻", async () => {
		start();
		liveStart();
		await settle();
		await vi.advanceTimersByTimeAsync(HOUR);
		liveEnd();
		await vi.advanceTimersByTimeAsync(MINUTE);
		// 拓展说这是新开的一场(开播时刻是此刻),BN 按断流接续当同一场。
		const reopenedAt = Date.now();
		liveStart({ startedAt: reopenedAt });
		await vi.advanceTimersByTimeAsync(10 * MINUTE);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);

		// 真下播时,时长从第一次开播算 —— 下播事件带的是拓展眼里第二段的开播时刻,BN 自己记着的优先。
		await vi.advanceTimersByTimeAsync(HOUR);
		settings = baseSettings({ liveEndGrace: false });
		liveEnd({ startedAt: reopenedAt });
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, 9]);
		expect(sent[1]?.text).toContain("本次直播了 2小时11分，");
		expect(sent[1]?.input?.startedAt).toBe(T0);
	});

	it("拓展停了:等着的下播卡作废,不补推", async () => {
		start();
		liveStart();
		await settle();
		liveEnd();
		running = false;
		bus.emit("extension-stopped", { extensionId: EXT });
		running = true;
		await vi.advanceTimersByTimeAsync(10 * MINUTE);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
	});
});

describe("周期「正在直播」", () => {
	beforeEach(() => {
		settings = baseSettings({ liveStreaming: true, streamingIntervalHours: 1 });
	});

	it("到点时上次推送之后收到过新状态 → 拿在播表里最新那一份推;没有 → 这一轮跳过,记进上报问题框", async () => {
		start();
		liveStart({ totalViewers: 10 });
		await settle();

		// 第一小时:拓展报了新状态。
		await vi.advanceTimersByTimeAsync(30 * MINUTE);
		liveStatus({
			viewers: 77,
			totalViewers: 23_456,
			title: "改了标题",
			description: "新简介",
			author: { name: "事件里的名字" },
		});
		await vi.advanceTimersByTimeAsync(30 * MINUTE);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, 0]);
		// 作者照决策 54:状态里带的名字优先于资料里的。
		expect(sent[1]?.text).toBe(`事件里的名字 正在直播，已播 1小时，累计观看：2.3万\n${URL}`);
		expect(sent[1]?.input).toMatchObject({
			status: "streaming",
			author: { name: "事件里的名字" },
			description: "新简介",
			title: "改了标题",
			online: 77,
			totalViewers: 23_456,
			startedAt: T0,
			fans: 12_345,
		});
		expect(problems).toEqual([]);

		// 第二小时:拓展一声没吭。
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, 0]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatchObject({
			extensionId: EXT,
			kind: "liveStatus",
			externalId: SUB.identity.externalId,
			subscriptionIds: [SUB.id],
			outcome: "skipped",
		});
		expect(problems[0]?.reasons[0]).toMatch(/没收到新的直播状态/);
	});

	// 拓展没报下播(清单可以只声明开播)、或下播事件被拒收了:在播表那一行已经被「不在播」的状态请出去,
	// 这一场的计时器却还挂着。拓展明明一直在报,不该每一轮都记一句「没收到新的直播状态」;BN 也不拿状态
	// 替它判下播(决策 53)—— 悄悄跳过,又报在播了就接着推。
	it("最新状态说不在播:到点悄悄跳过,不推、不记跳过;之后又报在播,周期推送接着来", async () => {
		start();
		liveStart();
		await settle();
		liveStatus({ totalViewers: 7 });
		report({ kind: "liveStatus", value: { live: false } });
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(problems).toEqual([]);

		liveStatus({ totalViewers: 8 });
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, 0]);
		expect(sent[1]?.input).toMatchObject({ status: "streaming", totalViewers: 8 });
		expect(problems).toEqual([]);
	});

	// ⑬d 直播拆键:周期「正在直播」走自己的开关、间隔与目标;关着就不挂计时器(推送类型 Live=0 = 周期那一档)。
	it("liveStreaming 关:不挂计时器 —— 不推,也不记「没收到新状态」(关着的东西不该报问题)", async () => {
		settings = baseSettings({ liveStreaming: false });
		start();
		liveStart();
		await settle();
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(problems).toEqual([]);
		// 计时器压根没挂(不是挂着、到点再跳过):关着的东西不留一个空转的定时器。
		expect(periodicIntervals).toEqual([]);
	});

	it("按 streamingIntervalHours 计时:间隔 2 小时 → 一小时没动静,两小时到点才推", async () => {
		settings = baseSettings({ liveStreaming: true, streamingIntervalHours: 2 });
		start();
		liveStart();
		await settle();
		liveStatus({ totalViewers: 1 });
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, LivePushType.Live]);
		expect(periodicIntervals).toEqual([2 * HOUR]);
	});

	it("周期只看自己的开关:开播推送(liveStart)关着、周期开着,照样按间隔推「正在直播」", async () => {
		settings = baseSettings({ liveStart: false, liveStreaming: true });
		start();
		liveStart();
		await settle();
		liveStatus({ totalViewers: 3 });
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([LivePushType.Live]);
	});

	it("热更:开着时把开关关掉(全局设置变了)→ 计时器拆掉,不再推", async () => {
		start();
		liveStart();
		await settle();
		settings = baseSettings({ liveStreaming: false });
		bus.emit("config-changed", { scope: "globals" });
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(problems).toEqual([]);
	});

	it("热更:关着时把开关打开 → 这一场从此刻起按间隔挂上计时器", async () => {
		settings = baseSettings({ liveStreaming: false });
		start();
		liveStart();
		await settle();
		settings = baseSettings({ liveStreaming: true, streamingIntervalHours: 1 });
		bus.emit("config-changed", { scope: "globals" });
		liveStatus({ totalViewers: 4 });
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, LivePushType.Live]);
	});

	it("热更:间隔改了 → 旧的拆掉、按新间隔重挂", async () => {
		start();
		liveStart();
		await settle();
		settings = baseSettings({ liveStreaming: true, streamingIntervalHours: 3 });
		bus.emit("config-changed", { scope: "globals" });
		liveStatus({ totalViewers: 5 });
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]); // 旧的一小时间隔已作废
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, LivePushType.Live]);
	});

	// 周期「正在直播」只对同时声明了开播与下播的源成立(`featuresForEvents`,面板那一行「直播中」也是这条规则):
	// 只报开播的源没有下播事件把这一场收掉。全局默认开着(迁移把旧的周期间隔折成了全局开)时,这样的源名下的订阅也不挂。
	it("源只声明了开播(没有下播):开关开着也不挂计时器、不推", async () => {
		declaredEvents = ["post", "liveStart"];
		start();
		liveStart();
		await settle();
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(periodicIntervals).toEqual([]);
		expect(problems).toEqual([]);
	});

	it("源声明了开播与下播 → 挂;清单现取不到(undefined)时不拦:只在明确知道声明不全时才不推", async () => {
		declaredEvents = undefined;
		start();
		liveStart();
		await settle();
		expect(periodicIntervals).toEqual([HOUR]);
	});

	it("下播之后不再推,也不记跳过", async () => {
		start();
		liveStart();
		liveEnd();
		await settle();
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, 9]);
		expect(problems).toEqual([]);
	});

	it("订阅停用 → 这一场作废,周期推送停了", async () => {
		start();
		liveStart();
		await settle();
		const disabled = { ...SUB, enabled: false };
		subs.set(SUB.id, disabled);
		bus.emit("subscription-changed", { ops: [{ type: "update", sub: disabled }] });
		// 马上又启用回来:停用那一刻这一场就作废了,启用不会把它的计时器救回来。
		subs.set(SUB.id, SUB);
		bus.emit("subscription-changed", { ops: [{ type: "update", sub: SUB }] });
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(problems).toEqual([]);
	});

	it("订阅删了 → 这一场作废", async () => {
		start();
		liveStart();
		await settle();
		subs.delete(SUB.id);
		bus.emit("subscription-changed", { ops: [{ type: "remove", sub: SUB }] });
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(problems).toEqual([]);
	});

	it("拓展停了 → 周期推送作废,不再记跳过", async () => {
		start();
		liveStart();
		await settle();
		bus.emit("extension-stopped", { extensionId: EXT });
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(problems).toEqual([]);
	});
});

describe("重启补报", () => {
	it("BN 起来后第一次收到在播、没见过这一场的开播:补报一张「正在直播」(推送类型 CatchUp,走开播的路由),之后的状态不再补", async () => {
		settings = baseSettings({ catchUpOnBoot: true });
		start();
		liveStatus({ startedAt: T0 - 30 * MINUTE, totalViewers: 5 });
		await settle();
		liveStatus({ totalViewers: 6 });
		await settle();

		expect(sent.map((s) => s.type)).toEqual([LivePushType.CatchUp]);
		expect(sent[0]?.text).toBe(`抖音甲 正在直播，已播 30分，累计观看：5\n${URL}`);
		expect(sent[0]?.input).toMatchObject({ status: "streaming", startedAt: T0 - 30 * MINUTE });
	});

	it("并挂上周期推送:补报一张,到点再来周期那一档(两档的推送类型不同)", async () => {
		settings = baseSettings({ catchUpOnBoot: true, liveStreaming: true });
		start();
		liveStatus();
		await settle();
		liveStatus();
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([LivePushType.CatchUp, LivePushType.Live]);
	});

	it("补报关着:不补报,周期推送照挂", async () => {
		settings = baseSettings({ liveStreaming: true });
		start();
		liveStatus();
		await settle();
		expect(sent).toEqual([]);
		liveStatus();
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([LivePushType.Live]);
	});

	it("补报开着、开播推送(liveStart)关着:不补报 —— 补的是开播,开播关着就没有什么可补", async () => {
		settings = baseSettings({ catchUpOnBoot: true, liveStart: false });
		start();
		liveStatus();
		await settle();
		expect(sent).toEqual([]);
	});

	it("补报那张卡的文字与卡是「正在直播」那一套,不是开播那句", async () => {
		settings = baseSettings({ catchUpOnBoot: true });
		start();
		liveStatus({ startedAt: T0 - HOUR, totalViewers: 9 });
		await settle();
		expect(sent[0]?.text).toBe(`抖音甲 正在直播，已播 1小时，累计观看：9\n${URL}`);
		expect(sent[0]?.input?.status).toBe("streaming");
	});

	it("见过开播事件的这一场:状态不触发补推", async () => {
		settings = baseSettings({ catchUpOnBoot: true });
		start();
		liveStart();
		liveStatus();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
	});

	// 契约不规定状态与事件谁先报(决策 57 的 09-24 🔗):报「不在播」也算见过,「正在直播」卡发之前再认一次
	// 这一场还是不是当前那场 —— 否则一场刚开的直播会先补推一张「正在直播」、紧跟着又推开播卡。
	it("先报不在播、再报在播、再来开播事件:只推一张开播卡", async () => {
		settings = baseSettings({ catchUpOnBoot: true });
		start();
		report({ kind: "liveStatus", value: { live: false } });
		await settle();
		// 在播与开播事件分在两轮到:等开播事件到的时候,要补推的那张早发出去了,只能靠「不在播也算见过」拦。
		liveStatus();
		await settle();
		liveStart();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
	});

	it("BN 起来后第一份状态就是在播、同一轮紧跟着开播事件:只推一张开播卡", async () => {
		settings = baseSettings({ catchUpOnBoot: true });
		start();
		liveStatus();
		liveStart();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(sent[0]?.input?.status).toBe("start");
		// 排队时就认出换了一场:那张「正在直播」连卡都不出。
		expect(renderedInputs.map((i) => i.status)).toEqual(["start"]);
	});

	it("补推的「正在直播」还在出卡时开播事件到了:这张不发,只推开播卡", async () => {
		settings = baseSettings({ catchUpOnBoot: true });
		start();
		let release: () => void = () => {};
		slowNext = new Promise<void>((resolve) => {
			release = resolve;
		});
		liveStatus();
		await settle();
		expect(renderedInputs.map((i) => i.status)).toEqual(["streaming"]);
		liveStart();
		release();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
	});

	it("拓展停过又跑起来:「见过」一并作废,它重新跑起来的第一份状态就是在播 → 照开机那样补推", async () => {
		settings = baseSettings({ catchUpOnBoot: true });
		start();
		liveStatus();
		await settle();
		bus.emit("extension-stopped", { extensionId: EXT });
		// 停着的时候开的播(或者一直在播):重新跑起来报的第一份就是在播。
		liveStatus();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([LivePushType.CatchUp, LivePushType.CatchUp]);
	});

	it("拓展停过又跑起来、先报了不在播:之后的在播照常接上,不补推", async () => {
		settings = baseSettings({ catchUpOnBoot: true });
		start();
		liveStatus();
		await settle();
		bus.emit("extension-stopped", { extensionId: EXT });
		report({ kind: "liveStatus", value: { live: false } });
		liveStatus();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([LivePushType.CatchUp]);
	});

	it("别的拓展停了:这条订阅的「见过」不动,不补推", async () => {
		settings = baseSettings({ catchUpOnBoot: true });
		start();
		liveStatus();
		await settle();
		// 下播把这一场收掉,之后再报在播时手里没有这一场,补不补推只看「见过」。
		liveEnd();
		await settle();
		bus.emit("extension-stopped", { extensionId: "kuaishou" });
		liveStatus();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([LivePushType.CatchUp, 9]);
	});
});

describe("收下不推", () => {
	it("停用的订阅 / 拓展没在跑:开播、下播都不推", async () => {
		start();
		subs.set(SUB.id, { ...SUB, enabled: false });
		liveStart();
		liveEnd();
		subs.set(SUB.id, SUB);
		running = false;
		liveStart();
		liveEnd();
		await settle();
		expect(sent).toEqual([]);
	});

	it("BN 不拿状态的翻转猜开播 / 下播:只有直播状态进出,一张开播卡、下播卡都没有", async () => {
		start();
		liveStatus();
		report({ kind: "liveStatus", value: { live: false } });
		liveStatus();
		await settle();
		expect(sent).toEqual([]);
	});
});

// ADR-0020 决策 4 / 6:场次与推送开关无关 —— 推送关掉只是不推,这一场还是这一场。
describe("推送中途关掉又打开", () => {
	it("还是同一场:关着的时候不推,下播卡的粉丝变化从开播那一刻算、不从重新打开时算", async () => {
		settings = baseSettings({ liveStreaming: true });
		start();
		liveStart();
		await settle();
		settings = baseSettings({ liveStreaming: false, liveStart: false, liveEnd: false });
		bus.emit("config-changed", { scope: "globals" });
		profile = { name: "抖音甲", fans: 12_345 + 55 };
		liveStatus();
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);

		settings = baseSettings();
		bus.emit("config-changed", { scope: "globals" });
		liveStatus();
		await vi.advanceTimersByTimeAsync(HOUR);
		profile = { name: "抖音甲", fans: 12_345 + 100 };
		liveEnd();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, 9]);
		expect(sent[1]?.text).toBe(`抖音甲 下播啦，本次直播了 2小时，粉丝变化 +100\n${URL}`);
	});
});

describe("同一条订阅的推送按顺序", () => {
	it("开播卡出卡慢、下播紧跟着到:送出去仍是先开播后下播", async () => {
		start();
		let release: () => void = () => {};
		slowNext = new Promise<void>((resolve) => {
			release = resolve;
		});
		liveStart();
		liveEnd();
		await settle();
		expect(sent).toEqual([]);
		release();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, 9]);
	});
});

/**
 * 关停(切片 ③)。每张卡的出卡与推送是发出去不等的后台活;登记进 `ctx.track()` 之后关停等它推完 ——
 * 推送落历史的那一笔得赶在各写道关门之前交进去。(这个文件用假定时器,所以不用 `stillPending`。)
 */
describe("登记进 track", () => {
	it("开播卡:出卡 → 发送,发完它才落定", async () => {
		const sending = deferred();
		start();
		// 发送换成停在半路的:sendFor 是 start() 里写死的记账函数,这里借 slowNext 卡在出卡这一步。
		slowNext = sending.promise;
		let settledAlready = false;
		liveStart();
		void Promise.all(ctx.tracked).then(() => {
			settledAlready = true;
		});
		await settle();

		expect(ctx.tracked).toHaveLength(1);
		expect(settledAlready).toBe(false); // 出卡还卡着,登记的这件事不许落
		expect(sent).toEqual([]);

		sending.resolve(undefined);
		await settle();
		await ctx.settled();
		expect(sent).toHaveLength(1);
	});
});
