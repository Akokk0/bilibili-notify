/**
 * 拓展订阅的直播推送与计时器(`bindLivePush`,ADR-0019 决策 53 / 56–58 / 61 / 67)。
 *
 * 喂一条真的总线、一张真的在播表(最新状态从它取),出卡与发送换成记账的替身,时钟走假定时器:
 * - 开播 / 下播卡只由事件触发(决策 53);
 * - 断流接续:下播先压着,等待期间再开播就两张都不发、沿用第一次的开播时刻(决策 58);
 * - 周期「正在直播」只在上次推送之后收到过新状态时推,否则跳过、记进上报出入框(决策 61);
 * - 重启补推只在 BN 起来后第一次见到这一场在播、且没见过它的开播事件时推一次(决策 57);
 * - 拓展停了 / 订阅停用或删了:计时器与等着的下播全部作废,不补推(决策 61);
 * - 粉丝那一格:开播记下资料里的粉丝数,下播拿最新那份相减(决策 56);
 * - 卡上的输入是中立的 `LiveCardInput`(㉒c):图是图库引用、开播时刻是 ISO,封面与事件头像的字节出卡那一刻才存进图库
 *   (`liveImages`),版式藏起卡片 / 关了出图不写盘,写盘失败降级成纯文字。
 *
 * ⚠️ 这个文件用假定时器:别用 `waitFor` / `findBy*`(会死锁),推进时间一律 `advanceTimersByTimeAsync`。
 */

