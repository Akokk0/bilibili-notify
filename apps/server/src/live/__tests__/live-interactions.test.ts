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
	type MembershipProgram,
	type MessageLayoutSegment,
	ok,
	type Result,
	type Subscription,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { i18n } from "../../i18n/index.js";
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
import { LivePushKind } from "../live-types.js";
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
	| "membership"
	| "membershipMinRank"
	| "membershipTemplates"
	| "superchat"
	| "minSuperchatAmount"
	| "extras"
	| "viewerChat"
	| "viewerEnter"
	| "cardSkin"
	| "cardSkinKnobs"
	| "specialViewerChat"
	| "specialViewerEnter"
>;

const CHAT_TEMPLATE = "{name} 的直播间里 {viewer} 说:{msg}";
const ENTER_TEMPLATE = "{viewer} 进入了 {name} 的直播间";
const VIEWER_AVATAR = `${"a".repeat(64)}.webp` as ImageRef;
const TIER_ICON = `${"f".repeat(64)}.png` as ImageRef;
const SC_CARD = Buffer.from("sc-card-jpeg");
const MEMBERSHIP_CARD = Buffer.from("membership-card-jpeg");
type SuperchatRenderer = NonNullable<ReturnType<LiveInteractionsOptions["renderer"]>>;

const DECLARED_TIER = {
	key: "gold",
	name: "金牌",
	rank: 2,
	color: "#123456",
	colorEnd: "#654321",
	announcement: "{viewer} 加入了{tier}",
};
const DECLARED_PROGRAM: MembershipProgram = {
	id: "acme-club",
	name: "俱乐部",
	tiers: [DECLARED_TIER],
};
const CUSTOM_PROGRAM: MembershipProgram = { id: "acme-custom", name: "自定", tiers: "custom" };

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
let profileName: string | undefined;
let avatarAsked: number;
let avatarImpl: (() => Promise<Result<{ ref: ImageRef }>>) | undefined;
let tierAsked: number;
let tierImpl: (() => Promise<Result<{ ref: ImageRef }>>) | undefined;
let programs: MembershipProgram[];
let superchatCard: ReturnType<typeof vi.fn>;
let membershipCard: ReturnType<typeof vi.fn>;
let renderer: SuperchatRenderer | null;

