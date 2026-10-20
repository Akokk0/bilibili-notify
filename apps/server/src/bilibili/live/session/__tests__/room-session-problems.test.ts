import { describe, expect, it } from "vite-plus/test";
import { PROBLEM_TEXTS } from "../../../problem-texts.js";
import { LiveRoomAccessDeniedError, LiveRoomPreflightBlockedError } from "../room-helpers.js";
import { makeRecordedFailure, makeSessionHarness } from "./support/room-session.js";

const blocked = () => new LiveRoomPreflightBlockedError("B 站返回 code=-352");

describe("预检被风控拦:按 live:<uid> 一路报,这一路下一次结果不是风控拦截就清", () => {
	it("bootstrap 被拦:报 live:u1 的风控;长尾重试连上了:清掉", async () => {
		const h = makeSessionHarness();
		h.startLiveRoomListener.mockRejectedValueOnce(blocked()).mockResolvedValue(true);
		await h.bootstrap();
		expect(h.problems.reportRisk).toHaveBeenCalledWith("live:u1", { notify: false });
		expect(h.problems.resolveRisk).not.toHaveBeenCalled();
		await h.runTimeouts();
		expect(h.problems.resolveRisk).toHaveBeenCalledWith("live:u1", undefined);
	});

	it("bootstrap 没被拦(连上了):先清这一路的风控", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		expect(h.problems.resolveRisk).toHaveBeenCalledWith("live:u1", undefined);
		expect(h.problems.reportRisk).not.toHaveBeenCalled();
	});

	it("风控之后同一路换了方式失败(预检过了但建连回假):风控当场清掉,不等会话结束", async () => {
		const h = makeSessionHarness();
		h.startLiveRoomListener.mockRejectedValueOnce(blocked()).mockResolvedValue(false);
		await h.bootstrap();
		await h.runTimeouts();
		expect(h.problems.resolveRisk).toHaveBeenCalledWith("live:u1", { notify: false });
	});

	it("风控之后建连一路失败直到五档用完:表里最终是这个房间的「停止监听」", async () => {
		const h = makeSessionHarness();
		h.startLiveRoomListener.mockRejectedValueOnce(blocked()).mockResolvedValue(false);
		await h.bootstrap();
		await h.flushTimeouts();
		expect(h.problems.reportFailure).toHaveBeenLastCalledWith(
			expect.objectContaining({ externalId: "u1", code: "live_monitor_stopped" }),
		);
	});

	it("cancel():这一路挂着的风控清掉(会话结束)", async () => {
		const h = makeSessionHarness();
		h.startLiveRoomListener.mockRejectedValue(blocked());
		await h.bootstrap();
		h.problems.resolveRisk.mockClear();
		h.session.cancel();
		expect(h.problems.resolveRisk).toHaveBeenCalledWith("live:u1", { notify: false });
	});

	it("bootstrap 预检过了但建连回假(没连上):清风控不算解除(notify: false)", async () => {
		const h = makeSessionHarness();
		h.startLiveRoomListener.mockResolvedValue(false);
		await h.bootstrap();
		expect(h.problems.resolveRisk).toHaveBeenCalledWith("live:u1", { notify: false });
		expect(h.problems.resolveRisk).not.toHaveBeenCalledWith("live:u1");
	});

	it("bootstrap 连上了:清风控是真解除(不带 notify)", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		expect(h.problems.resolveRisk.mock.calls).toEqual([["live:u1", undefined]]);
	});

	it("bootstrap 抛了别的异常:清风控不算解除(notify: false),异常照旧往外抛", async () => {
		const h = makeSessionHarness({
			listener: async () => {
				throw new Error("别的异常");
			},
		});
		await expect(h.session.bootstrap()).rejects.toThrow("别的异常");
		expect(h.problems.resolveRisk).toHaveBeenCalledWith("live:u1", { notify: false });
	});

	it("重连:没连上不算解除,连上了才是真解除", async () => {
		const h = makeSessionHarness();
		h.startLiveRoomListener
			.mockRejectedValueOnce(blocked())
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);
		await h.bootstrap();
		await h.runTimeouts();
		expect(h.problems.resolveRisk.mock.calls.at(-1)).toEqual(["live:u1", { notify: false }]);
		await h.runTimeouts();
		expect(h.problems.resolveRisk.mock.calls.at(-1)).toEqual(["live:u1", undefined]);
	});

	it("重连途中又被拦:再报一次(幂等),不当作新的一路", async () => {
		const h = makeSessionHarness();
		h.startLiveRoomListener.mockRejectedValue(blocked());
		await h.bootstrap();
		await h.runTimeouts();
		expect(h.problems.reportRisk.mock.calls.map((call) => call[0])).toEqual(["live:u1", "live:u1"]);
	});
});

