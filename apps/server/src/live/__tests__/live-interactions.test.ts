/**
 * 来源报上来的观众互动(`createLiveInteractions`,ADR-0021 决策 56 / 3b-22 提交 5、6):特别弹幕、特别进场、
 * 醒目留言,以及下播回顾要的弹幕收集。
 *
 * 判据来自 3b-16:名单按 `viewer.id` 整串认(不看名字),并且要带这一把特性键;**特性开关与名单两样都要**。
 * 喂一条真的总线、一张真的在播表、一个真的场次引擎,发送是测试里绑的一个记录函数。
 *
 * 验红:
 * - 名单改成按名字认 → 「按 viewer.id」那两条红;
 * - 不看特性开关 → 「开关与名单都要」那两条红;
 * - 回顾收集不看 `wantsLiveEndExtras` 那条件(下播关着也记)→ 「条件不满足不记」红;
 * - 场次结束不清 → 「场次结束清掉」红。
 * - 醒目留言不过门槛就取头像 / 出卡 → 「低于门槛」红;不看来源给的兜底句 → 兜底那条红。
 */

import {
	fail,
	type ImageRef,
	type LiveInteractionReport,
	type MessageLayoutSegment,
	ok,
	type Result,
	type Subscription,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { LOOKUP_TIMEOUT_MS } from "../../integrations/lookup-timeout.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createSourceGates } from "../../subscriptions/call-source.js";
import {
	createLiveInteractions,
	type LiveInteractions,
	type LiveInteractionsOptions,
} from "../live-interactions.js";
import { createLiveSessionEngine, type LiveSessionEngine } from "../live-sessions.js";
import type { LiveSettings } from "../live-settings.js";
import { createLiveTable, type LiveTable } from "../live-table.js";
import { LivePushType } from "../live-types.js";
import { ViewerChatCollector } from "../recap/viewer-chat-collector.js";

const EXT = "acme.inprocess";
const SUB = makeExtensionSubscription({ extensionId: EXT, externalId: "room-1" });
const T0 = Date.UTC(2026, 9, 20, 4, 0, 0);
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const timers = {
	setTimeout: (fn: () => void, ms: number) => {
		const h = setTimeout(fn, ms);
		return { dispose: () => clearTimeout(h) };
	},
};

type InteractionSettings = Pick<
	LiveSettings,
	| "liveStart"
	| "liveEnd"
	| "liveEndGrace"
	| "liveEndGraceMinutes"
	| "liveStreaming"
	| "streamingIntervalHours"
	| "superchat"
	| "minSuperchatAmount"
	| "extras"
	| "viewerChat"
	| "viewerEnter"
	| "cardSkin"
	| "cardSkinKnobs"
	| "customSpecialDanmakuUsers"
	| "customSpecialUsersEnterTheRoom"
>;

const CHAT_TEMPLATE = "{name} 的直播间里 {viewer} 说:{msg}";
const ENTER_TEMPLATE = "{viewer} 进入了 {name} 的直播间";
const VIEWER_AVATAR = `${"a".repeat(64)}.webp` as ImageRef;
const SC_CARD = Buffer.from("sc-card-jpeg");
type SuperchatRenderer = NonNullable<ReturnType<LiveInteractionsOptions["renderer"]>>;

let bus: ReturnType<typeof createNodeMessageBus>;
let table: LiveTable;
let sessions: LiveSessionEngine;
let interactions: LiveInteractions;
let collector: ViewerChatCollector;
let settings: InteractionSettings;
let subs: Map<string, Subscription>;
let running: Set<string>;
let sent: Array<{ id: string; text: string; type: number }>;
let sentSegments: Array<{ id: string; type: number; segments: MessageLayoutSegment[] }>;
let avatarAsked: number;
let avatarImpl: (() => Promise<Result<{ ref: ImageRef }>>) | undefined;
let superchatCard: ReturnType<typeof vi.fn>;
let renderer: SuperchatRenderer | null;

function settingsWith(
	specialViewers: InteractionSettings["customSpecialDanmakuUsers"]["specialViewers"],
	over: Partial<InteractionSettings> = {},
): InteractionSettings {
	return {
		liveStart: true,
		liveEnd: true,
		liveEndGrace: false,
		liveEndGraceMinutes: 2,
		liveStreaming: false,
		streamingIntervalHours: 1,
		superchat: true,
		extras: { atAllPost: false, atAllLiveStart: false, wordcloud: false, liveSummary: false },
		viewerChat: true,
		viewerEnter: true,
		customSpecialDanmakuUsers: { specialViewers, template: CHAT_TEMPLATE },
		customSpecialUsersEnterTheRoom: { specialViewers, template: ENTER_TEMPLATE },
		...over,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	bus = createNodeMessageBus();
	table = createLiveTable({ bus, timers });
	subs = new Map([[SUB.id, SUB]]);
	running = new Set([EXT]);
	sent = [];
	sentSegments = [];
	avatarAsked = 0;
	avatarImpl = undefined;
	vi.clearAllMocks();
	superchatCard = vi.fn(async () => SC_CARD);
	renderer = { generateSuperchatCard: superchatCard } as unknown as SuperchatRenderer;
	settings = settingsWith([{ id: "123", features: ["viewerChat", "viewerEnter"] }]);
	sessions = createLiveSessionEngine({
		bus,
		logger,
		table,
		subscription: (id) => subs.get(id),
		sourceStatus: { running: (key) => running.has(key) },
		fans: () => undefined,
		settings: () => settings,
		timers,
	});
	collector = new ViewerChatCollector([]);
	interactions = createLiveInteractions({
		logger,
		subscription: (id) => subs.get(id),
		settings: () => settings,
		sourceStatus: { running: (key) => running.has(key) },
		table,
		profileName: () => "主播A",
		profileAvatar: () => undefined,
		source: () => ({
			liveInteractions: {
				async fetchViewerAvatar() {
					avatarAsked += 1;
					return avatarImpl ? await avatarImpl() : ok({ ref: VIEWER_AVATAR });
				},
			},
		}),
		gates: createSourceGates(),
		renderer: () => renderer,
		sendFor: (id) => async (groups, type) => {
			const segments = groups.flat();
			sentSegments.push({ id, type, segments });
			const text = segments.map((seg) => (seg.kind === "text" ? seg.text : "")).join("");
			sent.push({ id, text, type });
		},
		sessions,
		collector,
		serviceCtx: { track: () => {}, signal: new AbortController().signal },
	});
});

afterEach(() => {
	interactions.dispose();
	sessions.dispose();
	table.dispose();
	vi.useRealTimers();
});

const chat = (id: string, name = "小明", text = "你好呀") =>
	interactions.apply(SUB.id, { kind: "viewerChat", viewer: { id, name }, text });
const enter = (id: string, name = "小明") =>
	interactions.apply(SUB.id, { kind: "viewerEnter", viewer: { id, name } });
const startSession = () =>
	sessions.apply({
		kind: "start",
		subscriptionId: SUB.id,
		identity: SUB.identity,
		startedAt: new Date(T0).toISOString(),
		details: { title: "一场" },
	});
const flush = () => vi.runAllTimersAsync();

describe("特别弹幕", () => {
	it("名单命中且开关开着:按订阅现折的文案交出一句,走特别弹幕这一种推送", () => {
		chat("123");
		expect(sent).toEqual([
			{ id: SUB.id, text: "主播A 的直播间里 小明 说:你好呀", type: LivePushType.ViewerChat },
		]);
	});

	it("名单按 viewer.id 整串认:id 不在名单上的不推(哪怕名字恰是名单上的那串),名单里 123 时 1234 不推", () => {
		chat("999", "123");
		chat("1234", "小明");
		expect(sent).toEqual([]);
	});

	it("名单上的人没带这一把特性(只带进场)→ 不推", () => {
		settings = settingsWith([{ id: "123", features: ["viewerEnter"] }]);
		chat("123");
		expect(sent).toEqual([]);
	});

	it("开关与名单都要:名单有人、开关关着 → 不推", () => {
		settings = settingsWith([{ id: "123", features: ["viewerChat"] }], { viewerChat: false });
		chat("123");
		expect(sent).toEqual([]);
	});

	it("开关与名单都要:开关开着、名单没有这个人 → 不推", () => {
		settings = settingsWith([]);
		chat("123");
		expect(sent).toEqual([]);
	});

	it("订阅停用了、或来源没在跑 → 不推", () => {
		subs.set(SUB.id, { ...SUB, enabled: false });
		chat("123");
		subs.set(SUB.id, SUB);
		running.clear();
		chat("123");
		expect(sent).toEqual([]);
	});

	it("订阅不在了 → 丢弃,不抛", () => {
		subs.clear();
		expect(() => chat("123")).not.toThrow();
		expect(sent).toEqual([]);
	});
});

describe("特别进场", () => {
	it("名单命中且开关开着:交出一句,走特别进场这一种推送", () => {
		enter("123");
		expect(sent).toEqual([
			{ id: SUB.id, text: "小明 进入了 主播A 的直播间", type: LivePushType.ViewerEnter },
		]);
	});

	it("名单按 viewer.id 认(名字恰是名单上的那串也不推);名单上的人没带进场 → 不推", () => {
		enter("999", "123");
		settings = settingsWith([{ id: "123", features: ["viewerChat"] }]);
		enter("123");
		expect(sent).toEqual([]);
	});

	it("开关与名单都要:名单有人、开关关着 → 不推", () => {
		settings = settingsWith([{ id: "123", features: ["viewerEnter"] }], { viewerEnter: false });
		enter("123");
		expect(sent).toEqual([]);
	});
});

describe("醒目留言", () => {
	const superchat = (
		over: Partial<Omit<LiveInteractionReport & { kind: "superchat" }, "kind">> = {},
	) =>
		interactions.apply(SUB.id, {
			kind: "superchat",
			viewer: { id: "42", name: "粉丝" },
			text: "加油",
			amount: 50,
			currency: "CNY",
			tier: { rank: 2, durationSec: 120 },
			...over,
		} as LiveInteractionReport);

	it("过门槛:按档出卡,头像只取一次,走醒目留言这一种推送", async () => {
		superchat();
		await flush();
		expect(superchatCard).toHaveBeenCalledTimes(1);
		expect(superchatCard.mock.calls[0]?.[0]).toMatchObject({
			viewer: { name: "粉丝", avatar: VIEWER_AVATAR },
			creator: { name: "主播A" },
			text: "加油",
			amount: 50,
			currency: "CNY",
			tier: { rank: 2, durationSec: 120 },
		});
		expect(avatarAsked).toBe(1);
		expect(sentSegments).toEqual([
			{
				id: SUB.id,
				type: LivePushType.Superchat,
				segments: [{ kind: "image", buffer: SC_CARD, mime: "image/jpeg" }],
			},
		]);
	});

	it("低于门槛:不取头像、不出卡、不发", async () => {
		settings = settingsWith([], { minSuperchatAmount: 100 });
		superchat();
		await flush();
		expect(avatarAsked).toBe(0);
		expect(superchatCard).not.toHaveBeenCalled();
		expect(sent).toEqual([]);
	});

	it("非人民币不比门槛,放行", async () => {
		settings = settingsWith([], { minSuperchatAmount: 100 });
		superchat({ amount: 5, currency: "USD" });
		await flush();
		expect(superchatCard).toHaveBeenCalledTimes(1);
		expect(sentSegments[0]?.type).toBe(LivePushType.Superchat);
	});

	it("出不了卡:来源给了兜底句就用它", async () => {
		renderer = null;
		superchat({ fallbackText: "来源自己的兜底句" });
		await flush();
		expect(avatarAsked).toBe(0);
		expect(sent).toEqual([{ id: SUB.id, text: "来源自己的兜底句", type: LivePushType.Superchat }]);
	});

	it("出不了卡、来源没给兜底句:用核心字典里那句中性的", async () => {
		renderer = null;
		superchat();
		await flush();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.text).toContain("粉丝");
		expect(sent[0]?.text).toContain("加油");
		expect(sent[0]?.text).toContain("醒目留言");
	});

	it("醒目留言开关关着 → 不推,也不取头像", async () => {
		settings = settingsWith([], { superchat: false });
		superchat();
		await flush();
		expect(avatarAsked).toBe(0);
		expect(superchatCard).not.toHaveBeenCalled();
		expect(sent).toEqual([]);
	});

	it("来源没交懒取口:卡照出,只是没有观众头像", async () => {
		interactions.dispose();
		interactions = createLiveInteractions({
			logger,
			subscription: (id) => subs.get(id),
			settings: () => settings,
			sourceStatus: { running: (key) => running.has(key) },
			table,
			profileName: () => "主播A",
			profileAvatar: () => undefined,
			source: () => ({}),
			gates: createSourceGates(),
			renderer: () => renderer,
			sendFor: (id) => async (groups, type) => {
				const segments = groups.flat();
				sentSegments.push({ id, type, segments });
				sent.push({ id, text: "", type });
			},
			sessions,
			collector,
			serviceCtx: { track: () => {}, signal: new AbortController().signal },
		});
		superchat();
		await flush();
		expect(superchatCard.mock.calls[0]?.[0]).toMatchObject({ viewer: { name: "粉丝" } });
		expect(superchatCard.mock.calls[0]?.[0]).not.toHaveProperty("viewer.avatar");
		expect(sentSegments[0]?.type).toBe(LivePushType.Superchat);
	});

	it("来源一直不回:超时后卡照出、没有观众头像,记一条错误日志", async () => {
		avatarImpl = () => new Promise(() => {});
		superchat();
		await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
		await flush();
		expect(superchatCard).toHaveBeenCalledTimes(1);
		expect(superchatCard.mock.calls[0]?.[0]).toMatchObject({ viewer: { name: "粉丝" } });
		expect(superchatCard.mock.calls[0]?.[0]).not.toHaveProperty("viewer.avatar");
		expect(logger.error).toHaveBeenCalledTimes(1);
	});

	it("来源抛错:卡照出、没有观众头像", async () => {
		avatarImpl = async () => {
			throw new Error("avatar down");
		};
		superchat();
		await flush();
		expect(superchatCard).toHaveBeenCalledTimes(1);
		expect(superchatCard.mock.calls[0]?.[0]).toMatchObject({ viewer: { name: "粉丝" } });
		expect(superchatCard.mock.calls[0]?.[0]).not.toHaveProperty("viewer.avatar");
		expect(logger.error).toHaveBeenCalledTimes(1);
	});

	it("来源回失败:卡照出、没有观众头像", async () => {
		avatarImpl = async () => fail("not_found", "没有头像");
		superchat();
		await flush();
		expect(superchatCard).toHaveBeenCalledTimes(1);
		expect(superchatCard.mock.calls[0]?.[0]).toMatchObject({ viewer: { name: "粉丝" } });
		expect(superchatCard.mock.calls[0]?.[0]).not.toHaveProperty("viewer.avatar");
	});
});

