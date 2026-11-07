import { afterEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../../../i18n/index.js";
import { PROBLEM_TEXTS } from "../../../problem-texts.js";
import { LiveRoomAccessDeniedError, LiveRoomPreflightBlockedError } from "../room-helpers.js";
import { makeSessionHarness } from "./support/room-session.js";

describe("RoomSession.cancel() — P1-C 短期-c", () => {
	it("cancel() 之后触发 onError 不重连(直接 return,不动 startLiveRoomListener / emitPipelineError)", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.session.cancel();
		h.closeListener.mockClear();
		h.startLiveRoomListener.mockClear();

		await h.dispatch({ kind: "error", error: new Error("closed") });

		expect(h.closeListener).not.toHaveBeenCalled();
		expect(h.startLiveRoomListener).not.toHaveBeenCalled();
		expect(h.timeoutDelays).toEqual([]);
	});

	it("sleep 期间 cancel() → 醒来时 cancelled 命中,不调 startLiveRoomListener", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.closeListener.mockClear();
		h.startLiveRoomListener.mockClear();

		const reconnect = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		expect(h.timeoutDelays).toEqual([1_000]);
		h.session.cancel();
		await reconnect;

		expect(h.startLiveRoomListener).not.toHaveBeenCalled();
		expect(h.timeouts[0]?.disposed).toBe(true);
	});

	it("无 cancel 时 sleep 后正常发起 startLiveRoomListener", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.startLiveRoomListener.mockClear();

		const reconnect = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		await h.runTimeouts();
		await reconnect;

		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(1);
	});
});

describe("RoomSession 退避状态机 — codex review minor-4", () => {
	it("连续失败 5 次 → 退避序列 = [1000, 2000, 4000, 8000, 16000]", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.timeoutDelays.length = 0;
		h.startLiveRoomListener.mockRejectedValue(new Error("network blip"));

		const reconnect = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		await h.flushTimeouts();
		await reconnect;

		expect(h.timeoutDelays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
	});

	it("第 6 次失败时退避耗尽 → 报「停止监听」(lasting)+ 不再 schedule 新 backoff", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.startLiveRoomListener.mockRejectedValue(new Error("network blip"));

		const reconnect = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		await h.flushTimeouts();
		await reconnect;

		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(6);
		expect(h.problems.reportFailure).toHaveBeenCalledTimes(1);
		expect(h.warnings).toContainEqual([
			"直播连接持续失败，退避次数已耗尽，放弃监听",
			expect.objectContaining({ roomId: "r1", reason: "error", maxAttempts: 5 }),
		]);
		const failure = h.problems.reportFailure.mock.calls[0]?.[0];
		expect(failure?.code).toBe("live_monitor_stopped");
		expect(failure?.message()).toContain(PROBLEM_TEXTS.liveStopReasons.gaveUp());
		expect(h.timeoutDelays.filter((ms) => ms > 0)).toHaveLength(5);
	});

	it("退避耗尽彻底放弃 → 收口成下播,不留一个永远「在播」的僵尸", async () => {
		const h = makeSessionHarness({ liveStatus: 1 });
		await h.bootstrap();
		h.startLiveRoomListener.mockRejectedValue(new Error("network blip"));

		const reconnect = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		await h.flushTimeouts();
		await reconnect;

		expect(h.problems.reportFailure).toHaveBeenCalledTimes(1);
		expect(h.reportedLive).toBe(false);
		expect(h.reports.filter((entry) => (entry.report as { kind: string }).kind === "end")).toEqual([
			{
				externalId: "u1",
				report: expect.objectContaining({ kind: "end" }),
			},
		]);
	});

	it("受限房错误 → 立即停止监测,不跑满 5 档退避", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		const denied = new LiveRoomAccessDeniedError("B 站返回 code=-400 message=room is encrypted");
		h.startLiveRoomListener.mockRejectedValue(denied);

		const reconnect = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		await h.runTimeouts();
		await reconnect;

		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(2);
		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({ code: "live_room_restricted" }),
		);
		expect(h.timeoutDelays).toEqual([1_000]);
	});

	it("下播流水线自己炸了也要收口成下播 —— 这是最后一道收尾,不能再抛", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.setReportedLive(true);
		h.startLiveRoomListener.mockRejectedValue(new Error("network down"));
		h.ctx.source.reportLive = () => {
			throw new Error("推送层也挂了");
		};

		const reconnect = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		await h.flushTimeouts();
		await expect(reconnect).resolves.toBeUndefined();
		expect(h.reportedLive).toBe(false);
	});

	it("本就没在播时放弃 → 不推下播卡", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.startLiveRoomListener.mockRejectedValue(new Error("network down"));
		const reconnect = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		await h.flushTimeouts();
		await reconnect;
		expect(h.reports.filter((entry) => (entry.report as { kind: string }).kind === "end")).toEqual(
			[],
		);
	});

	it("重连成功 → reconnectAttempts 复位,下一轮 onError 从 1000ms 重新开始", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.startLiveRoomListener
			.mockRejectedValueOnce(new Error("blip 1"))
			.mockResolvedValueOnce(true)
			.mockRejectedValueOnce(new Error("blip 2"));

		const first = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		await h.flushTimeouts();
		await first;
		expect(h.timeoutDelays).toEqual([1_000, 2_000]);

		const second = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		await h.runTimeouts();
		h.session.cancel();
		await second;
		expect(h.timeoutDelays[2]).toBe(1_000);
	});
});

