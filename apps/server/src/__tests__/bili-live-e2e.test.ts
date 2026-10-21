/**
 * 🔴 **B 站直播端到端钉住**(3b-13 / 3b-22)。
 *
 * 走的是真的 `createEngines` + 真 `createBiliSource`:弹幕帧(真编解码器编的)→ 真协议解析 → 真房间会话 → 真核心场次 → 真推送层 →
 * 真派发器 → 假平台。假件只有 B 站接口对象、弹幕连接、出图器、平台适配器四样(见 `support/bili-live-world.ts`)。
 * 断言只落在对外的结果上:推出去的内容与次序、总线上的事件与载荷、问题表里的条目、面板「正在直播」那一栏、
 * 交给出图器的输入。
 *
 * 这批是行为测试:公开结果为准,内部怎么接线可以换。每一组的破坏验证写在组头的「验红」里。
 *
 * 时间:世界从 2026-03-01 12:00:00(北京时间)开始,B 站的 `live_time` 恒为北京时间。
 */

import type { LiveSessionChange } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import payloads from "../bilibili/live/protocol/__tests__/fixtures/payloads.json" with {
	type: "json",
};
import {
	BILI_LIVE_EPOCH,
	BILI_LIVE_GUARD_BADGE_REF,
	BILI_LIVE_SECOND_TARGET_ID,
	BILI_LIVE_SUBSCRIPTION_ID,
	BILI_LIVE_TARGET_ID,
	BILI_LIVE_UID,
	bootBiliLiveWorld,
} from "./support/bili-live-world.js";

type World = Awaited<ReturnType<typeof bootBiliLiveWorld>>;
type ViewerChange = {
	subscriptionId: string;
	currentViewers?: number;
	totalViewers?: number;
};

/** B 站的开播 / 下播帧。 */
const LIVE = { cmd: "LIVE" };
const PREPARING = { cmd: "PREPARING" };

/** 这一场的开播时刻(北京时间):世界开始前 1 分 30 秒。 */
const LIVE_TIME = "2026-03-01 11:58:30";
const LIVE_TIME_ISO = "2026-03-01T03:58:30.000Z";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 文案与直播间链接是同一段文字,中间一个换行(版式默认的分隔符)。 */
const linked = (text: string): string => `${text}\nhttps://live.bilibili.com/5001`;
const START_TEXT = "测试主播 开播啦，当前粉丝数：1000";
/** 开播那一条:卡与「文案 + 链接」合成一条消息。 */
const START_MESSAGE = ["[图 直播卡#1]", linked(START_TEXT)];

const liveSessions = (w: World): LiveSessionChange[] =>
	w.events.flatMap(([name, payload]) =>
		name === "live-session-changed" ? [payload as LiveSessionChange] : [],
	);
const liveKinds = (w: World): LiveSessionChange["kind"][] =>
	liveSessions(w).map((change) => change.kind);
const liveBoundaries = (w: World): LiveSessionChange["kind"][] =>
	liveKinds(w).filter((kind) => kind === "start" || kind === "end");
const viewerChanges = (w: World): ViewerChange[] =>
	w.events.flatMap(([name, payload]) =>
		name === "live-viewers-changed" ? [payload as ViewerChange] : [],
	);

let world: World | undefined;

beforeEach(() => {
	vi.useFakeTimers({ now: new Date(BILI_LIVE_EPOCH) });
});
afterEach(async () => {
	await world?.close();
	world = undefined;
	vi.useRealTimers();
});

/** 建世界;交回的同时记下来,收尾时关掉。 */
async function boot(opts: Parameters<typeof bootBiliLiveWorld>[0]): Promise<World> {
	world = await bootBiliLiveWorld(opts);
	return world;
}

/** B 站那头开播,并发来开播帧。 */
async function startLive(w: World, liveTime = LIVE_TIME): Promise<void> {
	w.goLive(liveTime);
	await w.frame(LIVE);
}

/** B 站那头下播,并发来下播帧。 */
async function endLive(w: World): Promise<void> {
	w.goOffline();
	await w.frame(PREPARING);
}

// 验红:B 站开播翻译不带 `startedAt` → live 事件丢掉 B 站开播时刻;开播冷却删掉 → 重复帧多推一张卡。
describe("开播", () => {
	it("收到开播帧:先 @全体,再推一条「卡 + 文案 + 链接」;总线上一条 live 事件,带 B 站的开播时刻", async () => {
		const w = await boot({ features: ["liveStart"], extras: ["atAllLiveStart"] });
		expect(w.connections()).toEqual({ opened: 1, open: 1 });
		expect(w.liveNow()).toEqual([]);

		await startLive(w);

		expect(w.sent).toEqual([["[@全体]"], START_MESSAGE]);
		expect(liveKinds(w)).toEqual(["start"]);
		expect(liveSessions(w)[0]).toMatchObject({
			subscriptionId: BILI_LIVE_SUBSCRIPTION_ID,
			trigger: "start-signal",
			session: { startedAt: LIVE_TIME_ISO },
		});
		expect(viewerChanges(w)).toEqual([
			{ subscriptionId: BILI_LIVE_SUBSCRIPTION_ID, currentViewers: 321 },
		]);
		expect(w.liveNow()).toEqual([BILI_LIVE_SUBSCRIPTION_ID]);
		expect(w.problems()).toEqual([]);
	});

	it("交给出图器的是开播卡:状态 start、房间封面(已抓进图库)、此刻在线与粉丝数,没有观看与点赞", async () => {
		const w = await boot({ features: ["liveStart"] });
		await startLive(w);

		expect(w.cards).toEqual([
			{
				kind: "直播卡",
				input: {
					status: "start",
					creator: { name: "测试主播" },
					title: "今天也来播一会儿",
					category: "聊天",
					description: "房间简介",
					cover: {
						url: "https://i0.hdslb.com/bfs/live/room-cover.jpg",
						ref: `${"a".repeat(64)}.webp`,
					},
					startedAt: LIVE_TIME_ISO,
					currentViewers: 321,
					followers: 1000,
				},
				options: { cardSkin: "default", cardSkinKnobs: undefined },
			},
		]);
		expect(w.fetchedImages).toEqual([
			"https://i0.hdslb.com/bfs/live/room-cover.jpg@1280w_80q_1s.webp",
		]);
	});

	it("@全体 的附加项关着:只推那一条,不 @", async () => {
		const w = await boot({ features: ["liveStart"] });
		await startLive(w);
		expect(w.sent).toEqual([START_MESSAGE]);
	});

	it("没有出图器:只有文案与链接", async () => {
		const w = await boot({ features: ["liveStart"], renderer: false });
		await startLive(w);
		expect(w.sent).toEqual([linked(START_TEXT)]);
		expect(w.cards).toEqual([]);
	});

	it("开播关着、别的直播开关开着:照样监听、照样发 live 事件,但不出卡也不推", async () => {
		const w = await boot({ features: ["liveEnd"] });
		await startLive(w);
		expect(w.sent).toEqual([]);
		expect(liveKinds(w)).toEqual(["start"]);
		expect(w.cards).toEqual([]);
	});

	it("十秒内重复的开播帧只算一次", async () => {
		const w = await boot({ features: ["liveStart"] });
		await startLive(w);
		await w.advance(3_000);
		await w.frame(LIVE);
		expect(w.sent).toEqual([START_MESSAGE]);
		expect(liveKinds(w)).toEqual(["start"]);
	});
});

