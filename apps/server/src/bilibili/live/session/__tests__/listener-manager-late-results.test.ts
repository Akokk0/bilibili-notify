import { describe, expect, it } from "vite-plus/test";
import { LiveRoomAccessDeniedError, LiveRoomPreflightBlockedError } from "../room-helpers.js";
import { deferred, makeListenerManagerHarness } from "./support/listener-manager.js";
import { makeRecordingLayers } from "./support/live-problems.js";

describe("预检在途时会话被停掉,迟到的结果不上报", () => {
	it("对照:不停会话,预检回「被拦」→ 表里有这一路风控", async () => {
		const h = makeListenerManagerHarness({
			listener: async () => Promise.reject(new LiveRoomPreflightBlockedError("B 站返回 code=-352")),
		});
		await h.sync(["u1"]);
		expect(h.problems.reportRisk).toHaveBeenCalledWith("live:u1", { notify: false });
	});

	it("停掉这位 UP 之后才放行「被拦」:没有风控路留下,之后别的失败照常进表", async () => {
		const gate = deferred<boolean>();
		const h = makeListenerManagerHarness({ listener: async () => gate.promise });
		const sync = h.sync(["u1"]);
		await h.settle();
		h.manager.stop("u1");
		h.problems.reportRisk.mockClear();
		gate.reject(new LiveRoomPreflightBlockedError("B 站返回 code=-352"));
		await sync;
		expect(h.problems.reportRisk).not.toHaveBeenCalled();
	});

	it("对照:不停会话,预检回「没有 token」→ 表里有这个房间的「受限」", async () => {
		const h = makeListenerManagerHarness({
			listener: async () => {
				throw new LiveRoomAccessDeniedError("B 站未返回弹幕 token");
			},
		});
		await h.sync(["u1"]);
		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({ externalId: "u1", code: "live_room_restricted" }),
		);
	});

	it("停掉这位 UP 之后才放行「受限」:表里不多一条,也没有上报过", async () => {
		const gate = deferred<boolean>();
		const h = makeListenerManagerHarness({ listener: async () => gate.promise });
		const sync = h.sync(["u1"]);
		await h.settle();
		h.manager.stop("u1");
		h.problems.reportFailure.mockClear();
		gate.reject(new LiveRoomAccessDeniedError("B 站未返回弹幕 token"));
		await sync;
		expect(h.problems.reportFailure).not.toHaveBeenCalled();
	});

	it("对照:不停会话,预检过了但建连没成(取个人信息失败)→ 表里有「停止监听」", async () => {
		const h = makeListenerManagerHarness({ listener: async () => false });
		await h.sync(["u1"]);
		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({ externalId: "u1", code: "live_monitor_stopped" }),
		);
	});

	it("停掉这位 UP 之后才放行「没连上」:表里不多一条,也没有上报过", async () => {
		const gate = deferred<boolean>();
		const h = makeListenerManagerHarness({ listener: async () => gate.promise });
		const sync = h.sync(["u1"]);
		await h.settle();
		h.manager.stop("u1");
		h.problems.reportFailure.mockClear();
		gate.resolve(false);
		await sync;
		expect(h.problems.reportFailure).not.toHaveBeenCalled();
	});

	it("对照:不停会话,连上后取房间信息失败 → 表里有「停止监听」", async () => {
		const gate = deferred<Record<string, unknown> | undefined>();
		const h = makeListenerManagerHarness({ roomInfo: async () => gate.promise });
		const sync = h.sync(["u1"]);
		await h.settle();
		gate.resolve(undefined);
		await sync;
		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({ externalId: "u1", code: "live_monitor_stopped" }),
		);
	});

	it("连上之后、取房间信息在途时停掉:迟到的失败不上报", async () => {
		const gate = deferred<Record<string, unknown> | undefined>();
		const h = makeListenerManagerHarness({ roomInfo: async () => gate.promise });
		const sync = h.sync(["u1"]);
		await h.settle();
		h.manager.stop("u1");
		h.problems.reportFailure.mockClear();
		gate.resolve(undefined);
		await sync;
		expect(h.problems.reportFailure).not.toHaveBeenCalled();
	});

	it("整批停掉(disposeAll)之后才放行:同样什么都不报", async () => {
		const gate = deferred<boolean>();
		const h = makeListenerManagerHarness({ listener: async () => gate.promise });
		const first = h.sync(["u1"]);
		const second = h.sync(["u2"]);
		await h.settle();
		h.manager.dispose();
		h.problems.reportFailure.mockClear();
		h.problems.reportRisk.mockClear();
		gate.reject(new LiveRoomPreflightBlockedError("B 站返回 code=-352"));
		await Promise.all([first, second]);
		expect(h.problems.reportFailure).not.toHaveBeenCalled();
		expect(h.problems.reportRisk).not.toHaveBeenCalled();
	});
});

describe("整批停掉 / 重建时的次序:先静默清问题,再 cancel", () => {
	async function riskWorld() {
		const recording = makeRecordingLayers();
		const h = makeListenerManagerHarness({
			problems: recording.layers,
			listener: async (roomId) => {
				if (roomId === "100") {
					throw new LiveRoomPreflightBlockedError("B 站返回 code=-352");
				}
				throw new LiveRoomAccessDeniedError("B 站未返回弹幕 token");
			},
		});
		await h.sync(["u1", "u2"]);
		expect(recording.present()).toEqual(["risk_controlled"]);
		return { ...h, recording };
	}

	it("disposeAll(登录失效拆会话):风控清掉时压在底下的别的房间问题不冒出来(冒出来就会私聊一句马上作废的话)", async () => {
		const h = await riskWorld();
		h.manager.dispose();
		await h.settle();
		expect(h.recording.present()).toEqual([]);
	});

	it("startAll(整批重建):同样不冒出来", async () => {
		const h = await riskWorld();
		await h.manager.sync([]);
		expect(h.recording.present()).toEqual([]);
	});

	it("对照:只停风控那一位(stopForUid):风控清掉,压在底下的别的房间问题冒出来(它还监听着,问题仍成立)", async () => {
		const h = await riskWorld();
		h.manager.stop("u1");
		await h.settle();
		expect(h.recording.present()).toEqual(["u2:live_room_restricted"]);
	});

	it("stopForUid:这位 UP 自己压在风控底下的停监不冒出来(先静默清、再 cancel),别的房间的照样冒", async () => {
		const h = await riskWorld();
		h.recording.layers.reportFailure({
			externalId: "u1",
			code: "live_monitor_stopped",
			message: () => "房间停了",
			notify: true,
			lasting: true,
		});
		h.manager.stop("u1");
		await h.settle();
		expect(h.recording.present()).toEqual(["u2:live_room_restricted"]);
	});
});
