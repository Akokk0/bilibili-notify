/**
 * **直播这一侧的验收,走装配层**:真问题表、真问题通知器、真上报器、真 B 站来源与登记、真动态引擎,
 * 直播那头用真 `RoomContext` + 真 `RoomSession`(假件只有 Api、登录口、`notifyMaster`)。
 *
 * 定案的两条验收里属于直播的部分:
 * - 失效登录开机:表里恰好一条(`auth_lost`),私聊恰好一次。源码读不出失效登录时直播走哪一支
 *   (B 站对它回非 0 的业务码 → 受限房那一支;回 0 但「获取个人信息」回 -101 → 建连没建起来那一支),所以两支各跑一遍;
 * - 已登录被风控:表里恰好一条(风控),私聊恰好一次;风控好了,压在底下的「停止监听」要冒出来、主人要收到。
 *
 * 每条都先做**对照**:同一套假件在「没有根问题」时,下层的问题确实会进表 —— 才证明「只有一条」不是因为什么都没接上。
 */

import {
	type AuthState,
	type DeliveryResult,
	fail,
	ok,
	type ServiceContext,
	type SourceAuth,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createProblemNotifier } from "../../problems/problem-notifier.js";
import { createProblemTable } from "../../problems/problem-table.js";
import {
	makeIntegration,
	makeLogger,
	makeSub,
	makeWorld,
	SOURCE_KEY,
} from "../../subscriptions/__tests__/fixtures.js";
import { registerBuiltinSource } from "../../subscriptions/builtin-sources.js";
import { createSourceRegistry } from "../../subscriptions/registry.js";
import { type Api, RiskControlError } from "../api/index.js";
import type { SubItemView } from "../live/push-like.js";
import type { RoomContextOptions } from "../live/session/room-context.js";
import { RoomContext } from "../live/session/room-helpers.js";
import { RoomSession } from "../live/session/room-session.js";
import { createProblemLayers } from "../problem-layers.js";
import { PROBLEM_TEXTS } from "../problem-texts.js";
import { BiliSettingsSchema } from "../settings.js";
import { createBiliSource } from "../source.js";