// 验红(核心 `live/live-sessions.ts` 与 `live-push.ts`):
// - `handleLiveEnd` 里 `followerChange: this.masterInfo.liveFollowerChange` 改成 `0` → 前两条红(文案的粉丝变化);
// - `this.liveData.fansChanged = …` 改成 `= 0` → 第二条红(卡的 `followersDelta`);
// - `useLiveRoomInfo` 里去掉「保留 live_time」(直接 `this.liveRoomInfo = data`)→ 前两条与总结那条红(时长成了「0秒」、卡没了开播时刻);
// - `handleLiveEnd` 里第二处 `this.setLiveStatus(false, endedAt)` 删掉 → 断言 idle 的两条红;
// - `if (this.ctx.isSubscribed(this.sub, "liveEnd"))` 改成恒真 → 「下播关着」那条红(下播卡出了一遍;推送层照样扔,所以推出去的没变)。
describe("下播", () => {
	it("收到下播帧:推一条「卡 + 文案 + 链接」,文案带本场时长与粉丝变化;不 @全体;总线上一条 idle 事件", async () => {
		const w = await boot({
			features: ["liveStart", "liveEnd"],
			extras: ["atAllLiveStart"],
		});
		await startLive(w);
		await w.advance(HOUR);
		w.setFans(1025);
		await endLive(w);

		expect(w.sent).toEqual([
			["[@全体]"],
			START_MESSAGE,
			["[图 直播卡#2]", linked("测试主播 下播啦，本次直播了 1小时1分30秒，粉丝变化 +25")],
		]);
		expect(liveBoundaries(w)).toEqual(["start", "end"]);
		expect(liveSessions(w).find((change) => change.kind === "end")).toMatchObject({
			subscriptionId: BILI_LIVE_SUBSCRIPTION_ID,
			reason: "signal",
			endedAt: "2026-03-01T05:00:00.000Z",
			session: { startedAt: LIVE_TIME_ISO },
		});
		expect(w.liveNow()).toEqual([]);
	});

	it("交给出图器的是下播卡:状态 end、开播时刻还是这一场的、带粉丝数变化", async () => {
		const w = await boot({ features: ["liveEnd"] });
		await startLive(w);
		await w.frame({ cmd: "WATCHED_CHANGE", data: { num: 4321 } });
		await w.frame({ cmd: "LIKE_INFO_V3_UPDATE", data: { click_count: 99 } });
		await w.advance(HOUR);
		w.setFans(990);
		await endLive(w);

		expect(w.cards).toEqual([
			{
				kind: "直播卡",
				input: {
					status: "end",
					creator: { name: "测试主播" },
					title: "今天也来播一会儿",
					category: "聊天",
					description: "房间简介",
					cover: {
						url: "https://i0.hdslb.com/bfs/live/keyframe.jpg",
						ref: `${"a".repeat(64)}.webp`,
					},
					startedAt: LIVE_TIME_ISO,
					currentViewers: 321,
					totalViewers: 4321,
					followersDelta: -10,
				},
				options: { cardSkin: "default", cardSkinKnobs: undefined },
			},
		]);
		expect(w.sent).toEqual([
			["[图 直播卡#1]", linked("测试主播 下播啦，本次直播了 1小时1分30秒，粉丝变化 -10")],
		]);
	});

	it("下播关着:不推,idle 事件照发", async () => {
		const w = await boot({ features: ["liveStart"] });
		await startLive(w);
		await w.advance(HOUR);
		await endLive(w);
		expect(w.sent).toEqual([START_MESSAGE]);
		expect(liveBoundaries(w)).toEqual(["start", "end"]);
		// 下播这一道引擎自己也看开关:下播卡没有出(开播那一道不看,见上面那一组)
		expect(w.cards.map((card) => (card.input as { status: string }).status)).toEqual(["start"]);
	});

	// 验红:`live/recap/recap-anchors.ts` 里把 `if (extras.liveSummary) {` 改成 `if (false) {` → 这条红。
	it("直播总结开着、没接 AI:下播那条之后再跟一条按模板写的总结(够 5 位发言人才有)", async () => {
		const w = await boot({ features: ["liveEnd"], extras: ["liveSummary"], renderer: false });
		await startLive(w);
		for (const [uid, name] of [
			[1, "观众一"],
			[2, "观众二"],
			[3, "观众三"],
			[4, "观众四"],
			[5, "观众五"],
			[1, "观众一"],
		] as const) {
			await w.frame({
				cmd: "DANMU_MSG",
				info: [[0, 1, 25], "今天的直播真好看", [uid, name, 0], []],
			});
		}
		await w.advance(HOUR);
		await endLive(w);

		expect(w.sent).toEqual([
			linked("测试主播 下播啦，本次直播了 1小时1分30秒，粉丝变化 0"),
			"共 5 位测试牌发了 6 条弹幕，第一名 观众一（2 条）",
		]);
	});
});

