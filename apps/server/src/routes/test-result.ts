import type { DeliveryResult, ProbeResult, Result } from "@bilibili-notify/internal";
import { fail, ok } from "@bilibili-notify/internal";

/**
 * 「试一次、回报结果」的接口(测试推送、测试连通)回给面板的体:`Result<{ latencyMs }>`(ADR-0026)。
 *
 * 引擎那头的 `DeliveryResult` / `ProbeResult` 已经是同一种结果形状,失败那一支(标准码、原话、
 * `upstreamCode`)原样过线;这里只做两件事:成功那一支只留耗时(截流标记 `isSynthetic` 不过线),
 * 以及给原话是空的失败补一句能读的话。
 */
export type TestResult = Result<{ latencyMs: number }>;

/** 一次测试投递的结果 → 线上的形状。 */
export function testResultOfDelivery(result: DeliveryResult): TestResult {
	if (result.ok) return ok({ latencyMs: result.latencyMs });
	return result.message ? result : { ...result, message: "没有送达，对端没说原因" };
}

/**
 * 一次连接探测的结果 → 线上的形状。`unsupported` 是「这个适配器没有探测协议」(目前只有 webhook)
 * —— 既不是通、也不是不通,给面板的话在这里统一成一句。
 */
export function testResultOfProbe(result: ProbeResult): TestResult {
	if (result.ok) return ok({ latencyMs: result.latencyMs });
	if (result.code === "unsupported") return fail("unsupported", "该平台不支持连接探测");
	return result.message ? result : { ...result, message: "连接探测没通过，对端没说原因" };
}
