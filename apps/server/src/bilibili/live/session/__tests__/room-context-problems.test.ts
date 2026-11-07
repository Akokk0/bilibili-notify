import { ok, type ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { PROBLEM_TEXTS } from "../../../problem-texts.js";
import { RoomContext } from "../room-context.js";
import { makeLiveProblems } from "./support/live-problems.js";
import { makeSessionHarness } from "./support/room-session.js";

function makeCtx(api: Record<string, unknown> = {}) {
	const serviceCtx: ServiceContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
		signal: new AbortController().signal,
		track: () => {},
	};
	const problems = makeLiveProblems();
	const ctx = new RoomContext({
		api: api as never,
		liveContext: serviceCtx,
		source: { subscriptions: () => [] } as never,
		problems,
		roomIds: {
			get: () => undefined,
			resolve: async () => ({ ok: false, code: "not_found", message: "not used" }),
			syncSubscriptions() {},
		},
		rememberFanClubName() {},
		rememberSuperchatAvatar() {},
	});
	return { ctx, problems };
}

describe("RoomContext.fetchRoomInfo", () => {
	it("抛错:报订阅级「停止监听」(取直播间信息失败),返回 undefined,不发 pipeline-error", async () => {
		const h = makeSessionHarness({
			roomInfo: async () => undefined,
		});
		await h.bootstrap();
		expect(h.problems.reportFailure).toHaveBeenCalledTimes(1);
		expect(h.problems.reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				externalId: "u1",
				code: "live_monitor_stopped",
				message: expect.any(Function),
			}),
		);
		expect(h.closeListener).toHaveBeenCalledWith("r1");
		expect(h.warnings.some((args) => String(args[0]).includes("pipeline-error"))).toBe(false);
	});

	it("拉到了:原样返回 data,什么都不报", async () => {
		const data = { uid: 1, live_status: 0 };
		const { ctx, problems } = makeCtx({ fetchLiveRoomInfo: vi.fn(async () => ({ data })) });
		await expect(ctx.fetchRoomInfo("r1")).resolves.toBe(data);
		expect(problems.reportFailure).not.toHaveBeenCalled();
	});
});

describe("RoomContext.closeListener", () => {
	it("只管停:关连接、拆这个房间的计时器;不发 pipeline-error", () => {
		const { ctx, problems } = makeCtx();
		const close = vi.fn();
		ctx.listenerRecord.r1 = { closed: false, close };

		ctx.closeListener("r1");

		expect(close).toHaveBeenCalledTimes(1);
		expect(ctx.listenerRecord.r1).toBeUndefined();
		expect(problems.reportFailure).not.toHaveBeenCalled();
	});
});

describe("RoomContext.startLiveRoomListener · 取个人信息失败只记日志", () => {
	const goodInfo = ok({
		data: { token: "tok", host_list: [{ host: "h1.example.com", wss_port: 443 }] },
	});

	it.each([
		["抛错", () => Promise.reject(new Error("net down"))],
		["回非 0 的码", () => Promise.resolve({ code: -101 })],
	])(
		"%s:回 false,不发 pipeline-error、不报问题(后果由随后那条「停止监听」报)",
		async (_name, myself) => {
			const { ctx, problems } = makeCtx({
				fetchLiveRoomInfoStreamKey: vi.fn(async () => goodInfo),
				fetchCachedMyself: vi.fn(myself),
			});
			await expect(ctx.startLiveRoomListener("123", () => {})).resolves.toBe(false);
			expect(problems.reportFailure).not.toHaveBeenCalled();
		},
	);
});

describe("RoomSession.reportStopped · 原因是出字那一刻现取的", () => {
	it("原因交的是取字函数:切语言后重报的那一句带新原因,不是报的那一刻的旧字", async () => {
		const h = makeSessionHarness({
			listener: async () => false,
		});
		await h.bootstrap();
		const failure = h.problems.reportFailure.mock.calls[0]?.[0];
		expect(failure?.message()).toContain(PROBLEM_TEXTS.liveStopReasons.danmakuConnect());
	});

	it("交给上报器的是取字函数(不是出好的字)", async () => {
		const h = makeSessionHarness({ listener: async () => false });
		await h.bootstrap();
		const failure = h.problems.reportFailure.mock.calls[0]?.[0];
		expect(typeof failure?.message).toBe("function");
		expect(failure?.message()).toBe(
			PROBLEM_TEXTS.liveMonitorStopped.text("r1", PROBLEM_TEXTS.liveStopReasons.danmakuConnect()),
		);
	});
});