/** 下播之前弹幕里有 5 位发言人(观众一发了两条);下播的总结才发得出来。 */
async function chatThenEnd(w: World): Promise<void> {
	await startLive(w);
	for (const [uid, name] of [
		[1, "观众一"],
		[2, "观众二"],
		[3, "观众三"],
		[4, "观众四"],
		[5, "观众五"],
		[1, "观众一"],
	] as const) {
		await w.frame({
			cmd: "DANMU_MSG",
			info: [[0, 1, 25], "今天的直播真好看", [uid, name, 0], []],
		});
	}
	await w.advance(HOUR);
	await endLive(w);
}

const TEMPLATE_SUMMARY = "共 5 位测试牌发了 6 条弹幕，第一名 观众一（2 条）";
/** 各目标收到的总结(下播卡那条除外)。 */
const summariesBy = (w: World, targetId: string): Array<string | string[]> =>
	w.sentTo
		.filter((s) => s.targetId === targetId && !String(s.payload).includes("下播啦"))
		.map((s) => s.payload);

// 验红:
// - `live/recap/recap-anchors.ts` 里总结锚点不带 `aiMessages`(只交模板)→ 「默认设置两边都收 AI」那条红;
// - `live/recap/live-summary-requester.ts` 里退回「AI 成功就不渲染模板」(交 AI 那串当 messages)→ 「乙写了关」那条红
//   (乙收到 AI 那句);
// - `runtime/engines.ts` 的 `toPushAnchors` 里删掉 `aiMessages` 那一支 → 「默认设置两边都收 AI」红。
describe("直播总结按目标挑 AI 版或模板(ADR-0032)", () => {
	it("默认开、乙写了关:甲收 AI 写的总结,乙收模板那句;AI 只问了一次", async () => {
		const comment = vi.fn(async (_prompt: string) => "AI 写的总结");
		const w = await boot({
			features: ["liveEnd"],
			extras: ["liveSummary"],
			renderer: false,
			secondTarget: true,
			commentary: comment,
		});
		w.globals.ai.writing.liveSummary = {
			isOnByDefault: true,
			byTarget: { [BILI_LIVE_SECOND_TARGET_ID]: false },
		};
		await chatThenEnd(w);
		expect(summariesBy(w, BILI_LIVE_TARGET_ID)).toEqual(["AI 写的总结"]);
		expect(summariesBy(w, BILI_LIVE_SECOND_TARGET_ID)).toEqual([TEMPLATE_SUMMARY]);
		expect(comment).toHaveBeenCalledTimes(1);
	});

	it("默认设置:两边都收 AI 那句(与没有这张表时一样)", async () => {
		const w = await boot({
			features: ["liveEnd"],
			extras: ["liveSummary"],
			renderer: false,
			secondTarget: true,
			commentary: async () => "AI 写的总结",
		});
		await chatThenEnd(w);
		expect(summariesBy(w, BILI_LIVE_TARGET_ID)).toEqual(["AI 写的总结"]);
		expect(summariesBy(w, BILI_LIVE_SECOND_TARGET_ID)).toEqual(["AI 写的总结"]);
	});

	it("AI 抛错:两边都收模板那句", async () => {
		const w = await boot({
			features: ["liveEnd"],
			extras: ["liveSummary"],
			renderer: false,
			secondTarget: true,
			commentary: async () => {
				throw new Error("服务商挂了");
			},
		});
		await chatThenEnd(w);
		expect(summariesBy(w, BILI_LIVE_TARGET_ID)).toEqual([TEMPLATE_SUMMARY]);
		expect(summariesBy(w, BILI_LIVE_SECOND_TARGET_ID)).toEqual([TEMPLATE_SUMMARY]);
	});

	it("AI 回空串:两边都收模板那句", async () => {
		const w = await boot({
			features: ["liveEnd"],
			extras: ["liveSummary"],
			renderer: false,
			secondTarget: true,
			commentary: async () => "",
		});
		await chatThenEnd(w);
		expect(summariesBy(w, BILI_LIVE_TARGET_ID)).toEqual([TEMPLATE_SUMMARY]);
		expect(summariesBy(w, BILI_LIVE_SECOND_TARGET_ID)).toEqual([TEMPLATE_SUMMARY]);
	});
});