import type { ImageRenderer, LiveCardInput } from "@bilibili-notify/image";
import {
	defaultMessageKindLayout,
	type ImageRef,
	type Subscription,
	type SubscriptionReport,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import {
	deferred,
	makeTrackingContext,
	type TrackingContext,
} from "../../__tests__/support/track-context.js";
import type { ReportDiscrepancy } from "../../extensions/context.js";
import { imageRefOf } from "../../images/image-store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { bindExtensionLive } from "../extension-live.js";
import type { LiveNotifySend } from "../live-notify.js";
import { bindLivePush } from "../live-push.js";
import {
	createLiveSessionEngine,
	type LiveSessionEngine,
	type LiveStatusReader,
} from "../live-sessions.js";
import type { LiveSettings } from "../live-settings.js";
import { createLiveTable, type LiveTable } from "../live-table.js";
import { type LivePushAnchor, LivePushType } from "../live-types.js";
import type { LiveSummaryRequester } from "../recap/live-summary-requester.js";
import { ViewerChatCollector } from "../recap/viewer-chat-collector.js";

const EXT = "douyin";
const SUB = makeExtensionSubscription({ extensionId: EXT, externalId: "sec-uid-1" });
const T0 = Date.UTC(2026, 8, 24, 4, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
/** 另一张图(与 `PNG` 内容不同,引用也不同)。 */
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);
/** 订阅资料里存进图库的头像引用(资料缓存的 `cachedProfile.avatar`)。 */
const PROFILE_AVATAR: ImageRef = `${"a".repeat(64)}.png`;
/** 北京时间 T0 的 ISO:卡输入里的开播时刻(在播表、场次里仍是毫秒,交给卡前转 ISO)。 */
const isoOf = (ms: number): string => new Date(ms).toISOString();
const URL = "https://live.douyin.com/123";
const logger = { debug() {}, info() {}, warn() {}, error() {} };

/** 发出去的一张卡:哪条订阅、哪种推送、文字部件、卡上画的输入。 */
interface Sent {
	id: string;
	type: number;
	text: string;
	input: LiveCardInput | undefined;
	extras: LivePushAnchor[];
}

function baseSettings(over: Partial<LiveSettings> = {}): LiveSettings {
	return {
		liveStart: true,
		liveStreaming: false,
		liveEnd: true,
		membership: false,
		membershipMinRank: {},
		membershipTemplates: {},
		superchat: false,
		viewerChat: false,
		viewerEnter: false,
		extras: { atAllPost: false, atAllLiveStart: false, wordcloud: false, liveSummary: false },
		customLiveSummary: { enable: true },
		specialViewerChat: { specialViewers: [], template: "" },
		specialViewerEnter: { specialViewers: [], template: "" },
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
let table: LiveTable;
let sessions: LiveSessionEngine;
let handle: { dispose(): void };
let extensionLive: { dispose(): void };
let sent: Sent[];
let discrepancies: ReportDiscrepancy[];
let settings: LiveSettings;
let subs: Map<string, Subscription>;
let running: boolean;
/** 订阅资料(名字 / 粉丝数),现取。 */
let profile: { name?: string; fans?: number; fanClubName?: string } | undefined;
/** 出卡:每张卡的输入按出卡顺序记下;`slowNext` 让下一张卡卡住,由测试放行。 */
let renderedInputs: LiveCardInput[];
/** 订阅资料里的头像引用,现取;`undefined` = 资料里没有头像。 */
let avatarRef: ImageRef | undefined;
/** 真正写进图库的那几次(`liveImages.put`,出卡那一刻 `commit` 才会走到);`putFails` 让图库说存不进。 */
let storedImages: Uint8Array[];
let putFails: boolean;
/** 出图器:`null` = 关了出图。 */
let rendererOn: boolean;
let slowNext: Promise<void> | undefined;
/** 登记进 `track` 的后台活(切片 ③)。 */
let ctx: TrackingContext;
/** 来源有没有周期「正在直播」这一档(读口 `hasLiveTick` 的答案)。 */
let sourceHasLiveTick: boolean;
/** 推送这头(`bindLivePush`)挂过的周期计时器的间隔,按挂的先后(场次 / 在播表自己的计时器不算)。 */
let periodicIntervals: number[];
/** 来源的拉取式(`fetchLiveStatus`)读口;`undefined` = 来源没实现,场次不挂周期核对。 */
let statusReader: LiveStatusReader | undefined;
/** 回顾收集器:场次结束时从这里同步取一份快照。 */
let chats: ViewerChatCollector;
/** 发给总结请求器的参数,按调用顺序。 */
let summaryCalls: Array<Parameters<LiveSummaryRequester["generate"]>[0]>;
/** 下一份 AI 总结;`undefined` = 只有模板版。 */
let aiMade: Promise<string | undefined> | undefined;

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
	table = createLiveTable({ bus, timers });
	sessions = createLiveSessionEngine({
		bus,
		logger,
		table,
		subscription: (id) => subs.get(id),
		sourceStatus: { running: () => running },
		fans: () => profile?.fans,
		settings: () => settings,
		timers,
		...(statusReader ? { liveStatus: statusReader } : {}),
	});
	// 拓展上报先存图、翻成中立信号再交引擎(真的绑定;图库换成记账的替身)。
	extensionLive = bindExtensionLive({
		bus,
		logger,
		serviceCtx: ctx,
		subscription: (id) => subs.get(id),
		profileName: () => profile?.name,
		liveImages: {
			put: async (bytes) => {
				if (putFails)
					return { ok: false as const, code: "unavailable", message: "磁盘写失败" } as never;
				storedImages.push(bytes);
				const ref = imageRefOf(bytes);
				if (!ref) throw new Error("夹具图不合规");
				return { ok: true as const, ref };
			},
		},
		sessions,
	});
	const renderer = {
		generateLiveCard: vi.fn(async (input: LiveCardInput) => {
			renderedInputs.push(input);
			const wait = slowNext;
			slowNext = undefined;
			if (wait) await wait;
			return Buffer.from("card");
		}),
	} as unknown as ImageRenderer;
	handle = bindLivePush({
		bus,
		logger,
		sessions,
		table,
		subscription: (id) => subs.get(id),
		profile: () => profile,
		settings: () => settings,
		liveCover: () => undefined,
		sourceStatus: { running: () => running },
		hasLiveTick: () => sourceHasLiveTick,
		avatarRef: () => avatarRef,
		recap: {
			collector: chats,
			wordcloud: { generate: async () => Buffer.from("wordcloud") },
			summary: {
				generate(params) {
					summaryCalls.push(params);
					return {
						template: `总结模板:${Object.keys(params.senderRecord).join(",")}`,
						...(aiMade ? { ai: aiMade } : {}),
					};
				},
			},
		},
		sendFor:
			(id): LiveNotifySend =>
			async (groups, type, extras = []) => {
				const text = groups
					.flat()
					.flatMap((seg) => (seg.kind === "text" ? [seg.text] : []))
					.join("\n");
				sent.push({ id, type, text, input: renderedInputs.at(-1), extras: [...extras] });
			},
		renderer: () => (rendererOn ? renderer : null),
		onReportDiscrepancy: (discrepancy) => discrepancies.push(discrepancy),
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
	discrepancies = [];
	renderedInputs = [];
	avatarRef = undefined;
	storedImages = [];
	putFails = false;
	rendererOn = true;
	slowNext = undefined;
	ctx = makeTrackingContext();
	periodicIntervals = [];
	statusReader = undefined;
	sourceHasLiveTick = true;
	settings = baseSettings();
	chats = new ViewerChatCollector([]);
	summaryCalls = [];
	aiMade = undefined;
	subs = new Map([[SUB.id, SUB]]);
	running = true;
	profile = { name: "抖音甲", fans: 12_345 };
});

afterEach(() => {
	handle?.dispose();
	extensionLive?.dispose();
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
			creator: { name: "抖音甲" },
			title: "第一场",
			category: "聊天",
			description: "简介",
			startedAt: isoOf(T0),
			currentViewers: 10,
			likes: 3,
			totalViewers: 40,
			followers: 12_345,
		});
		// 封面是图库引用(出卡那一刻才存),不是 data URL。
		expect(card?.input?.cover).toEqual({ ref: imageRefOf(PNG) });
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
			startedAt: isoOf(T0),
			// 事件带了的用事件的,没带的用这一场最后一份状态补。
			likes: 900,
			totalViewers: 100,
			title: "第一场",
			followersDelta: 128,
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
		expect(Object.hasOwn(sent[1]?.input ?? {}, "followersDelta")).toBe(false);
	});

	it("BN 手里没有这一场(中途重启过、拓展没报过状态):照推下播卡,时长用事件带的开播时刻", async () => {
		start();
		liveEnd({ startedAt: T0 - HOUR });
		await settle();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.type).toBe(9);
		expect(sent[0]?.text).toContain("本次直播了 1小时");
		expect(sent[0]?.input?.startedAt).toBe(isoOf(T0 - HOUR));
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

describe("下播回顾", () => {
	beforeEach(() => {
		settings = baseSettings({
			extras: { atAllPost: false, atAllLiveStart: false, wordcloud: true, liveSummary: true },
		});
	});

	it("下播事件、BN 没这一场的兜底、断流等待到期:三种结束都把词云与总结挂在下播卡后", async () => {
		start();

		// 来源报的下播。
		chats.recordViewerChat(SUB.id, "下播回顾甲", "观众甲");
		liveStart({ totalViewers: 17 });
		await settle();
		liveEnd();
		await settle();
		expect(sent.at(-1)?.type).toBe(LivePushType.LiveEnd);
		expect(sent.at(-1)?.extras.map((anchor) => anchor.extra)).toEqual(["wordcloud", "liveSummary"]);

		// BN 手里没有这一场:下播事件仍要推一张兜底下播卡,回顾照样挂在它后面。
		liveEnd();
		await settle();
		expect(sent.at(-1)?.type).toBe(LivePushType.LiveEnd);
		expect(sent.at(-1)?.extras.map((anchor) => anchor.extra)).toEqual(["wordcloud", "liveSummary"]);

		// 断流等待到期才真正结束。
		settings = baseSettings({
			liveEndGrace: true,
			liveEndGraceMinutes: 3,
			extras: { atAllPost: false, atAllLiveStart: false, wordcloud: true, liveSummary: true },
		});
		liveStart();
		await settle();
		liveEnd();
		await vi.advanceTimersByTimeAsync(3 * MINUTE);
		await settle();
		expect(sent.at(-1)?.type).toBe(LivePushType.LiveEnd);
		expect(sent.at(-1)?.extras.map((anchor) => anchor.extra)).toEqual(["wordcloud", "liveSummary"]);
	});

	it("回顾读的是这一场收集器里的弹幕,粉丝团名取资料缓存", async () => {
		profile = { name: "抖音甲", fans: 12_345, fanClubName: "资料里的粉丝团" };
		chats.recordViewerChat(SUB.id, "recapword", "这一场的观众");
		start();
		liveStart();
		await settle();
		liveEnd();
		await settle();

		expect(summaryCalls).toHaveLength(1);
		expect(summaryCalls[0]).toMatchObject({
			senderRecord: { 这一场的观众: 1 },
			fanClubName: "资料里的粉丝团",
		});
		expect(summaryCalls[0]?.sortedWords.some(([word]) => word === "recapword")).toBe(true);
	});

	it("关停之后才做完的 AI 总结给 undefined,模板那份照常", async () => {
		const made = deferred<string | undefined>();
		aiMade = made.promise;
		start();
		liveStart();
		await settle();
		liveEnd();
		await settle();

		const summary = sent.at(-1)?.extras.find((anchor) => anchor.extra === "liveSummary");
		expect(summary).toBeDefined();
		expect(await summary?.messages).toHaveLength(1);
		handle.dispose();
		made.resolve("关停后才做好的 AI 总结");
		await vi.advanceTimersByTimeAsync(0);
		expect(await summary?.aiMessages).toBeUndefined();
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
		expect(sent[1]?.input?.startedAt).toBe(isoOf(T0));
	});

	it("拓展停了:等着的下播卡作废,不补推", async () => {
		start();
		liveStart();
		await settle();
		liveEnd();
		// 上报要先翻译(存图)再交引擎:等下播进了断流等待,再让拓展停。
		await settle();
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

	it("到点时上次推送之后收到过新状态 → 拿在播表里最新那一份推;没有 → 这一轮跳过,记进上报出入框", async () => {
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
			creator: { name: "事件里的名字" },
			description: "新简介",
			title: "改了标题",
			currentViewers: 77,
			totalViewers: 23_456,
			startedAt: isoOf(T0),
			followers: 12_345,
		});
		expect(discrepancies).toEqual([]);

		// 第二小时:拓展一声没吭。
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, 0]);
		expect(discrepancies).toHaveLength(1);
		expect(discrepancies[0]).toMatchObject({
			extensionId: EXT,
			kind: "liveStatus",
			externalId: SUB.identity.externalId,
			subscriptionIds: [SUB.id],
			outcome: "skipped",
		});
		expect(discrepancies[0]?.reasons[0]).toMatch(/没收到新的直播状态/);
	});

	/**
	 * ㉒d:「正在直播」文案的 `{watched}` 缺数时由文字渲染器在出口印「暂未获取到」(从前缺了是空串)。拓展这一头传进来的
	 * 本来就是数字(`facts.totalViewers`,没报就是 `undefined`),所以拓展没报过累计观看的直播,周期文案也印这一句。
	 * 验红:去掉 `renderLiveText` 里缺数时的兜底,这条红。
	 */
	it("拓展一直没报累计观看:周期文案的 {watched} 印「暂未获取到」", async () => {
		start();
		liveStart();
		await settle();
		await vi.advanceTimersByTimeAsync(30 * MINUTE);
		liveStatus({ viewers: 5 });
		await vi.advanceTimersByTimeAsync(30 * MINUTE);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, 0]);
		expect(sent[1]?.text).toBe(`抖音甲 正在直播，已播 1小时，累计观看：暂未获取到\n${URL}`);
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
		expect(discrepancies).toEqual([]);

		liveStatus({ totalViewers: 8 });
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, 0]);
		expect(sent[1]?.input).toMatchObject({ status: "streaming", totalViewers: 8 });
		expect(discrepancies).toEqual([]);
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
		expect(discrepancies).toEqual([]);
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
		expect(discrepancies).toEqual([]);
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

	// 周期「正在直播」只对有这一档的源成立(拓展怎么认见 `extensionHasLiveTick`)。
	// 全局默认开着(迁移把旧的周期间隔折成了全局开)时,没有这一档的源名下的订阅也不挂。
	it("源没有周期这一档(例如只声明了开播):开关开着也不挂计时器、不推", async () => {
		sourceHasLiveTick = false;
		start();
		liveStart();
		await settle();
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(periodicIntervals).toEqual([]);
		expect(discrepancies).toEqual([]);
	});

	it("源有周期这一档 → 挂", async () => {
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
		expect(discrepancies).toEqual([]);
	});

	it("订阅停用 → 这一场作废,周期推送停了", async () => {
		start();
		liveStart();
		await settle();
		const disabled = { ...SUB, enabled: false };
		subs.set(SUB.id, disabled);
		bus.emit("subscription-changed", { ops: [{ kind: "update", sub: disabled }] });
		// 马上又启用回来:停用那一刻这一场就作废了,启用不会把它的计时器救回来。
		subs.set(SUB.id, SUB);
		bus.emit("subscription-changed", { ops: [{ kind: "update", sub: SUB }] });
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(discrepancies).toEqual([]);
	});

	it("订阅删了 → 这一场作废", async () => {
		start();
		liveStart();
		await settle();
		subs.delete(SUB.id);
		bus.emit("subscription-changed", { ops: [{ kind: "remove", sub: SUB }] });
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(discrepancies).toEqual([]);
	});

	it("拓展停了 → 周期推送作废,不再记跳过", async () => {
		start();
		liveStart();
		await settle();
		bus.emit("extension-stopped", { extensionId: EXT });
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(discrepancies).toEqual([]);
	});
});

