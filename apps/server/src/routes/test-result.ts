import type { DeliveryResult, Failure, ProbeResult, Result } from "@bilibili-notify/internal";
import { fail, ok } from "@bilibili-notify/internal";
import { t as serverText } from "../i18n/index.js";

/**
 * 「试一次、回报结果」的接口(测试推送、测试连通)回给面板的体:`Result<{ latencyMs }>`(ADR-0026)。
 *
 * 投递与探测入口的 `DeliveryResult` / `ProbeResult` 已经是同一种结果形状,失败那一支(标准码、原话、
 * `upstreamCode`)原样过线;这里只做两件事:成功那一支只留耗时(截流标记 `isSynthetic` 不过线),
 * 以及给原话是空的失败补一句能读的话。
 */
export type TestResult = Result<{ latencyMs: number }>;

/** 一次测试投递的结果 → 线上的形状。 */
export function testResultOfDelivery(result: Failure): Failure;
export function testResultOfDelivery(result: DeliveryResult): TestResult;
export function testResultOfDelivery(result: DeliveryResult): TestResult {
	if (result.ok) return ok({ latencyMs: result.latencyMs });
	return result.message
		? result
		: { ...result, message: serverText("service.routes.test-result.text.1") };
}

/**
 * 一次连接探测的结果 → 线上的形状。`unsupported` 是「这个适配器没有探测协议」(目前只有 webhook)
 * —— 既不是通、也不是不通,给面板的话在这里统一成一句。
 */
export function testResultOfProbe(result: ProbeResult): TestResult {
	if (result.ok) return ok({ latencyMs: result.latencyMs });
	if (result.code === "unsupported")
		return fail("unsupported", serverText("service.routes.test-result.text.2"));
	return result.message
		? result
		: { ...result, message: serverText("service.routes.test-result.text.3") };
}