// 验红:`runtime/engines.ts` 里直播引擎的 `isAiEnabled` 读口
// - 接成常量 true / 只看 `g.ai.enabled` → 「默认关」「悬空例外」「读口现取」「目标删了」几条红;
// - `aiWritingNeeded` 的第二参改成 `Object.keys(byTarget)`(不核现存)→ 「悬空例外」红;
// - 在构造时算一次缓存起来 → 「读口现取」「目标删了」红。
describe("直播总结的 AI 那份要不要做(生成门看「写正文」设置,ADR-0032)", () => {
	const GONE = "target-long-gone";
	async function bootAi(comment: (prompt: string) => Promise<string>): Promise<World> {
		return boot({
			features: ["liveEnd"],
			extras: ["liveSummary"],
			renderer: false,
			secondTarget: true,
			commentary: comment,
		});
	}

	it("默认关、没有例外:不问 AI,两边收模板", async () => {
		const comment = vi.fn(async (_prompt: string) => "AI 写的总结");
		const w = await bootAi(comment);
		w.globals.ai.writing.liveSummary = { isOnByDefault: false, byTarget: {} };
		await chatThenEnd(w);
		expect(comment).not.toHaveBeenCalled();
		expect(summariesBy(w, BILI_LIVE_TARGET_ID)).toEqual([TEMPLATE_SUMMARY]);
		expect(summariesBy(w, BILI_LIVE_SECOND_TARGET_ID)).toEqual([TEMPLATE_SUMMARY]);
	});

	it("默认关、只有一条悬空的例外(目标表里没有这个 id)是开:不问 AI", async () => {
		const comment = vi.fn(async (_prompt: string) => "AI 写的总结");
		const w = await bootAi(comment);
		w.globals.ai.writing.liveSummary = { isOnByDefault: false, byTarget: { [GONE]: true } };
		await chatThenEnd(w);
		expect(comment).not.toHaveBeenCalled();
		expect(summariesBy(w, BILI_LIVE_TARGET_ID)).toEqual([TEMPLATE_SUMMARY]);
	});

	it("默认关、乙的例外开:问一次 AI,甲收模板、乙收 AI", async () => {
		const comment = vi.fn(async (_prompt: string) => "AI 写的总结");
		const w = await bootAi(comment);
		w.globals.ai.writing.liveSummary = {
			isOnByDefault: false,
			byTarget: { [BILI_LIVE_SECOND_TARGET_ID]: true },
		};
		await chatThenEnd(w);
		expect(comment).toHaveBeenCalledTimes(1);
		expect(summariesBy(w, BILI_LIVE_TARGET_ID)).toEqual([TEMPLATE_SUMMARY]);
		expect(summariesBy(w, BILI_LIVE_SECOND_TARGET_ID)).toEqual(["AI 写的总结"]);
	});

	it("AI 总开关关着、默认开:不问 AI", async () => {
		const comment = vi.fn(async (_prompt: string) => "AI 写的总结");
		const w = await bootAi(comment);
		w.globals.ai.enabled = false;
		await chatThenEnd(w);
		expect(comment).not.toHaveBeenCalled();
		expect(summariesBy(w, BILI_LIVE_TARGET_ID)).toEqual([TEMPLATE_SUMMARY]);
	});

	it("读口现取:世界建好之后把默认从开改关,下一场下播就不再问 AI", async () => {
		const comment = vi.fn(async (_prompt: string) => "AI 写的总结");
		const w = await bootAi(comment);
		await chatThenEnd(w);
		expect(comment).toHaveBeenCalledTimes(1);
		w.globals.ai.writing.liveSummary = { isOnByDefault: false, byTarget: {} };
		await chatThenEnd(w);
		expect(comment).toHaveBeenCalledTimes(1);
	});

	it("目标删了,它的例外立刻不算开着:下一场下播不问 AI", async () => {
		const comment = vi.fn(async (_prompt: string) => "AI 写的总结");
		const w = await bootAi(comment);
		w.globals.ai.writing.liveSummary = {
			isOnByDefault: false,
			byTarget: { [BILI_LIVE_SECOND_TARGET_ID]: true },
		};
		w.removeTarget(BILI_LIVE_SECOND_TARGET_ID);
		await chatThenEnd(w);
		expect(comment).not.toHaveBeenCalled();
	});
});

// 验红:
// - `room-session.ts` 的 `onLiveStart` 开头 `if (this.pendingEndTimer) {` 改成 `if (false) {` → 只有「接续之后再下播」那条红
//   (第一条**不红**:没有这一支,窗口里的开播帧被「已在播」去重挡掉,到期核对时 B 站说在播,对外的结果一样;
//   差别只在第一次等待撤没撤,所以要第二次下播才看得出);
// - 核心断流接续关掉 → 「开着」的四条红;
// - `handleLiveEnd` 里 `precomputedDiffTime ?? this.liveElapsed()` 改成只用 `this.liveElapsed()` → 断言时长的两条红(多出等待的 2 分钟);
// - `enterGrace` 里 `this.graceEndAt = new Date().toISOString()` 改成 `= undefined` → 那两条红(idle 的 `at` 没了);
// - `onGraceExpiry` 里 `if (reopened) {` 改成 `if (false) {` → 「到期核对时 B 站说在播」那条红。
describe("断流接续", () => {
	it("开着:下播后等待窗口里又开播 = 同一场,什么都不推、什么事件都不发,面板上一直在播", async () => {
		const w = await boot({ features: ["liveStart", "liveEnd"], liveEndGraceMinutes: 2 });
		await startLive(w);
		await w.advance(10 * MINUTE);
		await endLive(w);
		expect(w.liveNow()).toEqual([BILI_LIVE_SUBSCRIPTION_ID]);

		await w.advance(30_000);
		await startLive(w, "2026-03-01 12:10:30");
		// 等待窗口早该到期的时刻也过了:没有迟到的下播
		await w.advance(5 * MINUTE);

		expect(w.sent).toEqual([START_MESSAGE]);
		expect(liveBoundaries(w)).toEqual(["start"]);
		expect(w.liveNow()).toEqual([BILI_LIVE_SUBSCRIPTION_ID]);
	});

	it("开着:等到窗口到期也没重开 = 真下播;时长算到下播帧那一刻(不含等待),idle 事件带的也是那一刻", async () => {
		const w = await boot({ features: ["liveStart", "liveEnd"], liveEndGraceMinutes: 2 });
		await startLive(w);
		await w.advance(30 * MINUTE);
		await endLive(w);
		await w.advance(2 * MINUTE - 1_000);
		expect(w.sent).toEqual([START_MESSAGE]);
		expect(w.liveNow()).toEqual([BILI_LIVE_SUBSCRIPTION_ID]);

		await w.advance(1_000);

		expect(w.sent).toEqual([
			START_MESSAGE,
			["[图 直播卡#2]", linked("测试主播 下播啦，本次直播了 31分30秒，粉丝变化 0")],
		]);
		expect(liveBoundaries(w)).toEqual(["start", "end"]);
		expect(liveSessions(w).find((change) => change.kind === "end")).toMatchObject({
			reason: "grace-expired",
			endedAt: "2026-03-01T04:30:00.000Z",
		});
		expect(w.liveNow()).toEqual([]);
	});

	it("开着:接续之后再下播,等待从这一次重新算;时长与 idle 的时刻算到这一次下播帧", async () => {
		const w = await boot({ features: ["liveStart", "liveEnd"], liveEndGraceMinutes: 2 });
		await startLive(w);
		await w.advance(10 * MINUTE);
		await endLive(w); // 12:10:00,第一次等待到 12:12:00
		await w.advance(30_000);
		await startLive(w, "2026-03-01 12:10:30"); // 接续
		await w.advance(MINUTE);
		await endLive(w); // 12:11:30,第二次等待到 12:13:30
		await w.advance(MINUTE);
		// 第一次等待的到期时刻(12:12:00)已过:它在接续时就撤了
		expect(w.sent).toEqual([START_MESSAGE]);

		await w.advance(MINUTE);

		expect(w.sent).toEqual([
			START_MESSAGE,
			["[图 直播卡#2]", linked("测试主播 下播啦，本次直播了 13分，粉丝变化 0")],
		]);
		expect(liveBoundaries(w)).toEqual(["start", "end"]);
		expect(liveSessions(w).find((change) => change.kind === "end")).toMatchObject({
			reason: "grace-expired",
			endedAt: "2026-03-01T04:11:30.000Z",
		});
	});

	it("开着:窗口里没收到开播帧、但到期核对时 B 站说在播 = 接续,不推下播", async () => {
		const w = await boot({ features: ["liveStart", "liveEnd"], liveEndGraceMinutes: 2 });
		await startLive(w);
		await w.advance(30 * MINUTE);
		await endLive(w);
		// 开播帧漏了,房间接口却已经是在播
		w.goLive("2026-03-01 12:31:00");
		await w.advance(10 * MINUTE);

		expect(w.sent).toEqual([START_MESSAGE]);
		expect(liveBoundaries(w)).toEqual(["start"]);
		expect(w.liveNow()).toEqual([BILI_LIVE_SUBSCRIPTION_ID]);
	});

	it("关着:下播后十几秒又开播 = 两场;按「开播 → 下播 → 开播」的次序各推一条,事件是 live → idle → live", async () => {
		const w = await boot({ features: ["liveStart", "liveEnd"] });
		await startLive(w);
		await w.advance(30 * MINUTE);
		await endLive(w);
		await w.advance(15_000);
		await startLive(w, "2026-03-01 12:30:15");

		expect(w.sent).toEqual([
			START_MESSAGE,
			["[图 直播卡#2]", linked("测试主播 下播啦，本次直播了 31分30秒，粉丝变化 0")],
			["[图 直播卡#3]", linked(START_TEXT)],
		]);
		expect(liveBoundaries(w)).toEqual(["start", "end", "start"]);
		expect(
			liveSessions(w)
				.filter((change) => change.kind === "start" || change.kind === "end")
				.map((change) =>
					change.kind === "start"
						? [change.kind, change.session.startedAt]
						: [change.kind, change.endedAt],
				),
		).toEqual([
			["start", LIVE_TIME_ISO],
			["end", "2026-03-01T04:30:00.000Z"],
			["start", "2026-03-01T04:30:15.000Z"],
		]);
	});
});

