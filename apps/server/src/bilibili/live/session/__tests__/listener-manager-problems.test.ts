import { describe, expect, it } from "vite-plus/test";
import { LiveRoomAccessDeniedError } from "../room-helpers.js";
import { makeListenerManagerHarness } from "./support/listener-manager.js";

describe("ListenerManager 的问题清理", () => {
	it("对照:受限房的 UP 起来之后,表里有他的「受限」", async () => {
		const h = makeListenerManagerHarness({
			listener: async () => Promise.reject(new LiveRoomAccessDeniedError("B 站拒绝弹幕连接")),
		});
		await h.sync(["u1"]);
		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({ externalId: "u1", code: "live_room_restricted" }),
		);
	});

	it("stopForUid(关开关、退订):只清这位 UP 的,别人的还在", async () => {
		const h = makeListenerManagerHarness();
		await h.sync(["u1", "u2"]);
		h.problems.reportFailure.mockClear();
		h.problems.resolveFailure.mockClear();

		h.manager.stop("u1");

		expect(h.closeListener).toHaveBeenCalledWith("100");
		expect(h.problems.resolveFailure.mock.calls).toEqual([
			[{ externalId: "u1", code: "live_monitor_stopped" }, { notify: false }],
			[{ externalId: "u1", code: "live_room_restricted" }, { notify: false }],
		]);
		expect(h.problems.resolveFailure).not.toHaveBeenCalledWith(
			{ externalId: "u2", code: "live_monitor_stopped" },
			{ notify: false },
		);
	});

	it("disposeAll(引擎停下、登录失效拆会话):全清", async () => {
		const h = makeListenerManagerHarness();
		await h.sync(["u1", "u2"]);
		h.manager.dispose();
		expect(h.closeListener).toHaveBeenCalledWith("100");
		expect(h.closeListener).toHaveBeenCalledWith("200");
		expect(h.problems.resolveFailure.mock.calls.slice(-4)).toEqual([
			[{ externalId: "u1", code: "live_monitor_stopped" }, { notify: false }],
			[{ externalId: "u1", code: "live_room_restricted" }, { notify: false }],
			[{ externalId: "u2", code: "live_monitor_stopped" }, { notify: false }],
			[{ externalId: "u2", code: "live_room_restricted" }, { notify: false }],
		]);
	});

	it("startAll(整批重建):旧会话的先清掉,不留到新一轮", async () => {
		const h = makeListenerManagerHarness();
		await h.sync(["u1"]);
		h.problems.resolveFailure.mockClear();

		await h.sync([]);
		await h.sync(["u1"]);

		expect(h.problems.resolveFailure).toHaveBeenCalledWith(
			{ externalId: "u1", code: "live_monitor_stopped" },
			{ notify: false },
		);
		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(2);
	});
});
