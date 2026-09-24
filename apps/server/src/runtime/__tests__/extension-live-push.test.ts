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
	type SubscriptionReport,
} from "@bilibili-notify/internal";
import type { LiveNotifySend } from "@bilibili-notify/live";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import type { SubscriptionReportProblem } from "../../extensions/context.js";
import type { LiveWorkSettings } from "../engines.js";
import { createExtensionLiveTable, type ExtensionLiveTable } from "../extension-live.js";
import { bindExtensionLivePush } from "../extension-live-push.js";
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
		live: true,
		liveEnd: true,
		customCardStyle: { enable: false },
		messageLayout: defaultMessageKindLayout("live"),
		customLiveMsg: { enable: true },
		pushTime: 0,
		restartPush: false,
		liveEndGrace: false,
		liveEndGraceMinutes: 2,
		...over,
	};
}

let bus: ReturnType<typeof createNodeMessageBus>;
let table: ExtensionLiveTable;
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
		table,
		subscription: (id) => subs.get(id),
		profile: () => profile,
		settings: () => settings,
		cardStyle: () => undefined,
		sources: { running: () => running, readAvatar: async () => undefined },
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
		timers,
	});
}

function report(r: SubscriptionReport, ids: readonly string[] = [SUB.id]): void {
	bus.emit("subscription-reported", {
		extensionId: EXT,
		externalId: SUB.externalId,
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
	settings = baseSettings();
	subs = new Map([[SUB.id, SUB]]);
	running = true;
	profile = { name: "抖音甲", fans: 12_345 };
});

afterEach(() => {
	handle?.dispose();
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
		bus.emit("extension-stopped", EXT);
		running = true;
		await vi.advanceTimersByTimeAsync(10 * MINUTE);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
	});
});

describe("周期「正在直播」", () => {
	beforeEach(() => {
		settings = baseSettings({ pushTime: 1 });
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
			externalId: SUB.externalId,
			subscriptionIds: [SUB.id],
			outcome: "skipped",
		});
		expect(problems[0]?.reasons[0]).toMatch(/没收到新的直播状态/);
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
		bus.emit("subscription-changed", [{ type: "update", sub: disabled }]);
		// 马上又启用回来:停用那一刻这一场就作废了,启用不会把它的计时器救回来。
		subs.set(SUB.id, SUB);
		bus.emit("subscription-changed", [{ type: "update", sub: SUB }]);
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
		bus.emit("subscription-changed", [{ type: "remove", sub: SUB }]);
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(problems).toEqual([]);
	});

	it("拓展停了 → 周期推送作废,不再记跳过", async () => {
		start();
		liveStart();
		await settle();
		bus.emit("extension-stopped", EXT);
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(problems).toEqual([]);
	});
});

describe("重启补推", () => {
	it("BN 起来后第一次收到在播、没见过这一场的开播:补推一张「正在直播」,之后的状态不再补", async () => {
		settings = baseSettings({ restartPush: true });
		start();
		liveStatus({ startedAt: T0 - 30 * MINUTE, totalViewers: 5 });
		await settle();
		liveStatus({ totalViewers: 6 });
		await settle();

		expect(sent.map((s) => s.type)).toEqual([0]);
		expect(sent[0]?.text).toBe(`抖音甲 正在直播，已播 30分，累计观看：5\n${URL}`);
		expect(sent[0]?.input).toMatchObject({ status: "streaming", startedAt: T0 - 30 * MINUTE });
	});

	it("并挂上周期推送", async () => {
		settings = baseSettings({ restartPush: true, pushTime: 1 });
		start();
		liveStatus();
		await settle();
		liveStatus();
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([0, 0]);
	});

	it("重启补推关着:不补推,周期推送照挂", async () => {
		settings = baseSettings({ pushTime: 1 });
		start();
		liveStatus();
		await settle();
		expect(sent).toEqual([]);
		liveStatus();
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([0]);
	});

	it("见过开播事件的这一场:状态不触发补推", async () => {
		settings = baseSettings({ restartPush: true });
		start();
		liveStart();
		liveStatus();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
	});

	it("拓展停过又跑起来:靠直播状态接上,不再补推", async () => {
		settings = baseSettings({ restartPush: true });
		start();
		liveStatus();
		await settle();
		bus.emit("extension-stopped", EXT);
		liveStatus();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([0]);
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