// 验红(核心 `live/live-sessions.ts`):
// - `tickPushAtTime` 里 `if (live_status === 0 || live_status === 2) {` 改成 `if (false) {` → 前三条红(推出来的是「正在直播」而不是下播);
// - 只去掉 `|| live_status === 2` → 「轮播」那一条红;
// - `armPeriodicTimer` 里去掉 `!this.sub.liveStreaming ||` → 「周期推送关着」那条红(关着也兜上了)。
describe("漏收下播的兜底(核心按开播时刻周期核对)", () => {
	it.each([
		[0, "没播"],
		[2, "轮播"],
	] as const)(
		"周期推送开着:没收到下播帧,到点核对发现房间是 %i(%s)→ 当场走下播;时长算到核对那一刻,不推「正在直播」",
		async (status, _label) => {
			const w = await boot({
				features: ["liveStart", "liveStreaming", "liveEnd"],
				streamingIntervalHours: 1,
			});
			await startLive(w);
			await w.advance(30 * MINUTE);
			// 12:30 就下播了,下播帧没到
			w.bili.liveStatus = status;
			await w.advance(28 * MINUTE + 29_000);
			expect(w.sent).toEqual([START_MESSAGE]);
			expect(w.liveNow()).toEqual([BILI_LIVE_SUBSCRIPTION_ID]);

			await w.advance(1_000);

			expect(w.sent).toEqual([
				START_MESSAGE,
				["[图 直播卡#2]", linked("测试主播 下播啦，本次直播了 1小时，粉丝变化 0")],
			]);
			expect(liveBoundaries(w)).toEqual(["start", "end"]);
			expect(liveSessions(w).find((change) => change.kind === "end")).toMatchObject({
				reason: "poll",
				endedAt: "2026-03-01T04:58:30.000Z",
			});
			expect(w.liveNow()).toEqual([]);
		},
	);

	it("周期推送开着、断流接续也开着:兜底发现没播先进等待,到期才下播;时长与 idle 的时刻都是核对那一刻", async () => {
		const w = await boot({
			features: ["liveStart", "liveStreaming", "liveEnd"],
			streamingIntervalHours: 1,
			liveEndGraceMinutes: 2,
		});
		await startLive(w);
		await w.advance(30 * MINUTE);
		w.goOffline();
		await w.advance(30 * MINUTE);
		expect(w.sent).toEqual([START_MESSAGE]);

		await w.advance(2 * MINUTE);

		expect(w.sent).toEqual([
			START_MESSAGE,
			["[图 直播卡#2]", linked("测试主播 下播啦，本次直播了 1小时，粉丝变化 0")],
		]);
		expect(liveBoundaries(w)).toEqual(["start", "end"]);
		expect(liveSessions(w).find((change) => change.kind === "end")).toMatchObject({
			reason: "grace-expired",
			endedAt: "2026-03-01T04:58:30.000Z",
		});
	});

	it("周期关着:1 小时后核到已下播 → 下播", async () => {
		const w = await boot({ features: ["liveStart", "liveEnd"] });
		await startLive(w);
		await w.advance(30 * MINUTE);
		w.goOffline();
		await w.advance(24 * HOUR);

		expect(w.sent).toEqual([
			START_MESSAGE,
			["[图 直播卡#2]", linked("测试主播 下播啦，本次直播了 1小时，粉丝变化 0")],
		]);
		expect(liveBoundaries(w)).toEqual(["start", "end"]);
		expect(liveSessions(w).find((change) => change.kind === "end")).toMatchObject({
			reason: "poll",
			endedAt: "2026-03-01T04:58:30.000Z",
		});
		expect(w.liveNow()).toEqual([]);
		expect(w.problems()).toEqual([]);
	});
});

