/**
 * 风控错误。持续风控(刷新 wbiKeys 后仍 -352)与 HTTP 412 风控页都是它。
 * 外层 retry 据此 fail-fast,不再把同一请求快速重发 3 轮放大风控。
 */
export class RiskControlError extends Error {
	readonly upstreamCode?: number;

	constructor(message: string, upstreamCode?: number) {
		super(message);
		this.name = "RiskControlError";
		this.upstreamCode = upstreamCode;
	}
}

/** 直播长尾与 wbi 熔断共用的退避窗口；用尽后停在最后一格。 */
export const RISK_BACKOFF_STEPS_MS = [60_000, 300_000, 900_000, 1_800_000] as const;

export function riskBackoffStepMs(attempt: number): number {
	return RISK_BACKOFF_STEPS_MS[
		Math.min(Math.max(attempt, 0), RISK_BACKOFF_STEPS_MS.length - 1)
	] as number;
}