describe("RoomSession 重连竞态 — L1/L3", () => {
	it("L1:并发 onError 单飞 —— 只跑一轮重连(startLiveRoomListener 仅一次)", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.closeListener.mockClear();
		h.startLiveRoomListener.mockClear();

		const first = h.dispatch({ kind: "error", error: new Error("closed") });
		const second = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		expect(h.closeListener).toHaveBeenCalledTimes(1);
		expect(h.timeoutDelays).toEqual([1_000]);

		await h.flushTimeouts();
		await Promise.all([first, second]);
		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(1);
	});

	it("L3:退避 sleep 期间 cancel() → dispose 定时器并立即 unwind(不等 expiry)", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.startLiveRoomListener.mockClear();

		const reconnect = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		expect(h.timeouts).toHaveLength(1);
		expect(h.timeouts[0]?.disposed).toBe(false);

		h.session.cancel();
		await reconnect;

		expect(h.timeouts[0]?.disposed).toBe(true);
		expect(h.startLiveRoomListener).not.toHaveBeenCalled();
	});
});

describe("RoomSession 重连成功后的直播状态", () => {
	it("重连成功且房间仍在播 → 翻回 live,并重新武装周期复推", async () => {
		const h = makeSessionHarness({ liveStatus: 1 });
		h.setRoomInfo(async () => ({
			uid: 1,
			live_status: 1,
			live_time: "2026-01-01 10:00:00",
		}));
		await h.bootstrap();
		h.reports.length = 0;
		const reconnect = h.dispatch({ kind: "closed" });
		await h.settle();
		await h.runTimeouts();
		await reconnect;
		expect(h.reports.at(-1)?.report).toMatchObject({ kind: "status", isLive: true });
	});

	it("恢复时带的开播时刻仍是本场的 —— 统计侧据此认出是同一场,不新开一场", async () => {
		const h = makeSessionHarness({ liveStatus: 1 });
		h.setRoomInfo(async () => ({
			uid: 1,
			live_status: 1,
			live_time: "2026-01-01 10:00:00",
		}));
		await h.bootstrap();
		h.reports.length = 0;

		const reconnect = h.dispatch({ kind: "closed" });
		await h.settle();
		await h.runTimeouts();
		await reconnect;

		expect(h.reports.at(-1)).toEqual({
			externalId: "u1",
			report: expect.objectContaining({
				kind: "status",
				isLive: true,
				startedAt: "2026-01-01T02:00:00.000Z",
			}),
		});
	});

	it("核对期间直播真的结束了 → 不把状态翻回在播", async () => {
		const h = makeSessionHarness({ liveStatus: 1 });
		await h.bootstrap();
		h.reports.length = 0;
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		h.fetchRoomInfo.mockImplementationOnce(async () => {
			await gate;
			return {
				uid: 1,
				live_status: 1,
				live_time: "2026-01-01 10:00:00",
			};
		});

		const reconnect = h.dispatch({ kind: "closed" });
		await h.settle();
		await h.timeouts[0]?.fn();
		await h.dispatch({ kind: "live-end" });
		release();
		await reconnect;

		expect(h.reports.map((entry) => (entry.report as { kind: string }).kind)).toEqual(["end"]);
		expect(h.reportedLive).toBe(false);
	});

	it("抓封面期间收到 END → 只收口成下播,不再把状态翻回在播", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = makeSessionHarness({
			liveStatus: 1,
			fetchImage: async () => {
				await gate;
				return { ok: true as const, ref: `${"c".repeat(64)}.webp` };
			},
		});
		await h.bootstrap();
		h.reports.length = 0;
		h.setRoomInfo(async () => ({
			uid: 1,
			live_status: 1,
			live_time: "2026-01-01 10:00:00",
			keyframe: "https://i0.hdslb.com/bfs/live/keyframe.jpg",
		}));

		const reconnect = h.dispatch({ kind: "closed" });
		await h.settle();
		await h.timeouts[0]?.fn();
		await h.settle();
		await h.dispatch({ kind: "live-end" });
		release();
		await reconnect;
		for (let i = 0; i < 10; i++) await h.settle();

		expect(h.reports.map((entry) => (entry.report as { kind: string }).kind)).toEqual(["end"]);
	});

	it("重连成功但房间已经下播 → 保持 idle,不伪造一次开播", async () => {
		const h = makeSessionHarness({ liveStatus: 1 });
		await h.bootstrap();
		h.reports.length = 0;
		h.setRoomInfo(async () => ({
			uid: 1,
			live_status: 0,
			live_time: "2026-01-01 10:00:00",
		}));

		const reconnect = h.dispatch({ kind: "closed" });
		await h.settle();
		await h.runTimeouts();
		await reconnect;

		expect(h.reportedLive).toBe(false);
		expect(h.reports.at(-1)).toEqual({
			externalId: "u1",
			report: expect.objectContaining({ kind: "end" }),
		});
	});
});