// 验红:
// - 核心周期计时忽略设置里的小时数 → 第一条红(一小时就推了);
// - `tickPushAtTime` 里 `const watched = this.liveData.watchedNum` 改成 `= undefined` → 第一条红(印成「暂未获取到」);
// - `room-session.ts` 里 `this.ctx.emitViewers(…)` 删掉 → 第一条红(没有观看人数事件);
// - `room-helpers.ts` 的 `livePushTypeOf` 最后一行改成回 `LivePushType.StartBroadcasting` → 「不 @」那条与只开周期推送的两条红
//   (周期那一条成了开播:走开播的开关、带 @全体)。
//
// 核心按每一场的开播时刻(11:58:30)起算。
describe("周期「正在直播」", () => {
	it("每隔设定的小时数推一条:文案带已播时长与累计观看;卡是 streaming、用关键帧、带累计观看", async () => {
		const w = await boot({
			features: ["liveStart", "liveStreaming"],
			streamingIntervalHours: 2,
		});
		await startLive(w);
		await w.frame({ cmd: "WATCHED_CHANGE", data: { num: 12345 } });
		await w.advance(HOUR);
		expect(w.sent).toEqual([START_MESSAGE]);

		await w.advance(HOUR);

		expect(w.sent).toEqual([
			START_MESSAGE,
			["[图 直播卡#2]", linked("测试主播 正在直播，已播 2小时，累计观看：1.2万")],
		]);
		expect(w.cards[1]).toEqual({
			kind: "直播卡",
			input: {
				status: "streaming",
				creator: { name: "测试主播" },
				title: "今天也来播一会儿",
				category: "聊天",
				description: "房间简介",
				cover: {
					url: "https://i0.hdslb.com/bfs/live/keyframe.jpg",
					ref: `${"a".repeat(64)}.webp`,
				},
				startedAt: LIVE_TIME_ISO,
				currentViewers: 321,
				totalViewers: 12345,
				followers: 1000,
			},
			options: { cardSkin: "default", cardSkinKnobs: undefined },
		});
		expect(viewerChanges(w)).toEqual([
			{ subscriptionId: BILI_LIVE_SUBSCRIPTION_ID, currentViewers: 321 },
			{ subscriptionId: BILI_LIVE_SUBSCRIPTION_ID, totalViewers: 12345 },
			// 周期核对问到的房间信息只有此刻在线;人数帧只带这一份带了的格(累计观看在在播表里、卡上照有)。
			{ subscriptionId: BILI_LIVE_SUBSCRIPTION_ID, currentViewers: 321 },
		]);

		await w.advance(2 * HOUR);
		expect(w.sent.at(-1)).toEqual([
			"[图 直播卡#3]",
			linked("测试主播 正在直播，已播 4小时，累计观看：1.2万"),
		]);
		expect(w.sent).toHaveLength(3);
	});

	it("一帧观看人数都没收到:文案里印「暂未获取到」", async () => {
		const w = await boot({ features: ["liveStreaming"], streamingIntervalHours: 1 });
		await startLive(w);
		await w.advance(HOUR);
		expect(w.sent).toEqual([
			["[图 直播卡#1]", linked("测试主播 正在直播，已播 1小时，累计观看：暂未获取到")],
		]);
	});

	it("开播的 @全体 开着:周期那一条也不 @", async () => {
		const w = await boot({
			features: ["liveStart", "liveStreaming"],
			extras: ["atAllLiveStart"],
			streamingIntervalHours: 1,
		});
		await startLive(w);
		await w.advance(HOUR);
		expect(w.sent.filter((message) => String(message).includes("@全体"))).toEqual([["[@全体]"]]);
		expect(w.sent).toHaveLength(3);
	});

	it("周期推送关着:到点不推", async () => {
		const w = await boot({ features: ["liveStart"], streamingIntervalHours: 1 });
		await startLive(w);
		await w.advance(5 * HOUR);
		expect(w.sent).toEqual([START_MESSAGE]);
	});
});

describe("周期取不到房间信息:跳过、记问题、连接不关，接口好了下一拍照推并清问题", () => {
	it.each([
		["throws", "接口抛错"],
		["empty", "回了个空壳"],
	] as const)(
		"%s(%s):这一轮不推并记「没取到直播状态」，监听不停；下一拍成功后照推并清掉",
		async (mode, _label) => {
			const w = await boot({
				features: ["liveStart", "liveStreaming", "liveEnd"],
				streamingIntervalHours: 1,
			});
			await startLive(w);
			w.bili.roomInfo = mode;
			await w.advance(HOUR);

			expect(w.problems()).toEqual([`${BILI_LIVE_UID}:live_status_unavailable`]);
			expect(w.connections()).toEqual({ opened: 1, open: 1 });
			expect(w.sent).toEqual([START_MESSAGE]);
			expect(liveBoundaries(w)).toEqual(["start"]);
			expect(w.liveNow()).toEqual([BILI_LIVE_SUBSCRIPTION_ID]);

			w.bili.roomInfo = "ok";
			await w.advance(59 * MINUTE);
			expect(w.sent).toEqual([
				START_MESSAGE,
				["[图 直播卡#2]", linked("测试主播 正在直播，已播 2小时，累计观看：暂未获取到")],
			]);
			expect(w.problems()).toEqual([]);
			expect(w.connections()).toEqual({ opened: 1, open: 1 });

			await endLive(w);
			expect(w.sent.at(-1)).toEqual([
				"[图 直播卡#3]",
				linked("测试主播 下播啦，本次直播了 2小时30秒，粉丝变化 0"),
			]);
			expect(w.connections()).toEqual({ opened: 1, open: 1 });
		},
	);
});

