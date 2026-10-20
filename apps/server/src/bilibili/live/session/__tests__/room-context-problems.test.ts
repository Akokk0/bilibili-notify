/**
 * `RoomContext` 里往问题表报「房间不监听了」的那几处(真 RoomContext + 假 api + 假上报器)。
 *
 * - 取房间信息抛错:报订阅级「停止监听」(原因「取直播间信息失败」),关连接;**不私聊、不发 engine-error**;
 * - `stopMonitoring` 只管停(关连接、拆计时器),不再发 engine-error —— 后果各调用点自己带着 uid 去报;
 * - 取个人信息失败只记日志:后果由随后那条「停止监听」去报,单独报一条没人会清;
 * - 这个人不再需要监听走静默清(房间又监听上了的普通清是会话里单条做的,见 room-session-problems)。
 */

import { ok, type ServiceContext } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { PROBLEM_TEXTS } from "../../../problem-texts";
import {
	MONITOR_STOPPED_CODE,
	ROOM_RESTRICTED_CODE,
	type RoomContextOptions,
} from "../room-context";
import { RoomContext } from "../room-helpers";
import { expectedStoppedFailure, makeLiveProblems } from "./support/live-problems";

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
	const emitEngineError = vi.fn();
	const ctx = new RoomContext({
		serviceCtx,
		api,
		// push 上什么口都没有:要是还有人去私聊主人,下面的用例就抛了
		push: {},
		problems,
		contentBuilder: {},
		templateRenderer: {},
		wordcloudGenerator: {},
		liveSummaryRequester: {},
		danmakuCollector: {},
		getImageRenderer: () => null,
		config: {},
		emitEngineError,
	} as unknown as RoomContextOptions);
	return { ctx, problems, emitEngineError };
}

describe("RoomContext.getLiveRoomInfo", () => {
	// 验红:把 room-helpers.ts 里 `this.reportMonitorStopped(…)` 那一行删掉,这条红。
	it("抛错:报订阅级「停止监听」(取直播间信息失败),返回 undefined,不发 engine-error", async () => {
		const { ctx, problems, emitEngineError } = makeCtx({
			fetchLiveRoomInfo: vi.fn(async () => {
				throw new Error("boom");
			}),
		});
		const closeListener = vi.spyOn(ctx, "closeListener");

		await expect(ctx.getLiveRoomInfo("r1", "u1")).resolves.toBeUndefined();

		expect(problems.reportFailure).toHaveBeenCalledTimes(1);
		expect(problems.reportFailure).toHaveBeenCalledWith(
			expectedStoppedFailure("u1", "r1", PROBLEM_TEXTS.liveStopReasons.roomInfo()),
		);
		expect(closeListener).toHaveBeenCalledWith("r1");
		expect(emitEngineError).not.toHaveBeenCalled();
	});

	it("拉到了:原样返回 data,什么都不报", async () => {
		const data = { uid: 1, live_status: 0 };
		const { ctx, problems } = makeCtx({ fetchLiveRoomInfo: vi.fn(async () => ({ data })) });
		await expect(ctx.getLiveRoomInfo("r1", "u1")).resolves.toBe(data);
		expect(problems.reportFailure).not.toHaveBeenCalled();
	});
});

describe("RoomContext.stopMonitoring", () => {
	it("只管停:关连接、拆这个房间的计时器;不发 engine-error", () => {
		const { ctx, emitEngineError, problems } = makeCtx();
		const closeListener = vi.spyOn(ctx, "closeListener");
		const timer = vi.fn();
		ctx.livePushTimerManager.set("r1", timer);

		ctx.stopMonitoring("获取直播间信息失败", "r1");

		expect(closeListener).toHaveBeenCalledWith("r1");
		expect(timer).toHaveBeenCalledTimes(1);
		expect(ctx.livePushTimerManager.has("r1")).toBe(false);
		expect(emitEngineError).not.toHaveBeenCalled();
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
		"%s:回 false,不发 engine-error、不报问题(后果由随后那条「停止监听」报)",
		async (_name, myself) => {
			const { ctx, problems, emitEngineError } = makeCtx({
				fetchLiveRoomInfoStreamKey: vi.fn(async () => goodInfo),
				getMyselfInfoCached: vi.fn(myself),
			});
			await expect(ctx.startLiveRoomListener("123", () => {})).resolves.toBe(false);
			expect(emitEngineError).not.toHaveBeenCalled();
			expect(problems.reportFailure).not.toHaveBeenCalled();
		},
	);
});

describe("RoomContext 清「停止监听 / 受限」的口", () => {
	it("clearMonitorProblems(这个人不再需要监听):两条都静默清(notify: false)", () => {
		const { ctx, problems } = makeCtx();
		ctx.clearMonitorProblems("u1");
		expect(problems.resolveFailure.mock.calls).toEqual([
			[{ externalId: "u1", code: MONITOR_STOPPED_CODE }, { notify: false }],
			[{ externalId: "u1", code: ROOM_RESTRICTED_CODE }, { notify: false }],
		]);
	});
});