describe("预检被 -352 风控拦截 → 长尾退避,不放弃", () => {
	it("bootstrap 被拦 → 按 60s 长尾排重试;风控散去后连上并补跑初始房态", async () => {
		const h = makeSessionHarness();
		h.startLiveRoomListener
			.mockRejectedValueOnce(new LiveRoomPreflightBlockedError("B 站返回 code=-352"))
			.mockResolvedValue(true);

		await h.bootstrap();
		expect(h.problems.reportFailure).not.toHaveBeenCalled();
		expect(h.timeoutDelays).toEqual([60_000]);
		expect(h.warnings).toContainEqual([
			"直播连接预检受阻，进入长尾退避，继续监测",
			{ roomId: "r1", reason: "preflight", delayMs: 60000, attempt: 1 },
		]);

		await h.runTimeouts();
		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(2);
		expect(h.fetchRoomInfo).toHaveBeenCalledTimes(1);
	});

	it("持续被拦 → 间隔 60s→300s→900s→1800s 后封顶循环,始终不放弃", async () => {
		const h = makeSessionHarness();
		h.startLiveRoomListener.mockRejectedValue(
			new LiveRoomPreflightBlockedError("B 站返回 code=-352"),
		);

		await h.bootstrap();
		for (let i = 0; i < 5; i++) await h.runTimeouts();

		expect(h.timeoutDelays).toEqual([60_000, 300_000, 900_000, 1_800_000, 1_800_000, 1_800_000]);
		expect(h.problems.reportFailure).not.toHaveBeenCalled();
	});

	it("WS 错误重连途中被拦 → 从秒级梯子转入长尾,不消耗放弃计数", async () => {
		const h = makeSessionHarness();
		await h.bootstrap();
		h.timeoutDelays.length = 0;
		h.startLiveRoomListener.mockRejectedValue(
			new LiveRoomPreflightBlockedError("B 站返回 code=-352"),
		);

		const reconnect = h.dispatch({ kind: "error", error: new Error("closed") });
		await h.settle();
		await h.runTimeouts();
		await h.runTimeouts();
		h.session.cancel();
		await reconnect;

		expect(h.timeoutDelays).toEqual([1_000, 60_000, 300_000]);
	});

	it("熬过风控连上后初始房态拉取失败 → 回长尾重试,不放弃房间", async () => {
		const h = makeSessionHarness();
		let failuresLeft = 1;
		h.startLiveRoomListener
			.mockRejectedValueOnce(new LiveRoomPreflightBlockedError("B 站返回 code=-352"))
			.mockResolvedValue(true);
		h.setRoomInfo(async () => {
			if (failuresLeft-- > 0) return undefined;
			return { uid: 1, live_status: 0, live_time: "0000-00-00 00:00:00" };
		});

		await h.bootstrap();
		await h.flushTimeouts();

		expect(h.problems.reportFailure).not.toHaveBeenCalled();
		expect(h.timeoutDelays).toEqual([60_000, 300_000]);
		expect(h.fetchRoomInfo).toHaveBeenCalledTimes(2);
	});

	it("预检拦截与普通失败交替 → 秒级计数被长尾轮复位,不烧光梯子放弃", async () => {
		const h = makeSessionHarness();
		let call = 0;
		h.startLiveRoomListener.mockImplementation(async () => {
			call++;
			if (call % 2 === 1) throw new LiveRoomPreflightBlockedError("B 站返回 code=-352");
			return false;
		});

		await h.bootstrap();
		for (let i = 0; i < 14; i++) await h.runTimeouts();

		expect(h.problems.reportFailure).not.toHaveBeenCalled();
		const seconds = h.timeoutDelays.filter((ms) => ms <= 16_000);
		expect(new Set(seconds)).toEqual(new Set([1_000]));
	});

	it("reconnect 顶层兜底:内部异常不外泄成 unhandledRejection", async () => {
		const h = makeSessionHarness({ liveStatus: 1 });
		await h.bootstrap();
		h.fetchRoomInfo.mockRejectedValueOnce(new Error("推卡渲染失败"));

		const reconnect = h.dispatch({ kind: "closed" });
		await h.settle();
		await h.runTimeouts();
		await expect(reconnect).resolves.toBeUndefined();
		expect(h.warnings.some((args) => String(args[0]).includes("重连流程内部异常"))).toBe(true);
	});

	it("bootstrap 窗口内断线重连 → 不并发第二个 bootstrapRoomState(单飞)", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = makeSessionHarness({
			roomInfo: async () => {
				await gate;
				return { uid: 1, live_status: 0, live_time: "0000-00-00 00:00:00" };
			},
		});

		const bootstrap = h.session.bootstrap();
		await h.settle();
		const reconnect = h.dispatch({ kind: "closed" });
		await h.settle();
		await h.runTimeouts();
		release();
		await reconnect;
		await bootstrap;

		expect(h.fetchRoomInfo).toHaveBeenCalledTimes(1);
	});

	it("cancel() 掐断长尾等待:句柄被 dispose,不再有后续尝试", async () => {
		const h = makeSessionHarness();
		h.startLiveRoomListener.mockRejectedValue(
			new LiveRoomPreflightBlockedError("B 站返回 code=-352"),
		);

		await h.bootstrap();
		const before = h.startLiveRoomListener.mock.calls.length;
		const waiting = h.timeouts[0];
		h.session.cancel();
		await h.runTimeouts();

		expect(waiting?.disposed).toBe(true);
		expect(h.startLiveRoomListener).toHaveBeenCalledTimes(before);
	});
});

afterEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

it("同一直播会话的重连诊断随语言切换并保留原异常，退避与请求次数不变", async () => {
	const h = makeSessionHarness();
	await h.bootstrap();
	const error = new Error("raw websocket failure", { cause: new Error("socket reset") });
	for (const [locale, message] of [
		["zh-CN", "直播连接中断，已安排退避重连"],
		["en", "Live connection interrupted; reconnect scheduled after backoff"],
		["ja", "ライブ接続が中断したため、待機後の再接続を設定しました"],
		["zh-TW", "直播連線中斷，已安排退避重新連線"],
	] as const) {
		i18n.set({ locale, voice: "maid" });
		const running = h.dispatch({ kind: "error", error });
		await h.settle();
		expect(h.warnings.at(-1)).toEqual([
			message,
			{ roomId: "r1", reason: "error", error, delayMs: 1000, attempt: 1, maxAttempts: 5 },
		]);
		const fields = h.warnings.at(-1)?.[1] as { error: Error } | undefined;
		expect(fields?.error).toBe(error);
		await h.runTimeouts();
		await running;
	}
	expect(h.timeoutDelays).toEqual([1000, 1000, 1000, 1000]);
	expect(h.startLiveRoomListener).toHaveBeenCalledTimes(5);
	expect(h.problems.reportFailure).not.toHaveBeenCalled();
	h.session.cancel();
});