/** 一条醒目留言(30 元,挂 60 秒)。 */
const SUPERCHAT = {
	cmd: "SUPER_CHAT_MESSAGE",
	data: {
		id: 1,
		uid: 777,
		user_info: { uname: "观众甲", face: "https://i0.hdslb.com/bfs/face/viewer-sc.jpg" },
		message: "主播晚上好",
		price: 30,
		time: 60,
	},
};

// 验红(`room-session.ts` 的 `onIncomeSuperChat`):出卡入参的 `amount: event.amount` 改成 `amount: 0` → 第一条红;
// 文字兜底那句里的「的SC:」改一个字 → 第二条红;`if (!passesSuperchatMinAmount(…)) return;` 删掉 → 第三条红;
// `if (!pushesSC) return;` 删掉 → 第四条红(卡出了一遍;推送层照样扔)。
describe("醒目留言", () => {
	it("有出图器:推一张卡;卡的输入是观众(头像已抓进图库)、主播、正文、金额、币种、档位", async () => {
		const w = await boot({ features: ["superchat"] });
		await w.frame(SUPERCHAT);

		expect(w.cards).toEqual([
			{
				kind: "醒目留言卡",
				input: {
					viewer: { name: "观众甲", avatar: `${"a".repeat(64)}.webp` },
					creator: { name: "测试主播" },
					text: "主播晚上好",
					amount: 30,
					currency: "CNY",
					tier: { rank: 1, durationSec: 60 },
				},
				options: { cardSkin: "default", cardSkinKnobs: undefined },
			},
		]);
		expect(w.sent).toEqual(["[图 醒目留言卡#1]"]);
		expect(w.fetchedImages).toEqual([
			"https://i0.hdslb.com/bfs/face/viewer-sc.jpg@480w_80q_1s.webp",
		]);
	});

	it("没有出图器:退成一句文字", async () => {
		const w = await boot({ features: ["superchat"], renderer: false });
		await w.frame(SUPERCHAT);
		expect(w.sent).toEqual(["【测试主播的直播间】观众甲的SC:主播晚上好（30元）"]);
	});

	it("金额低于门槛:不推", async () => {
		const w = await boot({ features: ["superchat"], minSuperchatAmount: 50 });
		await w.frame(SUPERCHAT);
		expect(w.sent).toEqual([]);
		expect(w.cards).toEqual([]);
	});

	// 下播与直播总结开着:醒目留言的正文要进弹幕收集,所以会走到「推不推」那一道
	it("醒目留言关着(弹幕在收集):不推,卡也不出", async () => {
		const w = await boot({ features: ["liveEnd"], extras: ["liveSummary"] });
		await w.frame(SUPERCHAT);
		expect(w.sent).toEqual([]);
		expect(w.cards).toEqual([]);
	});
});

/** 一条上舰(舰长,一个月)。 */
const GUARD_BUY = {
	cmd: "GUARD_BUY",
	data: {
		uid: 888,
		username: "观众乙",
		guard_level: 3,
		num: 1,
		price: 198000,
		gift_id: 10003,
		gift_name: "舰长",
		start_time: 1772337600,
		end_time: 1772337600,
	},
};

// 验红(`room-session.ts` 的 `onGuardBuy`):出卡入参的 `name: tier.name` 改成 `name: ""` → 第一条红;
// 文字兜底那句里的「加入了大航海」改一个字 → 第二条红;自定义文案那一支的 `viewer: event.viewer.name` 改成 `viewer: ""` → 第三条红;
// 开头的 `if (!this.ctx.isSubscribed(this.sub, "membership")) return;` 删掉 → 「会员关着」那条红(卡出了一遍);
// `if (event === undefined || tier === undefined) {` 改成 `if (false) {` → **没有哪条用例的断言红**,但这一轮以「未处理的异常」失败
// (后面读 `event.tier` 抛 TypeError,没人接):「认不出的档位」那条钉住的只是「不推」,「静默丢弃而不是抛」靠的是测试框架的兜底。
describe("会员(上舰)", () => {
	it("有出图器:推一张卡;卡的输入是观众(头像向 B 站查到后抓进图库)、主播、档位(名字、rank、档色、宣告语)", async () => {
		const w = await boot({ features: ["membership"] });
		await w.frame(GUARD_BUY);

		expect(w.cards).toEqual([
			{
				kind: "上舰卡",
				input: {
					viewer: { name: "观众乙", avatar: `${"a".repeat(64)}.webp` },
					creator: { name: "测试主播" },
					tier: {
						name: "舰长",
						rank: 1,
						icon: { ref: BILI_LIVE_GUARD_BADGE_REF },
						color: "#4ebcec",
						colorEnd: "#b494e5",
						announcement: '"{viewer}号"加入\n"{name}"大航海舰队！',
					},
				},
				options: { cardSkin: "default", cardSkinKnobs: undefined },
			},
		]);
		expect(w.sent).toEqual(["[图 上舰卡#1]"]);
		expect(w.fetchedImages).toEqual(["https://i0.hdslb.com/bfs/face/viewer.jpg@480w_80q_1s.webp"]);
	});

	it("没有出图器:退成「官方徽章图 + 一句文字」", async () => {
		const w = await boot({ features: ["membership"], renderer: false });
		await w.frame(GUARD_BUY);
		// 徽章是以图发出去的(图库里的字节),不是一串网址。
		expect(w.sent).toEqual([["[图 徽章]", "【测试主播的直播间】观众乙加入了大航海（舰长）"]]);
	});

	it("自定义文案开着:不出卡,推「徽章图 + 套好的文案」", async () => {
		const w = await boot({ features: ["membership"], guardTemplate: true });
		await w.frame(GUARD_BUY);
		expect(w.sent).toEqual([["[图 徽章]", "观众乙 成为了 测试主播 的舰长！"]]);
		expect(w.cards).toEqual([]);
	});

	it("认不出的档位:丢弃,不推", async () => {
		const w = await boot({ features: ["membership"] });
		await w.frame({ ...GUARD_BUY, data: { ...GUARD_BUY.data, guard_level: 9 } });
		expect(w.sent).toEqual([]);
		expect(w.events).toEqual([]);
	});

	it("会员关着:不推,卡也不出", async () => {
		const w = await boot({ features: ["liveStart"] });
		await w.frame(GUARD_BUY);
		expect(w.sent).toEqual([]);
		expect(w.cards).toEqual([]);
	});
});