/**
 * 来源实现了 `fetchLiveStatus`:周期「正在直播」归场次的计时(按这一场自己的开播时刻起算),到点问来源、还在播就
 * 发 `tick`,推送这头据此推一张(周期那一档 `Live`);推送这头不再挂自己的周期计时器(宿主对这样的来源让
 * `hasLiveTick` 答没有)。周期关着只核不推。
 */
describe("拉取式的周期「正在直播」(fetchLiveStatus)", () => {
	beforeEach(() => {
		sourceHasLiveTick = false;
		statusReader = {
			has: () => true,
			fetch: async () => ({
				ok: true,
				kind: "live",
				details: { title: "问到的标题", url: URL, totalViewers: 500 },
			}),
		};
	});

	it("到点还在播 → 推一张「正在直播」,卡上是刚问到的那一份;推送这头没挂周期计时器", async () => {
		settings = baseSettings({ liveStreaming: true, streamingIntervalHours: 2 });
		start();
		liveStart({ startedAt: T0, title: "开播时的标题" });
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, 0]);
		expect(sent[1]?.input).toMatchObject({ status: "streaming", title: "问到的标题" });
		expect(periodicIntervals).toEqual([]);
	});

	it("周期关着:到点只核不推", async () => {
		const fetched = vi.fn(statusReader?.fetch);
		statusReader = { has: () => true, fetch: fetched };
		start();
		liveStart({ startedAt: T0 });
		await settle();
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(fetched).toHaveBeenCalledTimes(1);
		expect(sent.map((s) => s.type)).toEqual([3]);
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
		expect(sent[0]?.input).toMatchObject({
			status: "streaming",
			startedAt: isoOf(T0 - 30 * MINUTE),
		});
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
		// 上报要先翻译(存图)再交引擎,补报的卡先开始出卡(出卡要几秒,这里让它停在半路);开播信号在这期间交进引擎。
		let release: () => void = () => {};
		slowNext = new Promise<void>((resolve) => {
			release = resolve;
		});
		liveStatus();
		liveStart();
		await settle();
		release();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3]);
		expect(sent[0]?.input?.status).toBe("start");
		// 发送前认出换了一场:那张「正在直播」画好了也不发。
		expect(renderedInputs.map((i) => i.status)).toEqual(["streaming", "start"]);
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

	it("下播卡在途时重开:开播卡等下播卡送达完成后才发(送达序 = 发起序)", async () => {
		start();
		let release: () => void = () => {};
		slowNext = new Promise<void>((resolve) => {
			release = resolve;
		});
		liveEnd();
		liveStart({ startedAt: Date.now() });
		await settle();
		expect(sent).toEqual([]);
		release();
		await settle();
		expect(sent.map((s) => s.type)).toEqual([9, 3]);
	});
});

