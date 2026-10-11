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
}

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

	it("登录好了:压在底下的房间问题(lasting)冒出来 —— 两个房间都还连不上的话,表里是它们两条", async () => {
		const b = await boot(EXPIRED);
		await makeLiveSession(b, "u1", "100", { myself: async () => ({ code: -101 }) }).bootstrap();
		await flush();
		expect(codesOf(b)).toEqual(["auth_lost"]);

		b.set(IN);
		await flush();
		expect(codesOf(b)).toEqual(["sub:live_monitor_stopped"]);
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

	it("风控好了:压着的房间「停止监听」冒出来,主人收到「风控已解除」和那个房间的停监", async () => {
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
		// u2 的房间取信息失败 —— 风控压着,这条先存着不报
		await makeLiveSession(b, "u2", "200", {}).bootstrap();
		await flush();
		expect(codesOf(b)).toEqual(["risk_controlled"]);

		// 动态那一路好了:风控还挂着 live:u1 这一路,表里还是风控
		b.table.list(); // (只读,确认表没动)
		const ok0 = { code: 0, message: "ok", data: { items: [] } };
		dynamicEngine.api.fetchAllDynamic = async () => ok0;
		await dynamicEngine.detectDynamics();
		await flush();
		expect(codesOf(b)).toEqual(["risk_controlled"]);

		// u1 这一路的会话结束:最后一路风控清了,u2 的停监冒出来
		blockedRoom.cancel();
		await flush();
		expect(codesOf(b)).toEqual(["sub:live_monitor_stopped"]);
		expect(b.notifyMaster.mock.calls.map((c) => c[0])).toEqual([
			PROBLEM_TEXTS.riskControlled.text,
			PROBLEM_TEXTS.riskControlled.recovery,
			PROBLEM_TEXTS.liveMonitorStopped.text("200", PROBLEM_TEXTS.liveStopReasons.roomInfo),
		]);
	});
});