describe("下播回顾的弹幕收集(归核心)", () => {
	const wantsRecap = (): InteractionSettings =>
		settingsWith([], {
			liveEnd: true,
			extras: { atAllPost: false, atAllLiveStart: false, wordcloud: true, liveSummary: false },
		});

	it("场次开着、下播且词云(或总结)开着:弹幕记一条,不论发弹幕的人在不在名单", () => {
		settings = wantsRecap();
		startSession();
		chat("999", "路人", "今天这一场真好看");
		expect(collector.snapshot(SUB.id).senderRecord).toEqual({ 路人: 1 });
		expect(collector.snapshot(SUB.id).viewerChatCount).toBe(1);
	});

	it("条件与 wantsLiveEndExtras 相同:下播关着、或词云与总结都关着 → 不记", () => {
		settings = { ...wantsRecap(), liveEnd: false };
		startSession();
		chat("999", "路人");
		expect(collector.snapshot(SUB.id).viewerChatCount).toBe(0);

		settings = settingsWith([]);
		chat("999", "路人");
		expect(collector.snapshot(SUB.id).viewerChatCount).toBe(0);
	});

	it("没有这一场(场次没开)→ 不记,不会攒出一份没人清的数据", () => {
		settings = wantsRecap();
		chat("999", "路人");
		expect(collector.snapshot(SUB.id).viewerChatCount).toBe(0);
		expect(collector.stats().rooms).toBe(0);
	});

	it("场次结束清掉", () => {
		settings = wantsRecap();
		startSession();
		chat("999", "路人");
		sessions.apply({
			kind: "end",
			subscriptionId: SUB.id,
			identity: SUB.identity,
			endedAt: new Date(T0 + 60_000).toISOString(),
		});
		expect(collector.snapshot(SUB.id).viewerChatCount).toBe(0);
		expect(collector.stats().rooms).toBe(0);
	});

	it("醒目留言也记进回顾(条件同弹幕),醒目留言开关关着也记", async () => {
		settings = { ...wantsRecap(), superchat: false };
		startSession();
		interactions.apply(SUB.id, {
			kind: "superchat",
			viewer: { id: "42", name: "粉丝" },
			text: "SC 也要进词云",
			amount: 50,
			currency: "CNY",
			tier: { rank: 2 },
		} as LiveInteractionReport);
		await flush();
		expect(collector.snapshot(SUB.id).senderRecord).toEqual({ 粉丝: 1 });
		expect(collector.snapshot(SUB.id).viewerChatCount).toBe(1);
		expect(sent).toEqual([]);
	});
});