/**
 * 卡上的图走图库(ADR-0021 决策 22 / 24 下 2026-10-05 的 🔗,㉒c):封面与事件带来的作者头像是拓展交的字节,
 * `liveCardInputFromReport` 翻成图库引用、**出卡那一刻才写盘**;订阅资料里的头像本来就在图库里,直接用它的引用。
 */
describe("卡上的图走图库", () => {
	it("事件带了头像与封面:收到上报就写进图库,输入里是它们的引用", async () => {
		start();
		liveStart({ cover: PNG, author: { name: "事件里的名字", avatar: PNG_B } });
		await settle();

		expect(sent[0]?.input?.cover).toEqual({ ref: imageRefOf(PNG) });
		expect(sent[0]?.input?.creator).toEqual({
			name: "事件里的名字",
			avatar: imageRefOf(PNG_B),
		});
		// 存图在翻译上报时(`bindExtensionLive`),不等出卡;细节见 `extension-live.test.ts`。
		expect(storedImages).toEqual([PNG, PNG_B]);
	});

	it("事件没带头像:订阅资料里的头像引用顶上,不再存一遍", async () => {
		avatarRef = PROFILE_AVATAR;
		start();
		liveStart({ cover: PNG });
		await settle();

		expect(sent[0]?.input?.creator.avatar).toBe(PROFILE_AVATAR);
		expect(storedImages).toEqual([PNG]);
	});

	it("事件和资料里都没有头像:输入里没有 avatar 这个键(头像块整块收起)", async () => {
		start();
		liveStart();
		await settle();

		expect(sent[0]?.input?.creator).toStrictEqual({ name: "抖音甲" });
		expect(storedImages).toEqual([]);
	});

	/**
	 * 直播可以超过 24 小时,周期卡几小时后还要用封面:在播表里一直装着那条图库引用(图库那头把在播表里的封面
	 * 登记为这一家的名单,见 `live-images-wiring.test.ts`),周期卡直接用它,不再存一遍。
	 */
	it("周期「正在直播」卡用在播表里的封面引用,不再存图", async () => {
		settings = baseSettings({ liveStreaming: true, streamingIntervalHours: 1 });
		start();
		liveStart({ cover: PNG });
		await settle();
		expect(storedImages).toEqual([PNG]);

		await vi.advanceTimersByTimeAsync(30 * MINUTE);
		liveStatus();
		await vi.advanceTimersByTimeAsync(30 * MINUTE);
		await settle();
		expect(sent.map((s) => s.type)).toEqual([3, 0]);
		// 带封面的开播上报存了一次;不带封面的那份状态不存,周期卡的封面是表里留着的那条引用。
		expect(storedImages).toEqual([PNG]);
		expect(sent[1]?.input?.cover).toEqual({ ref: imageRefOf(PNG) });
	});

	it("版式把卡片藏起来:不出卡,文字照发(图在收到上报时已经存了)", async () => {
		const textOnly = {
			blocks: [
				{ id: "card", type: "card", visible: false },
				{ id: "text", type: "text", visible: true },
			],
			separator: "\n",
		};
		settings = baseSettings({ messageLayout: textOnly as never });
		start();
		liveStart({ cover: PNG, author: { avatar: PNG_B } });
		await settle();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.input).toBeUndefined();
		// 看得见的变化:存图在翻译上报时,不再等出卡 —— 不出卡的直播也存(同作品的先例,3a-27 决策 3)。
		expect(storedImages).toEqual([PNG, PNG_B]);
	});

	it("关了出图(没有渲染器):不出卡,文字照发(图照存)", async () => {
		rendererOn = false;
		start();
		liveStart({ cover: PNG });
		await settle();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.input).toBeUndefined();
		expect(storedImages).toEqual([PNG]);
	});

	it("图库说存不进(写盘失败):那张图缺着,卡照出、推送照发", async () => {
		putFails = true;
		start();
		liveStart({ cover: PNG });
		await settle();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.text).toContain("开播啦");
		expect(sent[0]?.input).toBeDefined();
		expect(Object.hasOwn(sent[0]?.input ?? {}, "cover")).toBe(false);
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
		// 先让上报翻完、交进引擎(绑定那一件已经落定),推送那头的出卡才开始。
		await settle();
		void Promise.all(ctx.tracked).then(() => {
			settledAlready = true;
		});
		await settle();

		expect(ctx.tracked).toHaveLength(2); // 上报的翻译(已落定)+ 这张开播卡
		expect(settledAlready).toBe(false); // 出卡还卡着,登记的这件事不许落
		expect(sent).toEqual([]);

		sending.resolve(undefined);
		await settle();
		await ctx.settled();
		expect(sent).toHaveLength(1);
	});
});
