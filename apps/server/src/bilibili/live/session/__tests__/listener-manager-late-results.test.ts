/**
 * 会话被停掉之后才回来的预检 / 建连结果,不许再往问题表里报:真 `ListenerManager` + 真上报器 + 记录用的假核心,
 * 预检用可手动放行的 promise。
 *
 * 问题的键是 UP 不是会话:迟到的上报会留下谁也清不掉的条目 ——
 * - 迟到的「被拦」:`live:<uid>` 这一路风控永远挂着,把之后所有直播间的停监压成无声;
 * - 迟到的「受限 / 没连上」:表里多一条订阅级问题、多一条「把开关关掉再打开」的私聊(主人刚把它关掉),
 *   而 `stopForUid` 只认 `subRecord`,清不到它。
 *
 * 每条都先做对照(不停会话时同样的放行确实会进表),才证明「没有」不是因为什么都没接上。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { RiskControlError } from "../../../api/index.js";
import { createProblemLayers } from "../../../problem-layers";
import type { SubItemView } from "../../push-like";
import { ListenerManager } from "../listener-manager";
import type { RoomContextOptions } from "../room-context";

function makeSub(uid: string): SubItemView {
	return {
		subscriptionId: `sub-${uid}`,
		uid,
		uname: uid,
		roomId: `${uid.slice(1)}00`,
		post: false,
		liveStart: true,
		liveEnd: false,
		membership: false,
		superchat: false,
		liveStreaming: false,
	} as unknown as SubItemView;
}

/** 可手动放行的 promise。 */
function gate<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const GOOD_STREAM_KEY = {
	code: 0,
	data: { token: "tok", host_list: [{ host: "h1.example.com", wss_port: 443 }] },
};

const settle = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/**
 * 起一个管理器。`preflights` 里每个 uid 的预检(取弹幕连接信息)各给一个手动放行的 promise;
 * 假核心把每次上报 / 清除记成一行(`report:<uid>:<code>` / `resolve:<uid>:<code>[:silent]`),表的现状在 `present()`。
 */
