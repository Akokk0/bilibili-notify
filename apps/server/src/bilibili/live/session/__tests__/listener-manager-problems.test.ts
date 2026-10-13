/**
 * `ListenerManager` 收拾会话时,问题表里关于这些 UP 的「停止监听 / 受限」一并静默清掉(不补「已恢复」):
 * 这个人不再需要监听了(关开关、退订、引擎停下、登录失效拆会话、整批重建),他的问题就不再成立。
 * 用**真 ListenerManager + 真上报器 + 记录用的假核心**:一个连不上弹幕的 UP 先把「受限」报上去,再看收拾之后表里还有没有。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { SubItemView } from "../../push-like";
import { ListenerManager } from "../listener-manager";
import type { RoomContextOptions } from "../room-context";
import { makeRecordingLayers } from "./support/live-problems";

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

/** 起一个管理器:每个房间的弹幕预检都回一个没有 token 的体,于是 bootstrap 一跑就报一条受限房。 */
function setup() {
	const { layers, present } = makeRecordingLayers();
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
			fetchLiveRoomInfoStreamKey: vi.fn(async () => ({ code: 0, data: {} })),
		},
		push: {},
		problems: layers,
		contentBuilder: {},
		templateRenderer: {},
		wordcloudGenerator: {},
		liveSummaryRequester: {},
		danmakuCollector: { register() {}, clear() {}, clearAll() {} },
		getImageRenderer: () => null,
		config: {},
		emitEngineError: vi.fn(),
		emitLiveState: vi.fn(),
	} as unknown as RoomContextOptions);
	const settle = async () => {
		for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
	};
	return { manager, present, settle };
}

describe("ListenerManager 收拾会话 · 问题表里关于这些 UP 的问题静默清掉", () => {
	it("对照:受限房的 UP 起来之后,表里有他的「受限」", async () => {
		const { manager, present, settle } = setup();
		manager.startForUid(makeSub("u1"));
		await settle();
		expect(present()).toEqual(["u1:live_room_restricted"]);
	});

	// 验红:删掉 listener-manager.ts `stopForUid` 里的 `clearMonitorProblems`,这条红。
	it("stopForUid(关开关、退订):只清这位 UP 的,别人的还在", async () => {
		const { manager, present, settle } = setup();
		manager.startForUid(makeSub("u1"));
		manager.startForUid(makeSub("u2"));
		await settle();
		expect(present()).toEqual(["u1:live_room_restricted", "u2:live_room_restricted"]);

		manager.stopForUid("u1");
		expect(present()).toEqual(["u2:live_room_restricted"]);
	});

	// 验红:删掉 `disposeAll` 里的 `clearProblemsOfAll`,这条红。
	it("disposeAll(引擎停下、登录失效拆会话):全清", async () => {
		const { manager, present, settle } = setup();
		manager.startForUid(makeSub("u1"));
		manager.startForUid(makeSub("u2"));
		await settle();

		manager.disposeAll();
		expect(present()).toEqual([]);
	});

	// 验红:删掉 `startAll` 里的 `clearProblemsOfAll`,这条红(旧会话的问题被带进了新一轮)。
	it("startAll(整批重建):旧会话的先清掉,不留到新一轮", async () => {
		const { manager, present, settle } = setup();
		manager.startForUid(makeSub("u1"));
		await settle();
		expect(present()).toEqual(["u1:live_room_restricted"]);

		// 重建的名单里已经没有 u1
		manager.startAll({});
		expect(present()).toEqual([]);
	});
});
