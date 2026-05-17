import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { MiddlewareHandler } from "hono";

/**
 * P2:凭证常量时间比较。`===` 短路比较泄漏前缀匹配长度(限流缓解但不消除)。
 * 对两侧取 SHA-256(定长)再 timingSafeEqual,既常量时间又不泄漏长度。
 */
function safeEqual(a: string, b: string): boolean {
	const ha = createHash("sha256").update(a).digest();
	const hb = createHash("sha256").update(b).digest();
	return timingSafeEqual(ha, hb);
}

/**
 * Basic-auth 中间件 + IP 维度的简单令牌桶。
 *
 * - 鉴权失败计数累加,超过 `maxFailures`(默认 5)就把该 IP block `blockMs`(默认 60s),
 *   期间返回 429 Too Many Requests。
 * - 成功后清零失败计数。
 * - IP 取 `getConnInfo(c).remote.address`,即直接连接的 client IP;不读 X-Forwarded-For
 *   因为容易被伪造,且本服务约定:**部署在反代后请把 basicAuth 放到反代层**(nginx
 *   auth_basic),应用层只对反代回环 IP 解锁;若坚持应用层鉴权,服务需要直接监听
 *   公网或反代要透传 X-Real-IP 并在此中间件外加 ip-allowlist。
 */
export interface RateLimitedBasicAuthOptions {
	username: string;
	password: string;
	maxFailures?: number;
	blockMs?: number;
	/** 失败/成功事件回调,用于日志或测试断言。 */
	onEvent?: (event: BasicAuthEvent) => void;
}

export type BasicAuthEvent =
	| { type: "blocked"; ip: string; retryAfterMs: number }
	| { type: "failure"; ip: string; failures: number }
	| { type: "success"; ip: string };

interface IpState {
	failures: number;
	blockedUntil?: number;
}

export function createRateLimitedBasicAuth(opts: RateLimitedBasicAuthOptions): MiddlewareHandler {
	const expected = Buffer.from(`${opts.username}:${opts.password}`, "utf8").toString("base64");
	const maxFailures = opts.maxFailures ?? 5;
	const blockMs = opts.blockMs ?? 60_000;
	const state = new Map<string, IpState>();

	return async (c, next) => {
		// getConnInfo 仅在 @hono/node-server 注入的 ctx 上可用;`app.request()` 这类
		// 内存模拟请求会抛错。退化为 "unknown" IP,不影响功能 — 单元测试场景下
		// 速率限制对所有 unknown IP 共享一个桶,正是测试需要的可预测行为。
		let ip = "unknown";
		try {
			ip = getConnInfo(c).remote.address ?? "unknown";
		} catch {
			// keep "unknown"
		}
		const now = Date.now();
		const entry = state.get(ip);

		if (entry?.blockedUntil && entry.blockedUntil > now) {
			const retryAfter = entry.blockedUntil - now;
			opts.onEvent?.({ type: "blocked", ip, retryAfterMs: retryAfter });
			c.header("Retry-After", String(Math.ceil(retryAfter / 1000)));
			return c.json(
				{
					error: "too_many_requests",
					message: "认证失败次数过多,IP 已被临时锁定;请稍后再试。",
				},
				429,
			);
		}

		const header = c.req.header("authorization");
		const match = header && /^Basic\s+(.+)$/i.exec(header.trim());
		if (match && match[1] !== undefined && safeEqual(match[1], expected)) {
			if (entry) state.delete(ip);
			opts.onEvent?.({ type: "success", ip });
			return next();
		}

		const failures = (entry?.failures ?? 0) + 1;
		const nextEntry: IpState = { failures };
		if (failures >= maxFailures) nextEntry.blockedUntil = now + blockMs;
		state.set(ip, nextEntry);
		opts.onEvent?.({ type: "failure", ip, failures });

		c.header("WWW-Authenticate", 'Basic realm="bilibili-notify"');
		return c.json({ error: "unauthorized", message: "Basic auth required" }, 401);
	};
}