function setup(
	uids: string[],
	over: { myself?: () => Promise<unknown>; roomInfo?: () => Promise<unknown> } = {},
) {
	const preflights = new Map(uids.map((uid) => [uid, gate<unknown>()]));
	const calls: string[] = [];
	const table = new Map<string, string>();
	const keyOf = (p: { externalId?: string; code: string }) => `${p.externalId ?? ""}|${p.code}`;
	const label = (p: { externalId?: string; code: string }) =>
		p.externalId ? `${p.externalId}:${p.code}` : p.code;
	const layers = createProblemLayers({
		auth: {
			state: () => ({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" }),
			onChange: () => ({ dispose() {} }),
		},
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
	layers.attach({
		reportProblem: (p) => {
			calls.push(`report:${label(p)}`);
			table.set(keyOf(p), label(p));
		},
		resolveProblem: (p) => {
			calls.push(`resolve:${label(p)}${p.notify === false ? ":silent" : ""}`);
			table.delete(keyOf(p));
		},
	});
	const serviceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
		signal: new AbortController().signal,
		track: () => {},
	};
	const manager = new ListenerManager({
		serviceCtx,
		api: {
			// 房号 `<uid 去掉 u>00`:100 / 200 …
			fetchLiveRoomInfoStreamKey: vi.fn(async (roomId: string) => {
				const uid = `u${roomId.slice(0, -2)}`;
				const g = preflights.get(uid);
				if (!g) throw new Error(`没有为 ${uid} 备预检`);
				return g.promise;
			}),
			getMyselfInfoCached: vi.fn(over.myself ?? (async () => ({ code: 0, data: { mid: 1 } }))),
			getBuvid3: vi.fn(async () => "buv"),
			openDanmakuSocket: vi.fn(() => ({ binaryType: "", on() {}, send() {}, close() {} })),
			fetchLiveRoomInfo: vi.fn(
				over.roomInfo ??
					(async () => {
						throw new Error("取房间信息炸了");
					}),
			),
		},
		push: {},
		problems: layers,
		contentBuilder: {},
		templateRenderer: {},
		wordcloudGenerator: {},
		liveSummaryRequester: {},
		danmakuCollector: { registerRoom() {}, clear() {}, clearAll() {} },
		getImageRenderer: () => null,
		config: {},
		emitEngineError: vi.fn(),
		emitLiveState: vi.fn(),
	} as unknown as RoomContextOptions);
	return {
		manager,
		layers,
		calls,
		preflights,
		present: () => [...table.values()].sort(),
	};
}

/** 之后别的失败能照常进表:没有一条挂着的风控压着它。 */
function laterFailureGetsThrough(w: ReturnType<typeof setup>): void {
	w.layers.reportFailure({
		externalId: "u9",
		code: "live_monitor_stopped",
		message: "房间停了",
		notify: false,
		lasting: true,
	});
	expect(w.present()).toContain("u9:live_monitor_stopped");
}

describe("预检在途时会话被停掉,迟到的结果不上报", () => {
	// 验红:去掉 RoomSessionBase.reportRisk 里的 `if (!this.alive) return`(两处 reportRisk 都经它),第二条红。
	it("对照:不停会话,预检回「被拦」→ 表里有这一路风控", async () => {
		const w = setup(["u1"]);
		w.manager.startForUid(makeSub("u1"));
		w.preflights.get("u1")?.reject(new RiskControlError("-352"));
		await settle();
		expect(w.present()).toEqual(["risk_controlled"]);
	});

	it("停掉这位 UP 之后才放行「被拦」:没有风控路留下,之后别的失败照常进表", async () => {
		const w = setup(["u1"]);
		w.manager.startForUid(makeSub("u1"));
		w.manager.stopForUid("u1");

		w.preflights.get("u1")?.reject(new RiskControlError("-352"));
		await settle();

		expect(w.calls.filter((c) => c.includes("risk_controlled"))).toEqual([]);
		expect(w.present()).toEqual([]);
		laterFailureGetsThrough(w);
	});

	// 验红:去掉 RoomSessionBase.reportRestricted 里的 alive 判断,第二条红。
	it("对照:不停会话,预检回「没有 token」→ 表里有这个房间的「受限」", async () => {
		const w = setup(["u1"]);
		w.manager.startForUid(makeSub("u1"));
		w.preflights.get("u1")?.resolve({ code: 0, data: {} });
		await settle();
		expect(w.present()).toEqual(["u1:live_room_restricted"]);
	});

	it("停掉这位 UP 之后才放行「受限」:表里不多一条,也没有上报过", async () => {
		const w = setup(["u1"]);
		w.manager.startForUid(makeSub("u1"));
		w.manager.stopForUid("u1");

		w.preflights.get("u1")?.resolve({ code: 0, data: {} });
		await settle();

		expect(w.calls.filter((c) => c.startsWith("report:"))).toEqual([]);
		expect(w.present()).toEqual([]);
	});

	// 验红:去掉 RoomSessionBase.reportStopped 里的 alive 判断,第二条红。
	it("对照:不停会话,预检过了但建连没成(取个人信息失败)→ 表里有「停止监听」", async () => {
		const w = setup(["u1"], { myself: async () => ({ code: -101 }) });
		w.manager.startForUid(makeSub("u1"));
		w.preflights.get("u1")?.resolve(GOOD_STREAM_KEY);
		await settle();
		expect(w.present()).toEqual(["u1:live_monitor_stopped"]);
	});

	it("停掉这位 UP 之后才放行「没连上」:表里不多一条,也没有上报过", async () => {
		const w = setup(["u1"], { myself: async () => ({ code: -101 }) });
		w.manager.startForUid(makeSub("u1"));
		w.manager.stopForUid("u1");

		w.preflights.get("u1")?.resolve(GOOD_STREAM_KEY);
		await settle();

		expect(w.calls.filter((c) => c.startsWith("report:"))).toEqual([]);
		expect(w.present()).toEqual([]);
	});

	// 验红:去掉 `RoomContext.getLiveRoomInfo` 里对 `shouldReport` 的判断(恒报),第二条红。
	it("对照:不停会话,连上后取房间信息失败 → 表里有「停止监听」", async () => {
		const info = gate<unknown>();
		const w = setup(["u1"], { roomInfo: () => info.promise });
		w.manager.startForUid(makeSub("u1"));
		w.preflights.get("u1")?.resolve(GOOD_STREAM_KEY);
		await settle();
		info.reject(new Error("取房间信息炸了"));
		await settle();
		expect(w.present()).toEqual(["u1:live_monitor_stopped"]);
	});

	it("连上之后、取房间信息在途时停掉:迟到的失败不上报", async () => {
		const info = gate<unknown>();
		const w = setup(["u1"], { roomInfo: () => info.promise });
		w.manager.startForUid(makeSub("u1"));
		w.preflights.get("u1")?.resolve(GOOD_STREAM_KEY);
		await settle();
		w.manager.stopForUid("u1");

		info.reject(new Error("取房间信息炸了"));
		await settle();

		expect(w.calls.filter((c) => c.startsWith("report:"))).toEqual([]);
		expect(w.present()).toEqual([]);
	});

	it("整批停掉(disposeAll)之后才放行:同样什么都不报", async () => {
		const w = setup(["u1", "u2"]);
		w.manager.startForUid(makeSub("u1"));
		w.manager.startForUid(makeSub("u2"));
		w.manager.disposeAll();

		w.preflights.get("u1")?.reject(new RiskControlError("-352"));
		w.preflights.get("u2")?.resolve({ code: 0, data: {} });
		await settle();

		expect(w.calls.filter((c) => c.startsWith("report:"))).toEqual([]);
		expect(w.present()).toEqual([]);
	});
});

describe("整批停掉 / 重建时的次序:先静默清问题,再 cancel", () => {
	/** u1 被风控拦着,u2 是受限房(压在风控底下、存着不报)。 */
	async function riskWorld() {
		const w = setup(["u1", "u2"]);
		w.manager.startForUid(makeSub("u1"));
		w.manager.startForUid(makeSub("u2"));
		w.preflights.get("u1")?.reject(new RiskControlError("-352"));
		w.preflights.get("u2")?.resolve({ code: 0, data: {} });
		await settle();
		expect(w.present()).toEqual(["risk_controlled"]);
		w.calls.length = 0;
		return w;
	}

	// 验红:把 disposeAll 里的 `clearProblemsOfAll()` 挪回 cancel 循环之后,这条红(u2 的受限先冒出来)。
	it("disposeAll(登录失效拆会话):风控清掉时压在底下的别的房间问题不冒出来(冒出来就会私聊一句马上作废的话)", async () => {
		const w = await riskWorld();

		w.manager.disposeAll();

		expect(w.calls.filter((c) => c.startsWith("report:"))).toEqual([]);
		expect(w.present()).toEqual([]);
	});

	// 验红:同上,挪 startAll 里的。
	it("startAll(整批重建):同样不冒出来", async () => {
		const w = await riskWorld();

		w.manager.startAll({});

		expect(w.calls.filter((c) => c.startsWith("report:"))).toEqual([]);
		expect(w.present()).toEqual([]);
	});

	it("对照:只停风控那一位(stopForUid):风控清掉,压在底下的别的房间问题冒出来(它还监听着,问题仍成立)", async () => {
		const w = await riskWorld();

		w.manager.stopForUid("u1");

		expect(w.present()).toEqual(["u2:live_room_restricted"]);
	});

	// 验红:把 stopForUid 里的 `clearMonitorProblems(uid)` 挪回 `session?.cancel()` 之后,这条红
	// (u1 自己那条先带着私聊冒出来、随即又被静默清掉 —— 主人会为一位刚关掉的 UP 收到一句「监听停了」)。
	it("stopForUid:这位 UP 自己压在风控底下的停监不冒出来(先静默清、再 cancel),别的房间的照样冒", async () => {
		const w = await riskWorld();
		// u1 的会话在长尾里:早先报过一次停监(风控开着,存着没报),这一路预检又被拦着
		w.layers.reportFailure({
			externalId: "u1",
			code: "live_monitor_stopped",
			message: "房间停了",
			notify: true,
			lasting: true,
		});
		expect(w.present()).toEqual(["risk_controlled"]);

		w.manager.stopForUid("u1");

		expect(w.calls.filter((c) => c.startsWith("report:"))).toEqual([
			"report:u2:live_room_restricted",
		]);
		expect(w.present()).toEqual(["u2:live_room_restricted"]);
	});
});