describe("受限房:报 live_room_restricted,不跑退避", () => {
	it("bootstrap 遇到受限房:先清风控、再报受限房(lasting、带文案里的 notify 与恢复说法)", async () => {
		const denied = new LiveRoomAccessDeniedError("B 站返回 code=-400 message=room is encrypted");
		const h = makeSessionHarness({ listener: async () => Promise.reject(denied) });
		await h.bootstrap();
		expect(h.problems.resolveRisk).toHaveBeenCalledWith("live:u1", { notify: false });
		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				externalId: "u1",
				code: "live_room_restricted",
				lasting: true,
			}),
		);
	});

	it("重连时遇到受限房:报受限房,停监测", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.startLiveRoomListener.mockRejectedValue(
			new LiveRoomAccessDeniedError("B 站返回 code=-400 message=room is encrypted"),
		);
		const reconnect = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		await h.runTimeouts();
		await reconnect;
		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({ externalId: "u1", code: "live_room_restricted" }),
		);
		expect(h.closeListener).toHaveBeenCalledWith("r1");
	});
});

describe("房间不监听了:报 live_monitor_stopped(lasting),原因各取一条", () => {
	it("弹幕连接没建起来(startLiveRoomListener 回假):原因是「弹幕连接建立失败」", async () => {
		const h = makeSessionHarness({ listener: async () => false });
		await h.bootstrap();
		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			makeRecordedFailure("u1", "r1", PROBLEM_TEXTS.liveStopReasons.danmakuConnect()),
		);
		expect(h.closeListener).toHaveBeenCalledWith("r1");
	});

	it("连上后首次取房间信息失败:原因是「取直播间信息失败」", async () => {
		const h = makeSessionHarness({ roomInfo: async () => undefined });
		await h.bootstrap();
		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			makeRecordedFailure("u1", "r1", PROBLEM_TEXTS.liveStopReasons.roomInfo()),
		);
		expect(h.closeListener).toHaveBeenCalledWith("r1");
	});

	it("重连五档用完放弃:原因是「连接持续失败，重试 5 次后放弃」,不走组件告警", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.startLiveRoomListener.mockRejectedValue(new Error("network down"));
		const reconnect = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		await h.flushTimeouts();
		await reconnect;
		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			makeRecordedFailure("u1", "r1", PROBLEM_TEXTS.liveStopReasons.gaveUp()),
		);
	});

	it("房间重新监听上了(初始房态拉到):普通的清「停止监听」(不带 notify),受限房同理在弹幕连上时清", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		expect(h.problems.resolveFailure.mock.calls).toEqual([
			[{ externalId: "u1", code: "live_room_restricted" }],
			[{ externalId: "u1", code: "live_monitor_stopped" }],
		]);
	});

	it("连不上的房间不清「停止监听」(还没监听上)", async () => {
		const h = makeSessionHarness({ listener: async () => false });
		await h.bootstrap();
		expect(h.problems.resolveFailure).not.toHaveBeenCalledWith({
			externalId: "u1",
			code: "live_monitor_stopped",
		});
	});
});