/** 一条弹幕:正文、发送者 uid 与名字。 */
const danmaku = (uid: number, name: string, content: string) => ({
	cmd: "DANMU_MSG",
	info: [[0, 1, 25], content, [uid, name, 0], []],
});

// 验红(`room-session.ts` 的 `onIncomeDanmaku`):`content: body.content` 改成 `content: ""` → 第一条红;
// 名单判断的 `v.id === viewer.id && v.features.includes(…)` 改成 `true` → 「名单外」那条红。
describe("特别关注的弹幕", () => {
	it("名单里的人发弹幕:推一句文字(主播名、观众名、正文)", async () => {
		const w = await boot({
			features: ["viewerChat"],
			specialViewers: [{ id: "777", features: ["viewerChat"] }],
		});
		await w.frame(danmaku(777, "观众甲", "来了来了"));
		expect(w.sent).toEqual(["测试主播 的关注用户 观众甲 发送弹幕：来了来了"]);
	});

	// 要不要监听是「开关 ∧ 名单上有人带它」(3b-16):名单里有人、特别开关关着、别的直播开关也关着 → 不连直播间、不推。
	// 验红(`room-context.ts` 的 `needsListener`):特别开关那一格写死 `true` → 这两条红。
	it("名单里有人、特性开关关着、别的直播开关也关着:不监听,不推", async () => {
		const w = await boot({ specialViewers: [{ id: "777", features: ["viewerChat"] }] });
		expect(w.connections()).toEqual({ opened: 0, open: 0 });
		expect(w.sent).toEqual([]);
	});

	it("viewerChat 开着、名单上的人只带 viewerEnter、别的直播开关全关:不监听", async () => {
		const w = await boot({
			features: ["viewerChat"],
			specialViewers: [{ id: "777", features: ["viewerEnter"] }],
		});
		expect(w.connections()).toEqual({ opened: 0, open: 0 });
		expect(w.sent).toEqual([]);
	});

	// 新判据看开关,所以开关变了监听要跟着变:全局默认改 → `config-changed` 给所有订阅重发 update op;订阅自己改 →
	// `subscription-changed`。两条路共用 update op,里面带着 `viewerChat` / `viewerEnter` 两格开关。
	// 验红(`engines.ts` 的 update op):去掉 `viewerChat: view.viewerChat` 那一格 → 开关翻了监听不动,这两条红。
	it("全局默认把 viewerChat 从关改开:名单上有人带它的订阅补开监听;改回关则拆掉", async () => {
		const w = await boot({ specialViewers: [{ id: "777", features: ["viewerChat"] }] });
		expect(w.connections()).toEqual({ opened: 0, open: 0 });
		await w.setGlobalFeature("viewerChat", true);
		expect(w.connections()).toEqual({ opened: 1, open: 1 });
		await w.setGlobalFeature("viewerChat", false);
		expect(w.connections()).toEqual({ opened: 1, open: 0 });
	});

	it("订阅自己把 viewerChat 从关改开:同样补开监听;改回关则拆掉", async () => {
		const w = await boot({ specialViewers: [{ id: "777", features: ["viewerChat"] }] });
		expect(w.connections()).toEqual({ opened: 0, open: 0 });
		await w.setSubscriptionFeature("viewerChat", true);
		expect(w.connections()).toEqual({ opened: 1, open: 1 });
		await w.setSubscriptionFeature("viewerChat", false);
		expect(w.connections()).toEqual({ opened: 1, open: 0 });
	});

	it("全局开了 viewerEnter、名单上的人只带 viewerChat:仍不监听", async () => {
		const w = await boot({ specialViewers: [{ id: "777", features: ["viewerChat"] }] });
		await w.setGlobalFeature("viewerEnter", true);
		expect(w.connections()).toEqual({ opened: 0, open: 0 });
	});

	it("viewerChat 开着、名单上有人带它、别的直播开关全关:监听", async () => {
		const w = await boot({
			features: ["viewerChat"],
			specialViewers: [{ id: "777", features: ["viewerChat"] }],
		});
		expect(w.connections()).toEqual({ opened: 1, open: 1 });
	});

	it("名单外的人发弹幕、名单里的人只关注进场:不推", async () => {
		const w = await boot({
			features: ["viewerChat", "viewerEnter"],
			specialViewers: [
				{ id: "777", features: ["viewerChat"] },
				{ id: "666", features: ["viewerEnter"] },
			],
		});
		await w.frame(danmaku(555, "路人", "路过"));
		await w.frame(danmaku(666, "观众丙", "我只该在进场时被报"));
		expect(w.sent).toEqual([]);
	});
});

// 录制的真帧(protobuf):进场的人 uid 33088372、名字「_无言I」。
// 验红(`room-session.ts` 的 `onUserAction`):`uname: ev.user.name` 改成 `uname: ""` → 第一条红;
// 名单判断那一行(`if (!listed(settings.specialViewers, viewer.id, "viewerEnter")) return;`)删掉 → 第二条红。
describe("特别关注的用户进场", () => {
	it("名单里的人进场:推一句文字(观众名、主播名)", async () => {
		const w = await boot({
			features: ["viewerEnter"],
			specialViewers: [{ id: "33088372", features: ["viewerEnter"] }],
		});
		await w.frame(payloads.interactV2);
		expect(w.sent).toEqual(["_无言I 进入了 测试主播 的直播间"]);
	});

	it("名单外的人进场、名单里的人只关注弹幕:不推", async () => {
		const w = await boot({
			features: ["viewerChat", "viewerEnter"],
			specialViewers: [
				{ id: "33088372", features: ["viewerChat"] },
				{ id: "666", features: ["viewerEnter"] },
			],
		});
		await w.frame(payloads.interactV2);
		expect(w.sent).toEqual([]);
	});
});