const IN: AuthState = { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" };
const EXPIRED: AuthState = { status: "expired", message: "失效" };

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

/** 登录口(状态由测试拨)。 */
function makeAuth(initial: AuthState) {
	let state = initial;
	const listeners = new Set<() => void>();
	const auth: SourceAuth = {
		beginLogin: async () => ok(),
		logout: async () => ok(),
		state: () => state,
		onChange: (fn) => {
			listeners.add(fn);
			return { dispose: () => void listeners.delete(fn) };
		},
	};
	return {
		auth,
		set(next: AuthState) {
			state = next;
			for (const fn of [...listeners]) fn();
		},
	};
}

/** 直播间那一侧的假 Api:每个用例换自己要的预检 / 房间信息 / 个人信息体。 */
interface LiveApiBehavior {
	streamKey?: () => Promise<unknown>;
	myself?: () => Promise<unknown>;
	roomInfo?: () => Promise<unknown>;
	/** 主播信息(不给就没有这个口:取主播信息会抛,房间进不了「监听上了」)。 */
	master?: () => Promise<unknown>;
}

/** 一个已下播的直播间 / 一份主播信息:够 `bootstrap` 一路走到「监听上了」。 */
const ROOM_OFFLINE = { uid: 1, live_status: 0, live_time: "2026-01-01 10:00:00" };
const MASTER = {
	data: { follower_num: 1, info: { uname: "U", face: "" }, room_id: "100", medal_name: "" },
};

const GOOD_STREAM_KEY = {
	code: 0,
	data: { token: "tok", host_list: [{ host: "h1.example.com", wss_port: 443 }] },
};

async function boot(initial: AuthState, over: { fetchAllDynamic?: () => Promise<unknown> } = {}) {
	// 两位 UP:房间 100 / 200;订阅级的问题要有订阅可挂
	const world = makeWorld([makeSub("sub-u1", "u1"), makeSub("sub-u2", "u2")]);
	const logger = makeLogger();
	const authed = makeAuth(initial);
	const table = createProblemTable({ logger });
	const notifyMaster = vi.fn<(text: string) => Promise<DeliveryResult>>(async () =>
		ok({ latencyMs: 1 }),
	);
	createProblemNotifier({
		table,
		notify: notifyMaster,
		serviceCtx: {
			track: () => {},
			setTimeout: (fn, ms) => {
				const timer = setTimeout(fn, ms);
				return { dispose: () => clearTimeout(timer) };
			},
		},
		logger,
	});
	const layers = createProblemLayers({ auth: authed.auth, logger });
	const engineErrors: unknown[] = [];
	world.bus.on("engine-error", (e) => engineErrors.push(e));
	const source = createBiliSource({
		api: {
			fetchAllDynamic:
				over.fetchAllDynamic ?? (async () => ({ code: 0, message: "ok", data: { items: [] } })),
		} as unknown as Api,
		bus: world.bus,
		imageFetcher: { fetchImage: async () => fail("unavailable", "不联网") } as never,
		configStore: {
			getIntegrationSettings: () => BiliSettingsSchema.parse({}),
			onChange: () => ({ dispose() {} }),
		} as never,
		setTimeout: () => ({ dispose() {} }),
		auth: authed.auth,
		problems: layers,
	});
	await registerBuiltinSource({
		registry: createSourceRegistry(),
		source,
		integration: makeIntegration(),
		sourceKey: SOURCE_KEY,
		subscriptions: world.store,
		defaults: () => world.globals.defaults,
		bus: world.bus,
		logger,
		enqueue: () => {},
		problems: table,
	});
	return { table, notifyMaster, layers, source, engineErrors, ...authed };
}

type Booted = Awaited<ReturnType<typeof boot>>;

/** 直播间那头:真 RoomContext(上报器就是上面那个)+ 一个 UP 的真 RoomSession。 */
function makeLiveSession(
	booted: Booted,
	uid: string,
	roomId: string,
	api: LiveApiBehavior,
): RoomSession {
	const serviceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
		signal: new AbortController().signal,
		track: () => {},
	};
	const ctx = new RoomContext({
		serviceCtx,
		api: {
			fetchLiveRoomInfoStreamKey: vi.fn(api.streamKey ?? (async () => GOOD_STREAM_KEY)),
			getMyselfInfoCached: vi.fn(api.myself ?? (async () => ({ code: 0, data: { mid: 1 } }))),
			getBuvid3: vi.fn(async () => "buv"),
			openDanmakuSocket: vi.fn(() => ({ binaryType: "", on() {}, send() {}, close() {} })),
			...(api.master ? { getMasterInfo: vi.fn(api.master) } : {}),
			fetchLiveRoomInfo: vi.fn(
				api.roomInfo ??
					(async () => {
						throw new Error("取房间信息炸了");
					}),
			),
		},
		push: { push: async () => {} },
		problems: booted.layers,
		contentBuilder: {},
		templateRenderer: {},
		wordcloudGenerator: {},
		liveSummaryRequester: {},
		danmakuCollector: { registerRoom() {}, clear() {}, clearAll() {} },
		getImageRenderer: () => null,
		config: {},
		emitEngineError: (message: string) =>
			booted.engineErrors.push({ source: "live-engine", message }),
		emitLiveState: vi.fn(),
	} as unknown as RoomContextOptions);
	const sub = {
		subscriptionId: `sub-${uid}`,
		uid,
		uname: uid,
		roomId,
		liveStart: true,
		liveEnd: false,
		liveStreaming: false,
	} as unknown as SubItemView;
	return new RoomSession(ctx, sub);
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const codesOf = (b: Booted) =>
	b.table
		.list()
		.map((p) => `${p.about ? "sub:" : ""}${p.code}`)
		.sort();

describe("失效登录开机 · 直播这一侧", () => {
	it("对照:登录正常时,房间连不上会进表(订阅级「停止监听」)、私聊一条", async () => {
		const b = await boot(IN);
		await makeLiveSession(b, "u1", "100", {
			myself: async () => ({ code: -101 }),
		}).bootstrap();
		await flush();
		expect(codesOf(b)).toEqual(["sub:live_monitor_stopped"]);
		expect(b.notifyMaster).toHaveBeenCalledTimes(1);
	});

	// 验红:删掉上报器里「未登录开着时低层不存」的判断,这几条红;
	//       把 room-session-base.ts bootstrap 里 `this.ctx.reportMonitorStopped(…)` 删掉,上面那条对照红。
	it("第一支:预检回 0、取个人信息回 -101 → 弹幕连接没建起来:表里恰好一条 auth_lost,私聊恰好一次,没有 engine-error", async () => {
		const b = await boot(EXPIRED);
		await makeLiveSession(b, "u1", "100", { myself: async () => ({ code: -101 }) }).bootstrap();
		await makeLiveSession(b, "u2", "200", { myself: async () => ({ code: -101 }) }).bootstrap();
		await flush();

		expect(codesOf(b)).toEqual(["auth_lost"]);
		expect(b.notifyMaster).toHaveBeenCalledTimes(1);
		expect(b.notifyMaster).toHaveBeenCalledWith(PROBLEM_TEXTS.loginExpired.text);
		expect(b.engineErrors).toEqual([]);
	});

	it("第二支:预检回非 0 的业务码 → 受限房那一支:同样只有 auth_lost 一条、私聊一次", async () => {
		const b = await boot(EXPIRED);
		await makeLiveSession(b, "u1", "100", {
			streamKey: async () => ({ code: -101, message: "账号未登录" }),
		}).bootstrap();
		await flush();

		expect(codesOf(b)).toEqual(["auth_lost"]);
		expect(b.notifyMaster).toHaveBeenCalledTimes(1);
		expect(b.engineErrors).toEqual([]);
	});

	// 真装配里的次序:登录一好,`auth-restored` **先**发 → 直播整批重建(`startAll` 先把每个房间的
	// 停监静默清掉,压着的那份也在其内)→ 登录口才变成已登录。所以登录好了的那一刻表里是空的,主人只收到
	// 「登录已经恢复啦」,没有房间那条(登录恢复时每个房间都在重连,这时说「监听停了」是错话);
	// 新会话再失败了才重新报。「压着的冒出来」的单件逻辑在 `problem-layers.test.ts`(「第三层的 lasting」)。
	// 验红:去掉下面的静默清(`clearMonitorProblems`),房间那条会冒出来,这条红。
	it("登录好了(真次序:auth-restored → 重建时静默清 → 登录口变已登录):表里是空的,私聊只有「登录已经恢复啦」", async () => {
		const b = await boot(EXPIRED);
		const session = makeLiveSession(b, "u1", "100", { myself: async () => ({ code: -101 }) });
		await session.bootstrap();
		await flush();
		expect(codesOf(b)).toEqual(["auth_lost"]);

		// 直播整批重建(`startAll`)对每个房间做的静默清
		(session as unknown as { ctx: RoomContext }).ctx.clearMonitorProblems("u1");
		b.set(IN);
		await flush();

		expect(codesOf(b)).toEqual([]);
		expect(b.notifyMaster.mock.calls.map((c) => c[0])).toEqual([
			PROBLEM_TEXTS.loginExpired.text,
			PROBLEM_TEXTS.loginExpired.recovery,
		]);
	});
});

describe("已登录被风控 · 直播这一侧", () => {
	it("动态撞 -352、一个房间预检被拦、另一个房间取信息失败:表里恰好一条风控,私聊恰好一次", async () => {
		const b = await boot(IN, {
			fetchAllDynamic: async () => ({ code: -352, message: "risk" }),
		});
		// biome-ignore lint/suspicious/noExplicitAny: 白盒直调一轮检测,不起 cron
		await (b.source.dynamic() as any).detectDynamics();
		await makeLiveSession(b, "u1", "100", {
			streamKey: async () => {
				throw new RiskControlError("-352");
			},
		}).bootstrap();
		await makeLiveSession(b, "u2", "200", {
			roomInfo: async () => {
				throw new Error("取房间信息炸了");
			},
		}).bootstrap();
		await flush();

		expect(codesOf(b)).toEqual(["risk_controlled"]);
		expect(b.notifyMaster).toHaveBeenCalledTimes(1);
		expect(b.notifyMaster).toHaveBeenCalledWith(PROBLEM_TEXTS.riskControlled.text);
		expect(b.engineErrors).toEqual([]);
	});

	/** 两路都被风控拦着的世界:动态撞 -352、u1 的预检被拦;u2 的房间取信息失败(风控压着,这条存着不报)。 */
	async function riskWorld() {
		const b = await boot(IN, {
			fetchAllDynamic: async () => ({ code: -352, message: "risk" }),
		});
		// biome-ignore lint/suspicious/noExplicitAny: 同上
		const dynamicEngine = b.source.dynamic() as any;
		await dynamicEngine.detectDynamics();
		const blockedRoom = makeLiveSession(b, "u1", "100", {
			streamKey: async () => {
				throw new RiskControlError("-352");
			},
		});
		await blockedRoom.bootstrap();
		const failedRoom = makeLiveSession(b, "u2", "200", {});
		await failedRoom.bootstrap();
		await flush();
		expect(codesOf(b)).toEqual(["risk_controlled"]);
		// 动态那一路好了:风控还挂着 live:u1 这一路,表里还是风控
		dynamicEngine.api.fetchAllDynamic = async () => ({
			code: 0,
			message: "ok",
			data: { items: [] },
		});
		await dynamicEngine.detectDynamics();
		await flush();
		expect(codesOf(b)).toEqual(["risk_controlled"]);
		return { b, blockedRoom, failedRoom };
	}

	const U2_STOPPED = PROBLEM_TEXTS.liveMonitorStopped.text(
		"200",
		PROBLEM_TEXTS.liveStopReasons.roomInfo,
	);

	// 验红:ProblemLayers.revealFailures 里不把报给过核心的记成静默(冒出来恒用自己的 notify),房间停监会私聊第二遍,这条红。
	it("先停监(已私聊)→ 风控 → 风控好了:停监冒回表里,但不说第二遍:私聊是 停监、风控、风控已解除", async () => {
		const b = await boot(IN, {
			fetchAllDynamic: async () => ({ code: -352, message: "risk" }),
		});
		await makeLiveSession(b, "u2", "200", { myself: async () => ({ code: -101 }) }).bootstrap();
		await flush();
		expect(codesOf(b)).toEqual(["sub:live_monitor_stopped"]);
		// 窗口过了:要是冒出来时再说一遍,不会被节流吞掉
		await vi.advanceTimersByTimeAsync(120_000);

		// biome-ignore lint/suspicious/noExplicitAny: 同上
		const dynamicEngine = b.source.dynamic() as any;
		await dynamicEngine.detectDynamics();
		await flush();
		expect(codesOf(b)).toEqual(["risk_controlled"]);
		dynamicEngine.api.fetchAllDynamic = async () => ({
			code: 0,
			message: "ok",
			data: { items: [] },
		});
		await dynamicEngine.detectDynamics();
		await flush();
		await vi.advanceTimersByTimeAsync(120_000);

		expect(codesOf(b)).toEqual(["sub:live_monitor_stopped"]);
		expect(b.notifyMaster.mock.calls.map((c) => c[0])).toEqual([
			PROBLEM_TEXTS.liveMonitorStopped.text("200", PROBLEM_TEXTS.liveStopReasons.danmakuConnect),
			PROBLEM_TEXTS.riskControlled.text,
			PROBLEM_TEXTS.riskControlled.recovery,
		]);
	});

	// 验红:去掉 bootstrap 里 `this.resolveRisk(listening)` 对 `listening` 的传递(恒 false),这条红(收不到「风控已解除」)。
	it("风控真的好了(这一路预检通过、连上了):压着的房间「停止监听」冒出来,主人收到「风控已解除」和那个房间的停监", async () => {
		const { b } = await riskWorld();

		// u1 这一路的预检这回过了、也连上了(房间信息与主播信息都拿得到):最后一路风控真解除了
		await makeLiveSession(b, "u1", "100", {
			roomInfo: async () => ({ code: 0, data: ROOM_OFFLINE }),
			master: async () => MASTER,
		}).bootstrap();
		await flush();

		expect(codesOf(b)).toEqual(["sub:live_monitor_stopped"]);
		expect(b.notifyMaster.mock.calls.map((c) => c[0])).toEqual([
			PROBLEM_TEXTS.riskControlled.text,
			PROBLEM_TEXTS.riskControlled.recovery,
			U2_STOPPED,
		]);
	});

	// 验红:cancel() 里的 retireRisk 换成 `this.resolveRisk(true)` 式的普通清,这条红(多出一句「风控已解除」)。
	it("会话被取消(关开关 / 退订 / 引擎停下):风控清掉但不说「风控已解除」,压着的房间停监照样冒出来", async () => {
		const { b, blockedRoom } = await riskWorld();

		blockedRoom.cancel();
		await flush();

		expect(codesOf(b)).toEqual(["sub:live_monitor_stopped"]);
		expect(b.notifyMaster.mock.calls.map((c) => c[0])).toEqual([
			PROBLEM_TEXTS.riskControlled.text,
			U2_STOPPED,
		]);
	});

	// 验红:同上(会话取消不带 notify: false),主人依次收到 风控 → 风控已解除 → 登录失效,这条红。
	it("掉登录时(auth-lost 先拆会话、登录口后变失效):主人只收到「登录失效」,不先收到「风控已解除」", async () => {
		const { b, blockedRoom, failedRoom } = await riskWorld();

		// `auth-lost` → teardown(`disposeAll`):先把每位 UP 的停监静默清掉,再让每个会话 cancel()
		// (次序由 listener-manager-late-results.test.ts 里真 ListenerManager 的用例钉着)
		const rooms = [
			[blockedRoom, "u1"],
			[failedRoom, "u2"],
		] as const;
		for (const [room, uid] of rooms) {
			(room as unknown as { ctx: RoomContext }).ctx.clearMonitorProblems(uid);
		}
		for (const [room] of rooms) room.cancel();
		b.set(EXPIRED); // 登录口随后才变成失效
		await flush();

		expect(codesOf(b)).toEqual(["auth_lost"]);
		expect(b.notifyMaster.mock.calls.map((c) => c[0])).toEqual([
			PROBLEM_TEXTS.riskControlled.text,
			PROBLEM_TEXTS.loginExpired.text,
		]);
	});
});

/**
 * 已定 26:直播预检被风控拦住只进问题表、不私聊;拉动态被风控照旧私聊。风控层记住每一路要不要私聊,
 * 只有不要私聊的路开着时条目不带私聊;之后动态也被风控了才补那一句;恢复句只在真说过之后才有。
 */
describe("直播预检被风控拦住:只进问题表,不私聊", () => {
	const BLOCKED = {
		streamKey: async () => {
			throw new RiskControlError("-352");
		},
	};
	/** 预检过了、也连上了(房间信息与主播信息都拿得到)。 */
	const CONNECTED = {
		roomInfo: async () => ({ code: 0, data: ROOM_OFFLINE }),
		master: async () => MASTER,
	};
	const RISKY = async () => ({ code: -352, message: "risk" });
	const FINE = async () => ({ code: 0, message: "ok", data: { items: [] } });
	const said = (b: Booted) => b.notifyMaster.mock.calls.map((c) => c[0]);

	// 验红:直播这一路改成要私聊(`PROBLEM_TEXTS.riskControlled.notify.live` 为 true),第一、二、四条红。
	it("只有直播被拦:表里有风控一条,私聊零次;解除后表空,仍是零次(没有「风控已解除」)", async () => {
		const b = await boot(IN);
		await makeLiveSession(b, "u1", "100", BLOCKED).bootstrap();
		await flush();
		expect(codesOf(b)).toEqual(["risk_controlled"]);
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(b.notifyMaster).not.toHaveBeenCalled();

		await makeLiveSession(b, "u1", "100", CONNECTED).bootstrap();
		await flush();

		expect(codesOf(b)).toEqual([]);
		expect(b.notifyMaster).not.toHaveBeenCalled();
	});

	// 验红:上报器里「有一路要私聊的进来就再报一次」去掉,这条红(动态被风控了主人也听不到)。
	it("直播先被拦、动态后被风控:这时才私聊一次;全部解除后恢复句一次", async () => {
		const b = await boot(IN);
		await makeLiveSession(b, "u1", "100", BLOCKED).bootstrap();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(said(b)).toEqual([]);

		// biome-ignore lint/suspicious/noExplicitAny: 白盒直调一轮检测,不等 cron
		const dynamicEngine = b.source.dynamic() as any;
		dynamicEngine.api.fetchAllDynamic = RISKY;
		await dynamicEngine.detectDynamics();
		await flush();
		expect(codesOf(b)).toEqual(["risk_controlled"]);
		expect(said(b)).toEqual([PROBLEM_TEXTS.riskControlled.text]);

		dynamicEngine.api.fetchAllDynamic = FINE;
		await dynamicEngine.detectDynamics();
		await vi.advanceTimersByTimeAsync(120_000);
		// 动态那一路好了,直播那一路还拦着:条目照旧开着,不撤回、也还没到说「解除」的时候
		expect(codesOf(b)).toEqual(["risk_controlled"]);
		expect(said(b)).toEqual([PROBLEM_TEXTS.riskControlled.text]);

		await makeLiveSession(b, "u1", "100", CONNECTED).bootstrap();
		await flush();
		expect(codesOf(b)).toEqual([]);
		expect(said(b)).toEqual([
			PROBLEM_TEXTS.riskControlled.text,
			PROBLEM_TEXTS.riskControlled.recovery,
		]);
	});

	it("动态先被风控、直播后被拦:私聊一次,不重复", async () => {
		const b = await boot(IN, { fetchAllDynamic: RISKY });
		// biome-ignore lint/suspicious/noExplicitAny: 同上
		await (b.source.dynamic() as any).detectDynamics();
		await vi.advanceTimersByTimeAsync(120_000);
		await makeLiveSession(b, "u1", "100", BLOCKED).bootstrap();
		await makeLiveSession(b, "u2", "200", BLOCKED).bootstrap();
		await vi.advanceTimersByTimeAsync(30 * 60_000);

		expect(codesOf(b)).toEqual(["risk_controlled"]);
		expect(said(b)).toEqual([PROBLEM_TEXTS.riskControlled.text]);
	});

	it("只有直播被拦时压在底下的房间停监:风控解除后照样冒出来、照样私聊(它自己的那一句)", async () => {
		const b = await boot(IN);
		await makeLiveSession(b, "u1", "100", BLOCKED).bootstrap();
		await makeLiveSession(b, "u2", "200", {}).bootstrap();
		await flush();
		expect(codesOf(b)).toEqual(["risk_controlled"]);
		expect(said(b)).toEqual([]);

		await makeLiveSession(b, "u1", "100", CONNECTED).bootstrap();
		await flush();

		expect(codesOf(b)).toEqual(["sub:live_monitor_stopped"]);
		expect(said(b)).toEqual([
			PROBLEM_TEXTS.liveMonitorStopped.text("200", PROBLEM_TEXTS.liveStopReasons.roomInfo),
		]);
	});
});

describe("留着的缺口(钉现状)", () => {
	// S-3(这次不修,要给核心的问题表加「压下」的概念):说过的房间被风控压下又静默露出之后,
	// 通知器那边是一条全新的、不带私聊的记账,真连上时就没有恢复句了。修好之后这条的期望要翻。
	it("已知的缺口 S-3:说过的房间停监被风控压下又露出,之后真连上了,主人收不到「监听已经恢复啦」", async () => {
		const b = await boot(IN, {
			fetchAllDynamic: async () => ({ code: -352, message: "risk" }),
		});
		await makeLiveSession(b, "u2", "200", { myself: async () => ({ code: -101 }) }).bootstrap();
		await vi.advanceTimersByTimeAsync(120_000);
		// biome-ignore lint/suspicious/noExplicitAny: 同上
		const dynamicEngine = b.source.dynamic() as any;
		await dynamicEngine.detectDynamics();
		dynamicEngine.api.fetchAllDynamic = async () => ({
			code: 0,
			message: "ok",
			data: { items: [] },
		});
		await dynamicEngine.detectDynamics();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(codesOf(b)).toEqual(["sub:live_monitor_stopped"]);

		await makeLiveSession(b, "u2", "200", {
			roomInfo: async () => ({ code: 0, data: ROOM_OFFLINE }),
			master: async () => MASTER,
		}).bootstrap();
		await vi.advanceTimersByTimeAsync(120_000);

		expect(codesOf(b)).toEqual([]);
		expect(b.notifyMaster.mock.calls.map((c) => c[0])).toEqual([
			PROBLEM_TEXTS.liveMonitorStopped.text("200", PROBLEM_TEXTS.liveStopReasons.danmakuConnect),
			PROBLEM_TEXTS.riskControlled.text,
			PROBLEM_TEXTS.riskControlled.recovery,
		]);
	});
});
