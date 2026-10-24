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
