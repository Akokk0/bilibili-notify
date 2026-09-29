import {
	type DeliveryResult,
	fail,
	ok,
	type ProbeResult,
	type Result,
} from "@bilibili-notify/internal";

/**
 * 「试一次、回报结果」的接口(测试推送、测试连通)回给面板的体:`Result<{ latencyMs }>`(ADR-0026)。
 *
 * 引擎那头的 `DeliveryResult` / `ProbeResult` 还是 `{ ok, latencyMs, err? }` 老形状(适配器改成带码的结果
 * 是另一期的事,docs/1.0/push.md「结果与失败」),而且它们**落盘**(历史每条消息的 `err`、目标与连接的
 * `testStatus.err`),所以这里只在出口翻成线上的形状,盘上那条路照旧读 `err`。
 *
 * 失败一律 `unavailable`:适配器没带码,不嗅 `err` 的字去猜超时还是鉴权 —— 猜错比不猜更坏。原话进 `message`。
 * 耗时 `latencyMs` 只在成功那一支:没真发出去的失败不带一个假的 `0`。
 */
export type TestResult = Result<{ latencyMs: number }>;

/** 一次测试投递的结果 → 线上的形状。 */
export function testResultOfDelivery(result: DeliveryResult): TestResult {
	if (result.ok) return ok({ latencyMs: result.latencyMs });
	return fail("unavailable", result.err || "没有送达，对端没说原因");
}

/**
 * 一次连接探测的结果 → 线上的形状。`ok: null` 是「这个适配器没有探测协议」(`ProbeResult` 的注释,
 * 目前只有 webhook),按标准码表是 `unsupported` —— 既不是通、也不是不通。
 */
export function testResultOfProbe(result: ProbeResult): TestResult {
	if (result.ok === null) return fail("unsupported", "该平台不支持连接探测");
	if (result.ok) return ok({ latencyMs: result.latencyMs });
	return fail("unavailable", result.err || "连接探测没通过，对端没说原因");
}
