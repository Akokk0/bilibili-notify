import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeSessionHarness } from "./support/room-session.js";

const LIVE_ROOM = {
	uid: 1,
	room_id: 1,
	live_status: 1,
	live_time: "2026-01-01 10:00:00",
	title: "标题",
	user_cover: "",
	keyframe: "",
	area_name: "分区",
};
const OFFLINE_ROOM = {
	...LIVE_ROOM,
	live_status: 0,
	live_time: "0000-00-00 00:00:00",
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000_000);
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("bootstrap() 期间到达的下播事件", () => {
	it("装好 WS 到翻状态之间收到 END → 不翻成在播", async () => {
		const h = makeSessionHarness();
		h.setRoomInfo(async () => {
			await h.dispatch({ kind: "live-end" });
			return LIVE_ROOM;
		});

		await h.bootstrap();

		expect(h.reports).toEqual([]);
		expect(h.reportedLive).toBe(false);
	});

	it("期间真开播不能被去重吞掉 —— 否则换来一个反向的永久卡死", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let call = 0;
		const h = makeSessionHarness({
			roomInfo: async () => {
				call++;
				if (call === 1) {
					await gate;
					return OFFLINE_ROOM;
				}
				return LIVE_ROOM;
			},
		});

		const bootstrap = h.session.bootstrap();
		await h.settle();
		await h.dispatch({ kind: "live-start" });
		release();
		await bootstrap;

		expect(h.reports).toEqual([
			{
				externalId: "u1",
				report: expect.objectContaining({ kind: "start" }),
			},
		]);
		expect(h.reportedLive).toBe(true);
	});

	it("没有 END 时照常翻成在播 —— 守卫不能把正常路径也一并挡掉", async () => {
		const h = makeSessionHarness({ roomInfo: async () => LIVE_ROOM });
		await h.bootstrap();
		expect(h.reports).toEqual([
			{
				externalId: "u1",
				report: expect.objectContaining({ kind: "status", isLive: true }),
			},
		]);
		expect(h.reportedLive).toBe(true);
	});
});

describe("onLiveStart 准备期间到达的下播事件", () => {
	it("刷新房间信息期间收到 END → 不翻成在播", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.setRoomInfo(async () => {
			await h.dispatch({ kind: "live-end" });
			return LIVE_ROOM;
		});

		await h.dispatch({ kind: "live-start" });

		expect(h.reports).toEqual([]);
		expect(h.reportedLive).toBe(false);
	});

	it("落在 END 冷却期里的那条也算数 —— 冷却是给重复帧用的,不是给新一场用的", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		await h.dispatch({ kind: "live-end" });
		h.setRoomInfo(async () => {
			await h.dispatch({ kind: "live-end" });
			return LIVE_ROOM;
		});

		await h.dispatch({ kind: "live-start" });

		expect(h.reports).toEqual([]);
		expect(h.reportedLive).toBe(false);
	});

	it("没有 END 时照常开播并推卡", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.setRoomInfo(async () => LIVE_ROOM);

		await h.dispatch({ kind: "live-start" });

		expect(h.reports).toEqual([
			{
				externalId: "u1",
				report: expect.objectContaining({ kind: "start" }),
			},
		]);
		expect(h.reportedLive).toBe(true);
	});
});

describe("开播 / 下播的重复与失败守卫", () => {
	it("冷却期内(lastLiveStart 刚刷新)→ 忽略,不拉房间信息", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.setRoomInfo(async () => LIVE_ROOM);
		await h.dispatch({ kind: "live-start" });
		const fetches = h.fetchRoomInfo.mock.calls.length;
		h.setReportedLive(false);
		await h.dispatch({ kind: "live-start" });
		expect(h.fetchRoomInfo).toHaveBeenCalledTimes(fetches);
	});

	it("已是开播状态(liveStatus=true)→ 忽略重复开播", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.setReportedLive(true);
		await h.dispatch({ kind: "live-start" });
		expect(h.fetchRoomInfo).toHaveBeenCalledTimes(1);
	});

	it("拉直播间信息失败(useLiveRoomInfo=false)→ stopMonitoring,不推卡", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.setRoomInfo(async () => undefined);
		await h.dispatch({ kind: "live-start" });
		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({ code: "live_monitor_stopped" }),
		);
		expect(h.closeListener).toHaveBeenCalledWith("r1");
	});

	it("冷却期内 → 忽略,不调 handleLiveEnd", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		await h.dispatch({ kind: "live-end" });
		h.setReportedLive(true);
		await h.dispatch({ kind: "live-end" });
		expect(h.reports).toEqual([]);
	});
});
