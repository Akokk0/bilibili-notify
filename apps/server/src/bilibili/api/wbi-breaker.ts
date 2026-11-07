import type { Logger } from "@bilibili-notify/internal";
import { logText } from "../i18n.js";
import { RISK_BACKOFF_STEPS_MS, RiskControlError, riskBackoffStepMs } from "./risk-control";

export interface WbiBreakerOptions {
	/** 现在几点。只读时间戳、不开定时器:到期与否在下一次调用时现算。 */
	now: () => number;
	logger: Logger;
}

/**
 * wbi 签名请求一族共用的熔断(3b-63,主人 10-24 定)。账号被长期风控时,直播的房号解析与预检每位 UP
 * 各自按长尾重试,打出去的量随 UP 数线性涨、还会扎堆;熔断让这一族在风控期间只剩零星几发试探。
 *
 * - 关着:照常调;撞 {@link RiskControlError}(持续 -352 或 HTTP 412)就开闸,窗口按 {@link riskBackoffStepMs}
 *   从 60 秒起。
 * - 开着、没到期:不调、不出网,当场抛 `RiskControlError`(原话带上一次的,`upstreamCode` 照抄),调用方
 *   照旧翻成 `rate_limited` —— 失败形状与风控层的上报都不变。
 * - 到期:只放第一个调用出网试探,其余等它落定再重判。试探成功就关闸;再撞风控升一级(封顶 30 分钟);
 *   抛别的(连不上、超时)什么都不说明,状态不动,下一个调用接着当试探。
 * - `reset()`:新一段登录成立时清(主人 10-24 定),在途试探的结果作废。
 */
export interface WbiBreaker {
	run<T>(call: () => Promise<T>): Promise<T>;
	reset(): void;
}

interface Probe {
	done: Promise<void>;
	settle: () => void;
}

export function createWbiBreaker(options: WbiBreakerOptions): WbiBreaker {
	let open:
		| {
				until: number;
				level: number;
				lastError: RiskControlError;
		  }
		| undefined;
	let probeInFlight: Probe | undefined;
	let epoch = 0;

	return {
		async run<T>(call: () => Promise<T>): Promise<T> {
			for (;;) {
				if (open) {
					const remainingMs = open.until - options.now();
					if (remainingMs > 0) {
						const remainingSeconds = Math.ceil(remainingMs / 1_000);
						options.logger.debug(logText("log.bilibili.wbi.blocked"), {
							remainingSeconds,
							upstreamCode: open.lastError.upstreamCode,
							error: open.lastError,
						});
						throw new RiskControlError(
							`wbi requests are paused by the breaker; one probe goes out in about ${remainingSeconds} seconds. Last failure: ${open.lastError.message}`,
							open.lastError.upstreamCode,
						);
					}
					if (probeInFlight) {
						await probeInFlight.done;
						continue;
					}
				}

				const isProbe = open !== undefined;
				const callEpoch = epoch;
				let probe: Probe | undefined;
				let settleProbe!: () => void;
				if (isProbe) {
					probe = {
						done: new Promise<void>((resolve) => {
							settleProbe = resolve;
						}),
						settle: () => settleProbe(),
					};
					probeInFlight = probe;
				}

				try {
					const result = await call();
					if (probe && callEpoch === epoch && probeInFlight === probe) {
						open = undefined;
						options.logger.info(logText("log.bilibili.wbi.recovered"));
					}
					return result;
				} catch (error) {
					if (error instanceof RiskControlError && callEpoch === epoch) {
						if (probe) {
							const level = open ? Math.min(open.level + 1, RISK_BACKOFF_STEPS_MS.length - 1) : 0;
							const windowMs = riskBackoffStepMs(level);
							open = { until: options.now() + windowMs, level, lastError: error };
							if (level === 0) {
								options.logger.warn(logText("log.bilibili.wbi.opened"), {
									windowMs,
									level: open.level,
									upstreamCode: error.upstreamCode,
									error,
								});
							} else {
								options.logger.warn(logText("log.bilibili.wbi.escalated"), {
									windowMs,
									level: open.level,
									upstreamCode: error.upstreamCode,
									error,
								});
							}
						} else if (!open) {
							const windowMs = riskBackoffStepMs(0);
							open = { until: options.now() + windowMs, level: 0, lastError: error };
							options.logger.warn(logText("log.bilibili.wbi.opened"), {
								windowMs,
								level: open.level,
								upstreamCode: error.upstreamCode,
								error,
							});
						}
					}
					throw error;
				} finally {
					probe?.settle();
					if (probeInFlight === probe) {
						probeInFlight = undefined;
					}
				}
			}
		},
		reset(): void {
			epoch++;
			probeInFlight?.settle();
			probeInFlight = undefined;
			open = undefined;
		},
	};
}
