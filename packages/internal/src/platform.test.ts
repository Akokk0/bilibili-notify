import { describe, expect, it } from "vite-plus/test";
import { type DeliveryResult, isReachabilityEvidence } from "./platform.js";

/**
 * 投递结果同时被两处读:一处是「这条推送成没成」(历史那行),另一处是「这个目标还通不通」
 * (target.testStatus,会落盘、会广播 config-changed)。第二处要的是**证据** —— 一条根本
 * 没出网的投递,不管它回什么,都不能拿来翻目标的可达状态。
 */
describe("isReachabilityEvidence", () => {
	const base: DeliveryResult = { ok: true, latencyMs: 12 };

	it("真发出去的:成功与失败都是证据", () => {
		expect(isReachabilityEvidence(base)).toBe(true);
		expect(isReachabilityEvidence({ ok: false, latencyMs: 5, err: "kicked" })).toBe(true);
	});

	it("没出网的(截流造出来的成功)不是证据 —— 拿它翻目标状态等于凭空说「通了」", () => {
		expect(isReachabilityEvidence({ ...base, synthetic: true })).toBe(false);
	});
});
