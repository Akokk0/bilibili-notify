import type { SourceContext, SourceSubscriptionView } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import payloads from "../../protocol/__tests__/fixtures/payloads.json" with { type: "json" };
import { encodePacket, WsOp } from "../../protocol/codec.js";
import { BiliLiveRooms } from "../bili-live-rooms.js";
import { makeRecordingLayers } from "./support/live-problems.js";

const EXTERNAL_ID = "10001";
const ROOM_ID = "5001";
const COVER_REF = `${"c".repeat(64)}.webp`;
const STARTED_AT = "2026-03-01T03:58:30.000Z";

type Socket = {
	closed: boolean;
	fire(event: string, ...args: unknown[]): void;
};

function heartbeatReply(): Uint8Array {
	const packet = new Uint8Array(20);
	const view = new DataView(packet.buffer);
	view.setUint32(0, 20);
	view.setUint16(4, 16);
	view.setUint16(6, 1);
	view.setUint32(8, WsOp.HeartbeatReply);
	view.setUint32(12, 1);
	view.setUint32(16, 1);
	return packet;
}

async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(0);
}

function harness() {
	let online = false;
	let roomInfoGate: Promise<void> | undefined;
	let roomInfoMode: "ok" | "throws" | "empty" = "ok";
	let preflight = {
		ok: true as const,
		data: { token: "token", host_list: [{ host: "danmaku.test", wss_port: 443 }] },
	};
	const sockets: Socket[] = [];
	const reports: Array<{ externalId: string; report: unknown }> = [];
	const interactions: Array<{ externalId: string; report: unknown }> = [];
	const problems = makeRecordingLayers();
	const liveRoomIds = new Map([[EXTERNAL_ID, ROOM_ID]]);
	const profileStates = new Map<string, { fanClubName: string }>();
	const fetched: string[] = [];
	const busHandlers = new Map<string, Array<() => void>>();

	const api = {
		fetchLiveRoomInfoStreamKey: async () => preflight,
		getMyselfInfoCached: async () => ({ code: 0, data: { mid: 1 } }),
		getBuvid3: async () => "buvid",
		openDanmakuSocket: () => {
			const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
			const socket: Socket = {
				closed: false,
				fire(event, ...args) {
					for (const fn of handlers.get(event) ?? []) fn(...args);
				},
			};
			sockets.push(socket);
			queueMicrotask(() => {
				socket.fire("open");
				socket.fire("message", encodePacket(WsOp.AuthReply, { code: 0 }));
			});
			return {
				binaryType: "",
				on(event: string, fn: (...args: unknown[]) => void) {
					handlers.set(event, [...(handlers.get(event) ?? []), fn]);
				},
				send(data: Uint8Array) {
					const op = new DataView(data.buffer, data.byteOffset).getUint32(8);
					if (op === WsOp.Heartbeat && !socket.closed) socket.fire("message", heartbeatReply());
				},
				close() {
					socket.closed = true;
				},
			};
		},
		fetchLiveRoomInfo: async () => {
			await roomInfoGate;
			if (roomInfoMode === "throws") throw new Error("房间信息失败");
			if (roomInfoMode === "empty") return { code: 0, data: {} };
			return {
				code: 0,
				data: {
					uid: Number(EXTERNAL_ID),
					room_id: Number(ROOM_ID),
					live_status: online ? 1 : 0,
					live_time: online ? "2026-03-01 11:58:30" : "0000-00-00 00:00:00",
					title: "今晚直播",
					user_cover: "https://i0.hdslb.com/bfs/live/cover.jpg",
					keyframe: "",
					area_name: "聊天",
					description: "<p>房间简介</p>",
					online: 321,
				},
			};
		},
		getMasterInfo: async () => ({
			code: 0,
			data: {
				info: { uid: Number(EXTERNAL_ID), uname: "测试主播", face: "" },
				follower_num: 1000,
				room_id: Number(ROOM_ID),
				medal_name: "测试牌",
			},
		}),
		fetchUserInfo: vi.fn(async () => ({
			code: 0,
			data: { live_room: { roomid: Number(ROOM_ID) } },
		})),
	};

	const subscription: SourceSubscriptionView = {
		externalId: EXTERNAL_ID,
		features: new Set(["liveStart", "liveEnd", "liveStreaming"]),
		monitorsLive: true,
	};
	let subscriptions = [subscription];
	const ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		fetchImage: async (url: string) => {
			fetched.push(url);
			return { ok: true, ref: COVER_REF };
		},
		reportLive: (externalId: string, report: unknown) => {
			reports.push({ externalId, report });
		},
		reportLiveInteraction: (externalId: string, report: unknown) => {
			interactions.push({ externalId, report });
		},
		onSubscriptionsChanged: () => ({ dispose() {} }),
		subscriptions: () => subscriptions,
	} as unknown as SourceContext;

	const liveContext = {
		logger: ctx.logger,
		signal: new AbortController().signal,
		setInterval: () => ({ dispose() {} }),
		setTimeout: (fn: () => void, ms: number) => {
			const handle = globalThis.setTimeout(fn, ms);
			return { dispose: () => globalThis.clearTimeout(handle) };
		},
		onDispose() {},
		track() {},
	};

	const rooms = new BiliLiveRooms({
		api: api as never,
		bus: {
			on: (event: string, fn: () => void) => {
				busHandlers.set(event, [...(busHandlers.get(event) ?? []), fn]);
				return {
					dispose: () => {
						busHandlers.set(
							event,
							(busHandlers.get(event) ?? []).filter((candidate) => candidate !== fn),
						);
					},
				};
			},
		} as never,
		liveContext,
		liveRoomIds: {
			get: (externalId) => liveRoomIds.get(externalId),
			set: (externalId, roomId) => void liveRoomIds.set(externalId, roomId),
		},
		rememberFanClubName: (externalId, name) =>
			void profileStates.set(`profile:${externalId}`, { fanClubName: name }),
		problems: problems.layers,
	});

	return {
		api,
		ctx,
		rooms,
		problems,
		reports,
		interactions,
		profileStates,
		fetched,
		sockets,
		liveRoomIds,
		setSubscriptions(value: SourceSubscriptionView[]) {
			subscriptions = value;
		},
		emitBus(event: string) {
			for (const fn of busHandlers.get(event) ?? []) fn();
		},
		setOnline(value: boolean) {
			online = value;
		},
		setRoomId(value: string | undefined) {
			if (value === undefined) liveRoomIds.delete(EXTERNAL_ID);
			else liveRoomIds.set(EXTERNAL_ID, value);
		},
		setRoomInfoMode(value: typeof roomInfoMode) {
			roomInfoMode = value;
		},
		setPreflight(value: typeof preflight) {
			preflight = value;
		},
		holdRoomInfo() {
			let release = () => {};
			roomInfoGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return () => {
				roomInfoGate = undefined;
				release();
			};
		},
		async start() {
			rooms.start(ctx, subscriptions);
			await settle();
		},
		async frame(command: object) {
			sockets.at(-1)?.fire("message", encodePacket(WsOp.Message, command));
			await settle();
		},
	};
}

