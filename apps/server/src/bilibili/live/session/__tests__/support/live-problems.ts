import { vi } from "vite-plus/test";
import { createProblemLayers } from "../../../../problem-layers.js";
import { PROBLEM_TEXTS } from "../../../../problem-texts.js";
import {
	type LiveProblems,
	MONITOR_STOPPED_CODE,
	ROOM_RESTRICTED_CODE,
	RoomContextBase,
} from "../../room-context.js";

/** 直播会话测试用的假上报器:四个方法都是 spy,什么都不做。 */
export function makeLiveProblems() {
	return {
		reportRisk: vi.fn<LiveProblems["reportRisk"]>(),
		resolveRisk: vi.fn<LiveProblems["resolveRisk"]>(),
		reportFailure: vi.fn<LiveProblems["reportFailure"]>(),
		resolveFailure: vi.fn<LiveProblems["resolveFailure"]>(),
	};
}

/** 断言用:一个房间「停止监听」时应当交给上报器的那一条(文案、code、是否私聊都取自文案文件)。 */
export function expectedStoppedFailure(uid: string, roomId: string, reason: string) {
	const text = PROBLEM_TEXTS.liveMonitorStopped;
	return {
		externalId: uid,
		code: MONITOR_STOPPED_CODE,
		message: text.text(roomId, reason),
		notify: text.notify,
		lasting: true,
		recoveryMessage: text.recovery(roomId),
	};
}

/** 断言用:一个房间「受限」时应当交给上报器的那一条。 */
export function expectedRestrictedFailure(uid: string, roomId: string, reason: string) {
	const text = PROBLEM_TEXTS.liveRoomRestricted;
	return {
		externalId: uid,
		code: ROOM_RESTRICTED_CODE,
		message: text.text(roomId, reason),
		notify: text.notify,
		lasting: true,
		recoveryMessage: text.recovery(roomId),
	};
}

/**
 * 手写的假 `RoomContext` 里要有的「问题」那一截:`problems` 本身,加 `RoomContextBase` 上报问题的几个方法
 * (**真实现**,绑在这个上报器上 —— 假 ctx 里不另抄一份文案与 code 的拼法)。用法:`{ ...liveProblemsCtx(problems) }`。
 */
export function liveProblemsCtx(problems: LiveProblems) {
	const self = { problems } as RoomContextBase;
	return {
		problems,
		reportMonitorStopped: RoomContextBase.prototype.reportMonitorStopped.bind(self),
		reportRoomRestricted: RoomContextBase.prototype.reportRoomRestricted.bind(self),
		clearMonitorProblems: RoomContextBase.prototype.clearMonitorProblems.bind(self),
	};
}

/**
 * 真上报器(登录正常)+ 一个记录用的假核心:`present()` 回此刻表里该有的条目(订阅级的带 `uid:` 前缀),
 * 好让用例看「压没压」「清没清」。用假上报器测不出分层压不压。
 */
export function makeRecordingLayers() {
	const table = new Map<string, string>();
	const keyOf = (p: { externalId?: string; code: string }) => `${p.externalId ?? ""}|${p.code}`;
	const layers = createProblemLayers({
		auth: {
			state: () => ({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" }),
			onChange: () => ({ dispose() {} }),
		},
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
	layers.attach({
		reportProblem: (p) =>
			void table.set(keyOf(p), p.externalId ? `${p.externalId}:${p.code}` : p.code),
		resolveProblem: (p) => void table.delete(keyOf(p)),
	});
	return { layers, present: () => [...table.values()].sort() };
}
