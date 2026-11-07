import { fail, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LiveRoomAccessDeniedError } from "../room-helpers.js";
import { makeRoomSessionCoordinatorHarness } from "./support/room-session-coordinator.js";

describe("RoomSessionCoordinator 的问题清理", () => {
	it("房号解析失败时 warn 带失败码与 message", async () => {
		const h = makeRoomSessionCoordinatorHarness();
		h.ctx.api.fetchUserInfo = vi.fn(async () => fail("rate_limited", "被限流"));
		const warn = vi.spyOn(h.ctx.logger, "warn");

		await h.sync(["u1"]);

		expect(warn).toHaveBeenCalledWith("直播间号解析失败", {
			externalId: "u1",
			code: "rate_limited",
			message: "被限流",
		});
		h.manager.dispose();
	});

	it("对照:受限房的 UP 起来之后,表里有他的「受限」", async () => {
		const h = makeRoomSessionCoordinatorHarness({
			listener: async () => Promise.reject(new LiveRoomAccessDeniedError("B 站拒绝弹幕连接")),
		});
		await h.sync(["u1"]);
		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({ externalId: "u1", code: "live_room_restricted" }),
		);
	});

	it("stopForUid(关开关、退订):只清这位 UP 的,别人的还在", async () => {
		const h = makeRoomSessionCoordinatorHarness();
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

	it("disposeAll(直播监听停下、登录失效拆会话):全清", async () => {
		const h = makeRoomSessionCoordinatorHarness();
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
		const h = makeRoomSessionCoordinatorHarness();
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

describe("RoomSessionCoordinator 未开通直播间的问题", () => {
	it("开着直播推送但房号解析为 not_found 时,报在这位 UP 名下且只进表", async () => {
		const h = makeRoomSessionCoordinatorHarness();
		h.ctx.api.fetchUserInfo = vi.fn(async () => fail("not_found", "没开通直播间"));

		await h.sync(["u1"]);

		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				externalId: "u1",
				code: "live_room_not_found",
				notify: false,
				lasting: true,
			}),
		);
		const failure = h.problems.reportFailure.mock.calls[0]?.[0] as { message: () => string };
		expect(failure.message()).toBe("该 UP 还没开通直播间，直播推送收不到");
		h.manager.dispose();
	});

	it("关掉直播推送(人还在名单里、monitorsLive 翻成 false)时静默清掉", async () => {
		const h = makeRoomSessionCoordinatorHarness();
		h.ctx.api.fetchUserInfo = vi.fn(async () => fail("not_found", "没开通直播间"));
		await h.sync(["u1"]);
		h.problems.resolveFailure.mockClear();

		await h.manager.sync([{ externalId: "u1", features: new Set(["post"]), monitorsLive: false }]);
		await h.settle();

		expect(h.problems.resolveFailure).toHaveBeenCalledWith(
			{ externalId: "u1", code: "live_room_not_found" },
			{ notify: false },
		);
		h.manager.dispose();
	});

	// 停用与删掉在这一层是同一个输入:sourceSubscriptionViews 只收 enabled 的订阅
	// (subscriptions/source-subscriptions.ts 的 `!sub.enabled` 跳过),停用的和删掉的都从视图里消失。
	it("订阅停用或删掉、人从视图里消失时静默清掉", async () => {
		const h = makeRoomSessionCoordinatorHarness();
		h.ctx.api.fetchUserInfo = vi.fn(async () => fail("not_found", "没开通直播间"));
		await h.sync(["u1"]);
		h.problems.resolveFailure.mockClear();

		await h.manager.sync([]);
		await h.settle();

		expect(h.problems.resolveFailure).toHaveBeenCalledWith(
			{ externalId: "u1", code: "live_room_not_found" },
			{ notify: false },
		);
		h.manager.dispose();
	});

	it("之后房号解析成功时清掉", async () => {
		const h = makeRoomSessionCoordinatorHarness();
		h.ctx.api.fetchUserInfo = vi
			.fn()
			.mockResolvedValueOnce(fail("not_found", "没开通直播间"))
			.mockResolvedValueOnce(ok({ data: { live_room: { roomid: 100 } } }));
		await h.sync(["u1"]);
		h.problems.resolveFailure.mockClear();

		await h.sync(["u1"]);

		expect(h.problems.resolveFailure).toHaveBeenCalledWith({
			externalId: "u1",
			code: "live_room_not_found",
		});
		h.manager.dispose();
	});

	it("没开直播推送、不在监听名单里时不报", async () => {
		const h = makeRoomSessionCoordinatorHarness();
		h.ctx.api.fetchUserInfo = vi.fn(async () => fail("not_found", "没开通直播间"));

		await h.manager.sync([
			{ externalId: "u1", features: new Set(["liveStart"]), monitorsLive: false },
		]);
		await h.settle();

		expect(h.ctx.api.fetchUserInfo).not.toHaveBeenCalled();
		expect(h.problems.reportFailure).not.toHaveBeenCalled();
		h.manager.dispose();
	});
});

describe("RoomSessionCoordinator 房号解析长尾重试", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("风控只报一次,按 60s / 5m 重试,成功后真解除并起会话", async () => {
		const h = makeRoomSessionCoordinatorHarness();
		const fetchUserInfo = vi
			.fn()
			.mockResolvedValueOnce(fail("rate_limited", "被限流"))
			.mockResolvedValueOnce(fail("rate_limited", "仍被限流"))
			.mockResolvedValueOnce(ok({ data: { live_room: { roomid: 100 } } }));
		h.ctx.api.fetchUserInfo = fetchUserInfo;

		await h.sync(["u1"]);
		expect(h.problems.reportRisk).toHaveBeenCalledWith("live:u1", { notify: false });
		expect(h.problems.reportRisk).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60_000);
		await h.settle();
		expect(fetchUserInfo).toHaveBeenCalledTimes(2);
		expect(h.problems.reportRisk).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(300_000);
		await h.settle();
		expect(fetchUserInfo).toHaveBeenCalledTimes(3);
		expect(h.problems.resolveRisk).toHaveBeenCalledWith("live:u1");
		expect(h.startLiveRoomListener).toHaveBeenCalledWith(
			"100",
			expect.any(Function),
			expect.any(Function),
		);
		h.manager.dispose();
	});

	it("长尾用尽后仍每 30 分钟重试,不放弃", async () => {
		const h = makeRoomSessionCoordinatorHarness();
		const fetchUserInfo = vi.fn(async () => fail("rate_limited", "持续被限流"));
		h.ctx.api.fetchUserInfo = fetchUserInfo;

		await h.sync(["u1"]);
		for (const delay of [60_000, 300_000, 900_000, 1_800_000, 1_800_000]) {
			await vi.advanceTimersByTimeAsync(delay);
			await h.settle();
		}

		expect(fetchUserInfo).toHaveBeenCalledTimes(6);
		expect(h.problems.reportRisk).toHaveBeenCalledTimes(1);
		h.manager.dispose();
	});

	it("stop 收掉排着的重试,并按不再适用清掉房号解析报的风控", async () => {
		const h = makeRoomSessionCoordinatorHarness();
		const fetchUserInfo = vi.fn(async () => fail("rate_limited", "被限流"));
		h.ctx.api.fetchUserInfo = fetchUserInfo;

		await h.sync(["u1"]);
		h.manager.stop("u1");
		expect(h.problems.resolveRisk).toHaveBeenCalledWith("live:u1", { notify: false });

		await vi.advanceTimersByTimeAsync(3_600_000);
		await h.settle();
		expect(fetchUserInfo).toHaveBeenCalledTimes(1);
	});

	it("名单移出这个人时和 stop 一样收定时器并静默清风控", async () => {
		const h = makeRoomSessionCoordinatorHarness();
		const fetchUserInfo = vi.fn(async () => fail("rate_limited", "被限流"));
		h.ctx.api.fetchUserInfo = fetchUserInfo;

		await h.sync(["u1"]);
		await h.sync([]);
		expect(h.problems.resolveRisk).toHaveBeenCalledWith("live:u1", { notify: false });

		await vi.advanceTimersByTimeAsync(3_600_000);
		await h.settle();
		expect(fetchUserInfo).toHaveBeenCalledTimes(1);
	});

	it("没开通直播间不排重试", async () => {
		const h = makeRoomSessionCoordinatorHarness();
		const fetchUserInfo = vi.fn(async () => fail("not_found", "没开通直播间"));
		h.ctx.api.fetchUserInfo = fetchUserInfo;

		await h.sync(["u1"]);
		await vi.advanceTimersByTimeAsync(3_600_000);
		await h.settle();

		expect(fetchUserInfo).toHaveBeenCalledTimes(1);
		expect(h.problems.reportRisk).not.toHaveBeenCalled();
	});

	it("重试后确认没开通直播间时收掉旧风控与重试", async () => {
		const h = makeRoomSessionCoordinatorHarness();
		const fetchUserInfo = vi
			.fn()
			.mockResolvedValueOnce(fail("rate_limited", "被限流"))
			.mockResolvedValueOnce(fail("not_found", "没开通直播间"));
		h.ctx.api.fetchUserInfo = fetchUserInfo;

		await h.sync(["u1"]);
		await vi.advanceTimersByTimeAsync(60_000);
		await h.settle();

		expect(fetchUserInfo).toHaveBeenCalledTimes(2);
		expect(h.problems.resolveRisk).toHaveBeenCalledWith("live:u1", { notify: false });
		await vi.advanceTimersByTimeAsync(3_600_000);
		await h.settle();
		expect(fetchUserInfo).toHaveBeenCalledTimes(2);
	});

	it("暂时不可用时排重试,但只记日志不报问题", async () => {
		const h = makeRoomSessionCoordinatorHarness();
		const fetchUserInfo = vi
			.fn()
			.mockResolvedValueOnce(fail("unavailable", "接口短暂不可用"))
			.mockResolvedValueOnce(ok({ data: { live_room: { roomid: 100 } } }));
		h.ctx.api.fetchUserInfo = fetchUserInfo;

		await h.sync(["u1"]);
		expect(h.problems.reportRisk).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60_000);
		await h.settle();

		expect(fetchUserInfo).toHaveBeenCalledTimes(2);
		expect(h.problems.reportRisk).not.toHaveBeenCalled();
		h.manager.dispose();
	});
});