const LIVE = { cmd: "LIVE" };
const END = { cmd: "PREPARING" };
const DANMAKU = {
	cmd: "DANMU_MSG",
	info: [[0, 1, 25], "来了", [777, "观众甲", 0], []],
};
const SUPERCHAT = {
	cmd: "SUPER_CHAT_MESSAGE",
	data: {
		uid: 777,
		user_info: { uname: "观众甲", face: "https://i0.hdslb.com/bfs/face/viewer.jpg" },
		message: "晚上好",
		price: 30,
		time: 60,
	},
};
const MEMBERSHIP = {
	cmd: "GUARD_BUY",
	data: {
		uid: 888,
		username: "观众乙",
		guard_level: 3,
		num: 1,
		price: 198000,
		gift_name: "舰长",
	},
};
const ENTER = payloads.interactV2;

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-03-01T04:00:00.000Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("BiliLiveRooms", () => {
	it("开播帧只报一次 start，带 ISO 开播时刻与图库封面，并写粉丝牌名", async () => {
		const h = harness();
		await h.start();
		h.setOnline(true);
		await h.frame(LIVE);

		expect(h.reports).toEqual([
			{
				externalId: EXTERNAL_ID,
				report: {
					kind: "start",
					startedAt: STARTED_AT,
					details: {
						title: "今晚直播",
						cover: {
							url: "https://i0.hdslb.com/bfs/live/cover.jpg",
							ref: COVER_REF,
						},
						category: "聊天",
						url: "https://live.bilibili.com/5001",
						currentViewers: 321,
						description: "房间简介",
					},
				},
			},
		]);
		expect(h.profileStates.get(`profile:${EXTERNAL_ID}`)).toEqual({ fanClubName: "测试牌" });
		h.rooms.stop();
	});

	it("开播准备期间收到下播帧：开播与下播都不报", async () => {
		const h = harness();
		await h.start();
		h.setOnline(true);
		const release = h.holdRoomInfo();
		h.sockets.at(-1)?.fire("message", encodePacket(WsOp.Message, LIVE));
		await settle();
		await h.frame(END);
		release();
		await settle();

		expect(h.reports).toEqual([]);
		h.rooms.stop();
	});

	it("断连期间不报下播；重连后核到已下播才报 end", async () => {
		const h = harness();
		await h.start();
		h.setOnline(true);
		await h.frame(LIVE);
		expect(h.reports).toHaveLength(1);

		h.setOnline(false);
		h.sockets.at(-1)?.fire("error", new Error("断线"));
		await vi.advanceTimersByTimeAsync(1_000);
		await settle();

		expect(h.reports.map((entry) => (entry.report as { kind: string }).kind)).toEqual([
			"start",
			"end",
		]);
		h.rooms.stop();
	});

	it("观看人数帧按两秒节流成 status，只在已知在播时报", async () => {
		const h = harness();
		await h.start();
		await h.frame({ cmd: "WATCHED_CHANGE", data: { num: 10 } });
		expect(h.reports).toEqual([]);

		h.setOnline(true);
		await h.frame(LIVE);
		h.reports.length = 0;
		await h.frame({ cmd: "WATCHED_CHANGE", data: { num: 20 } });
		await vi.advanceTimersByTimeAsync(1_000);
		await h.frame({ cmd: "WATCHED_CHANGE", data: { num: 21 } });
		await vi.advanceTimersByTimeAsync(1_000);
		await h.frame({ cmd: "WATCHED_CHANGE", data: { num: 22 } });

		expect(h.reports).toEqual([
			{
				externalId: EXTERNAL_ID,
				report: {
					kind: "status",
					isLive: true,
					details: { totalViewers: 20 },
				},
			},
			{
				externalId: EXTERNAL_ID,
				report: {
					kind: "status",
					isLive: true,
					details: { totalViewers: 22 },
				},
			},
		]);
		h.rooms.stop();
	});

	it("四类帧都翻成中立互动上报，SC 头像地址留给来源懒取", async () => {
		const h = harness();
		await h.start();
		await h.frame(DANMAKU);
		await h.frame(ENTER);
		await h.frame(SUPERCHAT);
		await h.frame(MEMBERSHIP);

		expect(h.interactions.map((entry) => (entry.report as { kind: string }).kind)).toEqual([
			"viewerChat",
			"viewerEnter",
			"superchat",
			"membership",
		]);
		expect(h.interactions[0]?.report).toMatchObject({
			kind: "viewerChat",
			viewer: { id: "777", name: "观众甲" },
			text: "来了",
		});
		expect(h.interactions[2]?.report).toMatchObject({
			kind: "superchat",
			viewer: { id: "777", name: "观众甲" },
			text: "晚上好",
			amount: 30,
		});
		expect(h.interactions[3]?.report).toMatchObject({
			kind: "membership",
			viewer: { id: "888", name: "观众乙" },
			program: "guard",
			tier: { key: "captain", name: "舰长", rank: 1 },
		});
		h.rooms.stop();
	});

	it("fetchLiveStatus：在播 / 不在播 / 失败，失败只记问题且不停监听，下一次成功清掉", async () => {
		const h = harness();
		await h.start();
		const signal = new AbortController().signal;
		h.setOnline(true);

		await expect(
			h.rooms.fetchLiveStatus({ sourceKey: "bilibili", externalId: EXTERNAL_ID }, signal),
		).resolves.toMatchObject({ ok: true, kind: "live", startedAt: STARTED_AT });
		h.setOnline(false);
		await expect(
			h.rooms.fetchLiveStatus({ sourceKey: "bilibili", externalId: EXTERNAL_ID }, signal),
		).resolves.toMatchObject({ ok: true, kind: "offline" });

		const normalRoomInfo = h.api.fetchLiveRoomInfo;
		h.api.fetchLiveRoomInfo = async () => {
			throw new Error("接口短暂失败");
		};
		await expect(
			h.rooms.fetchLiveStatus({ sourceKey: "bilibili", externalId: EXTERNAL_ID }, signal),
		).resolves.toMatchObject({ ok: false });
		expect(h.problems.present()).toEqual([`${EXTERNAL_ID}:live_status_unavailable`]);
		expect(h.sockets[0]?.closed).toBe(false);

		h.setOnline(true);
		h.api.fetchLiveRoomInfo = normalRoomInfo;
		await expect(
			h.rooms.fetchLiveStatus({ sourceKey: "bilibili", externalId: EXTERNAL_ID }, signal),
		).resolves.toMatchObject({ ok: true, kind: "live" });
		expect(h.problems.present()).toEqual([]);
		h.rooms.stop();
	});

	it("开监听时取不到房间信息：报停止监听并关掉连接", async () => {
		const h = harness();
		h.setRoomInfoMode("throws");
		await h.start();

		expect(h.problems.present()).toEqual([`${EXTERNAL_ID}:live_monitor_stopped`]);
		expect(h.sockets).toHaveLength(1);
		expect(h.sockets[0]?.closed).toBe(true);
		h.rooms.stop();
	});

	it("预检明确拒房间：报房间受限；风控只报风控层", async () => {
		const restricted = harness();
		restricted.setPreflight({
			ok: false,
			code: "unsupported",
			message: "encrypted",
		} as never);
		await restricted.start();
		expect(restricted.problems.present()).toEqual([`${EXTERNAL_ID}:live_room_restricted`]);
		restricted.rooms.stop();

		const risk = harness();
		risk.setPreflight({ ok: false, code: "rate_limited", message: "risk" } as never);
		await risk.start();
		expect(risk.problems.present()).toEqual(["risk_controlled"]);
		risk.rooms.stop();
	});

	it("房号缓存没有时按订阅身份解析一次，并把结果交回上下文缓存", async () => {
		const h = harness();
		h.setRoomId(undefined);
		await h.start();
		expect(h.api.fetchUserInfo).toHaveBeenCalledWith(EXTERNAL_ID);
		expect(h.liveRoomIds.get(EXTERNAL_ID)).toBe(ROOM_ID);
		h.rooms.stop();
	});

	it("房号解析不出来时只报这一轮状态不可用，不关掉已有监听", async () => {
		const h = harness();
		await h.start();
		h.setRoomId(undefined);
		h.api.fetchUserInfo = (async () => ({ code: -404, data: {} })) as never;
		await expect(
			h.rooms.fetchLiveStatus(
				{ sourceKey: "bilibili", externalId: EXTERNAL_ID },
				new AbortController().signal,
			),
		).resolves.toMatchObject({ ok: false });
		expect(h.problems.present()).toEqual([`${EXTERNAL_ID}:live_status_unavailable`]);
		expect(h.sockets[0]?.closed).toBe(false);
		h.rooms.stop();
	});

	it("登录失效 → 全部监听拆掉", async () => {
		const h = harness();
		h.liveRoomIds.set("u2", "5002");
		h.setSubscriptions([
			{
				externalId: EXTERNAL_ID,
				features: new Set(["liveStart"]),
				monitorsLive: true,
			},
			{ externalId: "u2", features: new Set(["liveStart"]), monitorsLive: true },
		]);
		await h.start();
		expect(h.sockets).toHaveLength(2);
		expect(h.sockets.every((socket) => !socket.closed)).toBe(true);

		h.emitBus("auth-lost");
		await settle();
		expect(h.sockets.every((socket) => socket.closed)).toBe(true);
		h.rooms.stop();
	});

	it("登录恢复 → 按名单重开", async () => {
		const h = harness();
		h.liveRoomIds.set("u2", "5002");
		h.setSubscriptions([
			{
				externalId: EXTERNAL_ID,
				features: new Set(["liveStart"]),
				monitorsLive: true,
			},
			{ externalId: "u2", features: new Set(["liveStart"]), monitorsLive: true },
		]);
		await h.start();
		h.emitBus("auth-lost");
		await settle();
		h.emitBus("auth-restored");
		await settle();
		expect(h.sockets).toHaveLength(4);
		expect(h.sockets.slice(2).every((socket) => !socket.closed)).toBe(true);
		h.rooms.stop();
	});
});
