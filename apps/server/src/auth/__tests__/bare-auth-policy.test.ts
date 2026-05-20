/**
 * 回归守护 — P0-5 fix(security): fail-closed on bare non-loopback
 *
 * shouldRefuseBareAuth 决定"是否在启动时 process.exit(1) 拒绝裸跑 dashboard"。
 * 把这层策略抽成纯函数,锁住三条路径:
 *   - non-loopback 主机 + 无 basicAuth + 未设置逃生口 → 必须拒绝
 *   - loopback 主机 → 放行(本地 dev)
 *   - BN_ALLOW_NO_AUTH=1 → 放行(运维已在反代做了别的鉴权)
 */

import { describe, expect, it } from "vitest";
import { shouldRefuseBareAuth } from "../bare-auth-policy";

describe("shouldRefuseBareAuth — P0-5 fail-closed policy", () => {
	it("non-loopback + 无 basicAuth + 无逃生口 → 拒绝(true)", () => {
		expect(shouldRefuseBareAuth({ host: "0.0.0.0", hasBasicAuth: false, allowNoAuth: false })).toBe(
			true,
		);
		expect(
			shouldRefuseBareAuth({ host: "10.0.0.5", hasBasicAuth: false, allowNoAuth: false }),
		).toBe(true);
	});

	it("loopback 主机 → 放行(本地 dev)", () => {
		for (const host of ["127.0.0.1", "localhost", "::1"]) {
			expect(shouldRefuseBareAuth({ host, hasBasicAuth: false, allowNoAuth: false })).toBe(false);
		}
	});

	it("BN_ALLOW_NO_AUTH=1(allowNoAuth=true)→ 放行,即使 non-loopback", () => {
		expect(shouldRefuseBareAuth({ host: "0.0.0.0", hasBasicAuth: false, allowNoAuth: true })).toBe(
			false,
		);
	});

	it("已配置 basicAuth → 永远放行(忽略 host)", () => {
		expect(shouldRefuseBareAuth({ host: "0.0.0.0", hasBasicAuth: true, allowNoAuth: false })).toBe(
			false,
		);
	});
});