function settingsWith(
	specialViewers: InteractionSettings["specialViewerChat"]["specialViewers"],
	over: Partial<InteractionSettings> = {},
): InteractionSettings {
	return {
		liveStart: true,
		liveEnd: true,
		liveEndGrace: false,
		liveEndGraceMinutes: 2,
		liveStreaming: false,
		streamingIntervalHours: 1,
		membership: true,
		membershipMinRank: {},
		membershipTemplates: () => ({
			enabled: false,
			default: { template: "", imageUrl: "" },
			tiers: {},
		}),
		superchat: true,
		extras: { atAllPost: false, atAllLiveStart: false, wordcloud: false, liveSummary: false },
		viewerChat: true,
		viewerEnter: true,
		specialViewerChat: { specialViewers, template: CHAT_TEMPLATE },
		specialViewerEnter: { specialViewers, template: ENTER_TEMPLATE },
		...over,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	bus = createNodeMessageBus();
	table = createLiveTable({ bus });
	subs = new Map([[SUB.id, SUB]]);
	running = new Set([EXT]);
	sent = [];
	sentSegments = [];
	profileName = "主播A";
	avatarAsked = 0;
	avatarImpl = undefined;
	tierAsked = 0;
	tierImpl = undefined;
	programs = [DECLARED_PROGRAM, CUSTOM_PROGRAM];
	vi.clearAllMocks();
	superchatCard = vi.fn(async () => SC_CARD);
	membershipCard = vi.fn(async () => MEMBERSHIP_CARD);
	renderer = {
		generateSuperchatCard: superchatCard,
		generateMembershipCard: membershipCard,
	} as unknown as SuperchatRenderer;
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
		profileName: () => profileName,
		identityLabel: () => "测试 · room-1",
		profileAvatar: () => undefined,
		source: () => ({
			descriptor: { label: "测试", supportedFeatures: ["post"], membershipPrograms: programs },
			liveInteractions: {
				async fetchViewerAvatar() {
					avatarAsked += 1;
					return avatarImpl ? await avatarImpl() : ok({ ref: VIEWER_AVATAR });
				},
				async fetchTierIcon() {
					tierAsked += 1;
					return tierImpl ? await tierImpl() : ok({ ref: TIER_ICON });
				},
			},
		}),
		gates: createSourceGates(),
		renderer: () => renderer,
		readImage: async (ref: ImageRef) => ({ bytes: Buffer.from(ref), mime: "image/png" }),
		fetchImage: async () => fail("unavailable", "测试里不抓自定义图"),
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
	i18n.set({ locale: "zh-CN", voice: "maid" });
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

it.each([
	[
		"en",
		"Viewer 原文 sent a paid message in Creator {viewer}'s stream: Original text {name}",
		"In Creator {viewer}'s stream, Viewer 原文 joined membership tier Original tier {text}.",
	],
	[
		"ja",
		"Creator {viewer}の配信で、Viewer 原文が有料メッセージを送りました：Original text {name}",
		"Creator {viewer}の配信で、Viewer 原文がOriginal tier {text}の会員になりました。",
	],
	[
		"zh-TW",
		"在 Creator {viewer} 的直播中，Viewer 原文 傳送了一則付費留言：Original text {name}",
		"在 Creator {viewer} 的直播中，Viewer 原文 成為了 Original tier {text} 會員。",
	],
] as const)(
	"%s:无卡片时的互动回落本地化,来源句与作者/观众/档名原文优先",
	async (locale, paid, member) => {
		i18n.set({ locale, voice: "plain" });
		renderer = null;
		profileName = "Creator {viewer}";
		const viewer = { id: "42", name: "Viewer 原文" };
		interactions.apply(SUB.id, {
			kind: "superchat",
			viewer,
			text: "Original text {name}",
			amount: 50,
			currency: "USD",
			tier: { rank: 2, durationSec: 120 },
		});
		await flush();
		interactions.apply(SUB.id, {
			kind: "membership",
			viewer,
			program: "acme-custom",
			tier: { key: "original", name: "Original tier {text}", rank: 2 },
		});
		await flush();
		interactions.apply(SUB.id, {
			kind: "superchat",
			viewer,
			text: "Original",
			amount: 50,
			currency: "USD",
			tier: { rank: 2, durationSec: 120 },
			fallbackText: "Original source fallback 原文",
		});
		await flush();
		expect(sent).toEqual([
			{ id: SUB.id, type: LivePushKind.Superchat, text: paid },
			{ id: SUB.id, type: LivePushKind.Membership, text: member },
			{ id: SUB.id, type: LivePushKind.Superchat, text: "Original source fallback 原文" },
		]);
		expect(superchatCard).not.toHaveBeenCalled();
		expect(membershipCard).not.toHaveBeenCalled();
	},
);

describe("场次互动汇总", () => {
	it("推送开关全关也记,与推不推无关", () => {
		settings = settingsWith([], {
			viewerChat: false,
			viewerEnter: false,
			superchat: false,
			membership: false,
		});
		startSession();
		chat("chat-viewer");
		interactions.apply(SUB.id, {
			kind: "superchat",
			viewer: { id: "superchat-viewer", name: "醒目留言观众" },
			text: "加油",
			amount: 30,
			currency: "CNY",
		});
		interactions.apply(SUB.id, {
			kind: "membership",
			viewer: { id: "member-viewer", name: "会员" },
			program: "acme-club",
			tier: { key: "gold", name: "金牌", rank: 2 },
		});

		expect(sessions.get(SUB.id)?.interactions).toEqual({
			viewerChatCount: 1,
			viewerChatSenderCount: 1,
			superchatCount: 1,
			superchatTotals: { CNY: 30 },
			membershipCounts: { "acme-club": { gold: 1 } },
		});
	});

	it("订阅停用或删了:这一场的汇总都不记", () => {
		startSession();
		subs.set(SUB.id, { ...SUB, enabled: false });
		chat("disabled-viewer");
		expect(sessions.get(SUB.id)).toBeDefined();
		expect(sessions.get(SUB.id)).not.toHaveProperty("interactions");

		subs.clear();
		interactions.apply(SUB.id, {
			kind: "superchat",
			viewer: { id: "removed-viewer", name: "观众" },
			text: "来晚了",
			amount: 30,
			currency: "CNY",
		});
		expect(sessions.get(SUB.id)).toBeDefined();
		expect(sessions.get(SUB.id)).not.toHaveProperty("interactions");
	});

	it("认不出会员体系或档:丢弃且不记", () => {
		startSession();
		interactions.apply(SUB.id, {
			kind: "membership",
			viewer: { id: "unknown-program", name: "会员" },
			program: "nobody",
			tier: { key: "gold", name: "金牌", rank: 2 },
		});
		interactions.apply(SUB.id, {
			kind: "membership",
			viewer: { id: "unknown-tier", name: "会员" },
			program: "acme-club",
			tier: { key: "missing", name: "没有", rank: 1 },
		});

		expect(sessions.get(SUB.id)).not.toHaveProperty("interactions");
		expect(logger.warn).toHaveBeenCalledTimes(2);
	});

	it("进场不计;醒目留言的非有限金额只计条数;各种会员动作都计,非法赠送数量按 1", () => {
		startSession();
		enter("entered-viewer");
		expect(sessions.get(SUB.id)).not.toHaveProperty("interactions");

		interactions.apply(SUB.id, {
			kind: "superchat",
			viewer: { id: "invalid-amount", name: "观众" },
			text: "金额坏了",
			amount: Number.NaN,
			currency: "CNY",
		});
		for (const [action, count] of [
			["new", undefined],
			["renew", 3],
			["upgrade", 1.5],
			["new", 0],
		] as const) {
			interactions.apply(SUB.id, {
				kind: "membership",
				viewer: { id: `${action}-${String(count)}`, name: "会员" },
				program: "acme-club",
				tier: { key: "gold", name: "金牌", rank: 2 },
				action,
				...(count === undefined ? {} : { gift: { gifter: "member", count } }),
			});
		}

		expect(sessions.get(SUB.id)?.interactions).toEqual({
			superchatCount: 1,
			membershipCounts: { "acme-club": { gold: 6 } },
		});
	});
});

describe("特别弹幕", () => {
	it("名单命中且开关开着:按订阅现折的文案交出一句,走特别弹幕这一种推送", () => {
		chat("123");
		expect(sent).toEqual([
			{ id: SUB.id, text: "主播A 的直播间里 小明 说:你好呀", type: LivePushKind.ViewerChat },
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
			{ id: SUB.id, text: "小明 进入了 主播A 的直播间", type: LivePushKind.ViewerEnter },
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
				type: LivePushKind.Superchat,
				segments: [{ kind: "image", buffer: SC_CARD, mime: "image/jpeg" }],
			},
		]);
	});

	it("没资料名、在播表里没主播名 → 醒目留言文案的 {name} 是标签", async () => {
		profileName = undefined;
		renderer = null;
		superchat();
		await flush();
		expect(sent[0]?.text).toContain("测试 · room-1");
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
		expect(sentSegments[0]?.type).toBe(LivePushKind.Superchat);
	});

	it("出不了卡:来源给了兜底句就用它", async () => {
		renderer = null;
		superchat({ fallbackText: "来源自己的兜底句" });
		await flush();
		expect(avatarAsked).toBe(0);
		expect(sent).toEqual([{ id: SUB.id, text: "来源自己的兜底句", type: LivePushKind.Superchat }]);
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
			profileName: () => profileName,
			identityLabel: () => "测试 · room-1",
			profileAvatar: () => undefined,
			source: () => ({ descriptor: { label: "测试", supportedFeatures: ["post"] } }),
			gates: createSourceGates(),
			renderer: () => renderer,
			readImage: async (ref: ImageRef) => ({ bytes: Buffer.from(ref), mime: "image/png" }),
			fetchImage: async () => fail("unavailable", "测试里不抓自定义图"),
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
		expect(sentSegments[0]?.type).toBe(LivePushKind.Superchat);
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

describe("会员", () => {
	const membership = (
		over: Partial<Omit<LiveInteractionReport & { kind: "membership" }, "kind">> = {},
	) =>
		interactions.apply(SUB.id, {
			kind: "membership",
			viewer: { id: "42", name: "船员" },
			program: "acme-club",
			tier: { key: "gold", name: "金牌", rank: 2 },
			...over,
		} as LiveInteractionReport);

	it("未订阅 membership → 早 return", async () => {
		settings = settingsWith([], { membership: false });
		membership();
		await flush();
		expect(membershipCard).not.toHaveBeenCalled();
		expect(tierAsked).toBe(0);
		expect(sent).toEqual([]);
	});

	it("custom 体系:用事件里的档名,没有徽章、不问来源,自定义文案的 {tier} 取事件里的名字", async () => {
		settings = settingsWith([], {
			membershipTemplates: () => ({
				enabled: true,
				default: { template: "{viewer} 成为了 {tier}", imageUrl: "" },
				tiers: {},
			}),
		});
		membership({
			program: "acme-custom",
			tier: { key: "vip", name: "自定义贵族", rank: 3 },
		});
		await flush();
		expect(sent).toEqual([
			{ id: SUB.id, text: "船员 成为了 自定义贵族", type: LivePushKind.Membership },
		]);
		expect(membershipCard).not.toHaveBeenCalled();
		expect(tierAsked).toBe(0);
	});

	it("逐档声明的体系:取声明的那一档(名字、rank、档色),带 icon.ref 时直接用它、不问来源", async () => {
		const icon = { ref: TIER_ICON };
		programs = [
			{
				...DECLARED_PROGRAM,
				tiers: [{ ...DECLARED_TIER, icon }],
			} as MembershipProgram,
			CUSTOM_PROGRAM,
		];
		membership();
		await flush();
		expect(membershipCard).toHaveBeenCalledTimes(1);
		expect(membershipCard.mock.calls[0]?.[0]).toMatchObject({
			viewer: { name: "船员" },
			tier: {
				name: "金牌",
				rank: 2,
				icon,
				color: "#123456",
				colorEnd: "#654321",
				announcement: "{viewer} 加入了{tier}",
			},
		});
		expect(tierAsked).toBe(0);
		expect(sentSegments[0]?.type).toBe(LivePushKind.Membership);
	});

	it("声明档没带 icon.ref:经懒取口补一次,卡照出", async () => {
		membership();
		await flush();
		expect(tierAsked).toBe(1);
		expect(membershipCard.mock.calls[0]?.[0]).toMatchObject({
			tier: { name: "金牌", icon: { ref: TIER_ICON } },
		});
	});

	it("来源一直不回:超时后卡照出、没有徽章,记一条错误日志", async () => {
		tierImpl = () => new Promise(() => {});
		membership();
		await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
		await flush();
		expect(membershipCard).toHaveBeenCalledTimes(1);
		expect(membershipCard.mock.calls[0]?.[0]).toMatchObject({ tier: { name: "金牌" } });
		expect(membershipCard.mock.calls[0]?.[0]).not.toHaveProperty("tier.icon");
		expect(logger.error).toHaveBeenCalledTimes(1);
	});

	it("门槛按体系 id 取:同一个 rank 在别的体系的门槛下照推", async () => {
		settings = settingsWith([], {
			membershipMinRank: { "acme-club": 3, "acme-custom": 1 },
		});
		membership();
		await flush();
		expect(membershipCard).not.toHaveBeenCalled();
		expect(tierAsked).toBe(0);
		membership({
			program: "acme-custom",
			tier: { key: "vip", name: "自定义贵族", rank: 2 },
		});
		await flush();
		expect(membershipCard).toHaveBeenCalledTimes(1);
	});

	it("认不出的体系 / 认不出的档:丢弃并记一条 warn", async () => {
		membership({ program: "nobody" });
		membership({ tier: { key: "nope", name: "没有", rank: 1 } });
		await flush();
		expect(membershipCard).not.toHaveBeenCalled();
		expect(sent).toEqual([]);
		expect(logger.warn).toHaveBeenCalledTimes(2);
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
		expect(collector.snapshot(SUB.id).topSenders).toEqual([["路人", 1]]);
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
		expect(collector.stats().subscriptions).toBe(0);
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
		expect(collector.stats().subscriptions).toBe(0);
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
		expect(collector.snapshot(SUB.id).topSenders).toEqual([["粉丝", 1]]);
		expect(collector.snapshot(SUB.id).viewerChatCount).toBe(1);
		expect(sent).toEqual([]);
	});
});

it("互动取图超时按当前语言记录成员与时限，不记录观众资料", async () => {
	const previous = i18n.state();
	try {
		i18n.set({ locale: "en", voice: "maid" });
		avatarImpl = () => new Promise(() => {});
		interactions.apply(SUB.id, {
			kind: "superchat",
			viewer: { id: "42", name: "PRIVATE-VIEWER" },
			text: "PRIVATE-CHAT",
			amount: 50,
			currency: "CNY",
			tier: { rank: 2, durationSec: 120 },
		} as LiveInteractionReport);
		await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
		await flush();
		expect(logger.error).toHaveBeenCalledExactlyOnceWith(
			"Live interaction image lookup timed out",
			{
				event: "live.interaction_lookup_timeout",
				subscriptionId: SUB.id,
				sourceKey: EXT,
				member: "liveInteractions.fetchViewerAvatar",
				timeoutMs: LOOKUP_TIMEOUT_MS,
			},
		);
		expect(superchatCard).toHaveBeenCalledTimes(1);
		expect(superchatCard.mock.calls[0]?.[0]).not.toHaveProperty("viewer.avatar");
		expect(JSON.stringify(logger.error.mock.calls)).not.toContain("PRIVATE-");
	} finally {
		i18n.set(previous);
	}
});
