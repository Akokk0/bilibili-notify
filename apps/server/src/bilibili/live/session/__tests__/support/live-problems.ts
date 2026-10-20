import { vi } from "vite-plus/test";
import { fixedLocale } from "../../../../../__tests__/support/fixed-locale.js";
import { createProblemLayers } from "../../../../problem-layers.js";

/** 直播会话测试用的假上报器:四个方法都是 spy,什么都不做。 */
export function makeLiveProblems() {
	return {
		reportRisk: vi.fn(),
		resolveRisk: vi.fn(),
		reportFailure: vi.fn(),
		resolveFailure: vi.fn(),
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
		locale: fixedLocale(),
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
