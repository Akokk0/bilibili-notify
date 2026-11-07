import {
	type AuthState,
	type DeliveryResult,
	fail,
	ok,
	type Result,
	type ServiceContext,
	type SourceContext,
	type SourceSubscriptionView,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import { createProblemNotifier } from "../../problems/problem-notifier.js";
import { createProblemTable } from "../../problems/problem-table.js";
import type { Api } from "../api/index.js";
import { failureFromBili } from "../error-codes.js";
import { BiliLiveRooms } from "../live/session/bili-live-rooms.js";
import { createProblemLayers } from "../problem-layers.js";

const EXTERNAL_ID = "u1";
const ROOM_ID = "100";
const GOOD_PREFLIGHT = ok({
	data: { token: "tok", host_list: [{ host: "h1.example.com", wss_port: 443 }] },
});

/**
 * 可变的假登录口。分层上报器与 `BiliLiveRooms` 都订同一个它,构造次序和生产里一样:
 * 分层上报器先订、`BiliLiveRooms` 后订。
 */
function makeMutableAuth(initial: AuthState) {
	let state = initial;
	const listeners = new Set<() => void>();
	return {
		auth: {
			state: () => state,
			onChange(fn: () => void) {
				listeners.add(fn);
				return { dispose: () => void listeners.delete(fn) };
			},
		},
		setAuth(next: AuthState) {
			state = next;
			for (const fn of [...listeners]) fn();
		},
	};
}

function makeWorld(
	options: {
		preflight?: () => Promise<unknown>;
		myself?: () => Promise<unknown>;
		roomInfo?: () => Promise<unknown>;
		resolveRoomId?: () => Promise<Result<{ roomId: string }>>;
		auth?: ReturnType<typeof makeMutableAuth>;
	} = {},
) {
	const logger = { debug() {}, info() {}, warn() {}, error() {} };
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
	const auth =
		options.auth ??
		makeMutableAuth({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" });
	const layers = createProblemLayers({
		locale: fixedLocale(),
		auth: auth.auth,
		logger,
	});
	layers.attach({
		reportProblem: (problem) =>
			table.report({
				reporter: "bilibili",
				code: problem.code,
				message: problem.message ?? "",
				notify: problem.notify,
				recoveryMessage: problem.recoveryMessage,
			}),
		resolveProblem: (problem) =>
			table.resolve(
				{ reporter: "bilibili", code: problem.code },
				problem.notify === undefined ? undefined : { notify: problem.notify },
			),
	});
	const socket = { closed: false, close: () => {} };
	const api = {
		fetchLiveRoomInfoStreamKey: vi.fn(options.preflight ?? (async () => GOOD_PREFLIGHT)),
		fetchCachedMyself: vi.fn(options.myself ?? (async () => ({ code: 0, data: { mid: 1 } }))),
		fetchCachedBuvid3: vi.fn(async () => "buv"),
		openDanmakuSocket: vi.fn(() => ({
			binaryType: "",
			on() {},
			send() {},
			close() {
				socket.closed = true;
			},
		})),
		fetchLiveRoomInfo: vi.fn(
			options.roomInfo ??
				(async () => ({
					data: { uid: 1, room_id: 100, live_status: 0, live_time: "0000-00-00 00:00:00" },
				})),
		),
		fetchUpDetails: vi.fn(async () => ({
			data: { info: { uid: 1, uname: "U" }, medal_name: "" },
		})),
		fetchUserInfo: vi.fn(async () => ok({ data: { live_room: { roomid: 100 } } })),
	};
	const liveContext = {
		logger,
		setInterval: () => ({ dispose() {} }),
		setTimeout: (fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(timer) };
		},
		onDispose() {},
		signal: new AbortController().signal,
		track() {},
	};
	const reports: unknown[] = [];
	const ctx = {
		logger,
		fetchImage: async () => ({ ok: true, ref: `${"c".repeat(64)}.webp` }),
		reportLive: (_externalId: string, report: unknown) => void reports.push(report),
		reportLiveInteraction() {},
		onSubscriptionsChanged: () => ({ dispose() {} }),
		subscriptions: () => [subscription],
	} as unknown as SourceContext;
	const rooms = new BiliLiveRooms({
		api: api as unknown as Api,
		auth: auth.auth,
		liveContext: liveContext as ServiceContext,
		roomIds: {
			get: (externalId) => (externalId === EXTERNAL_ID ? ROOM_ID : undefined),
			resolve: options.resolveRoomId ?? (async () => ok({ roomId: ROOM_ID })),
			syncSubscriptions() {},
		},
		rememberFanClubName() {},
		problems: layers,
	});
	const subscription: SourceSubscriptionView = {
		externalId: EXTERNAL_ID,
		features: new Set(["liveStart", "liveStreaming", "liveEnd"]),
		monitorsLive: true,
	};
	const codes = () =>
		table
			.list()
			.map((problem) => problem.code)
			.sort();
	const settle = async () => {
		for (let i = 0; i < 12; i++) await Promise.resolve();
		await vi.advanceTimersByTimeAsync(0);
	};
	return {
		api,
		ctx,
		rooms,
		table,
		layers,
		auth,
		notifyMaster,
		reports,
		codes,
		settle,
		subscription,
		socket,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("直播问题验收 · B 站这一侧", () => {
	it("停止监听:弹幕连接没建起来时由 B 站报订阅级问题,私聊一次", async () => {
		const w = makeWorld({ myself: async () => ({ code: -101 }) });
		w.rooms.start(w.ctx, [w.subscription]);
		await w.settle();
		expect(w.codes()).toEqual(["live_monitor_stopped"]);
		expect(w.notifyMaster).toHaveBeenCalledTimes(1);
		w.rooms.stop();
	});

	it("房间受限:预检明确拒绝时由 B 站报受限房,不停在普通失败路径上", async () => {
		const w = makeWorld({
			preflight: async () => failureFromBili(-403, "无权限"),
		});
		w.rooms.start(w.ctx, [w.subscription]);
		await w.settle();
		expect(w.codes()).toEqual(["live_room_restricted"]);
		expect(w.notifyMaster).toHaveBeenCalledTimes(1);
		w.rooms.stop();
	});

	it("风控:预检被拦时由 B 站报风控层,直播间这一路不私聊", async () => {
		const w = makeWorld({
			preflight: async () => failureFromBili(-352, "risk"),
		});
		w.rooms.start(w.ctx, [w.subscription]);
		await w.settle();
		expect(w.codes()).toEqual(["risk_controlled"]);
		expect(w.notifyMaster).not.toHaveBeenCalled();
		w.rooms.stop();
	});

	it("解析房号撞风控:进风控层、只进表;解出来后真解除", async () => {
		const resolveRoomId = vi
			.fn()
			.mockResolvedValueOnce(fail("rate_limited", "risk"))
			.mockResolvedValueOnce(ok({ roomId: ROOM_ID }));
		const w = makeWorld({ resolveRoomId });

		w.rooms.start(w.ctx, [w.subscription]);
		await w.settle();
		expect(w.codes()).toEqual(["risk_controlled"]);
		expect(w.notifyMaster).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(60_000);
		await w.settle();
		expect(resolveRoomId).toHaveBeenCalledTimes(2);
		expect(w.codes()).toEqual([]);
		expect(w.notifyMaster).not.toHaveBeenCalled();
		w.rooms.stop();
	});

	it("这一轮没取到直播状态:由 B 站经分层报 live_status_unavailable,不停监听,成功后清", async () => {
		const w = makeWorld();
		w.rooms.start(w.ctx, [w.subscription]);
		await w.settle();
		const signal = new AbortController().signal;
		const normalRoomInfo = w.api.fetchLiveRoomInfo;
		w.api.fetchLiveRoomInfo = (async () => {
			throw new Error("接口短暂失败");
		}) as never;

		await expect(
			w.rooms.fetchLiveStatus({ sourceKey: "bilibili", externalId: EXTERNAL_ID }, signal),
		).resolves.toMatchObject({ ok: false });
		expect(w.codes()).toEqual(["live_status_unavailable"]);
		expect(w.socket.closed).toBe(false);
		expect(w.notifyMaster).not.toHaveBeenCalled();

		w.api.fetchLiveRoomInfo = normalRoomInfo;
		await expect(
			w.rooms.fetchLiveStatus({ sourceKey: "bilibili", externalId: EXTERNAL_ID }, signal),
		).resolves.toMatchObject({ ok: true, kind: "offline" });
		expect(w.codes()).toEqual([]);
		w.rooms.stop();
	});

	it("开机时登录已过期、扫码恢复后：直播间重开、不私聊停止监听", async () => {
		let myself = async () => ({ code: -101 });
		const auth = makeMutableAuth({ status: "expired", message: "登录已失效" });
		const w = makeWorld({ auth, myself: () => myself() });
		w.rooms.start(w.ctx, [w.subscription]);
		await w.settle();
		expect(w.api.openDanmakuSocket).toHaveBeenCalledTimes(0);

		myself = async () => ({ code: 0, data: { mid: 1 } });
		w.auth.setAuth({ status: "logged-in", loggedInAt: "2026-10-11T00:01:00.000Z" });
		await w.settle();

		expect(w.notifyMaster).not.toHaveBeenCalled();
		expect(w.api.openDanmakuSocket).toHaveBeenCalledTimes(1);
		w.rooms.stop();
	});
});
