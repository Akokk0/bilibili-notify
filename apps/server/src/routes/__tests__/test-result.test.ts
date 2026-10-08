/**
 * 引擎那头的结果(`DeliveryResult` / `ProbeResult`)在出口过成线上的 `Result<{ latencyMs }>`。
 * 成功那一支只留耗时;失败那一支(标准码、原话、`upstreamCode`)原样过线,不再一律压成 `unavailable`。
 */

import { fail } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { testResultOfDelivery, testResultOfProbe } from "../test-result.js";

describe("testResultOfDelivery", () => {
	it("送达 → { ok: true, latencyMs }", () => {
		expect(testResultOfDelivery({ ok: true, latencyMs: 42 })).toEqual({ ok: true, latencyMs: 42 });
	});

	it("截流标记(isSynthetic)不上线", () => {
		expect(testResultOfDelivery({ ok: true, latencyMs: 0, isSynthetic: true })).toEqual({
			ok: true,
			latencyMs: 0,
		});
	});

	it("没送达 → 适配器给的码、原话、upstreamCode 原样过线,不带 latencyMs", () => {
		const r = testResultOfDelivery(fail("unknown", "群不存在", { upstreamCode: 1400 }));
		expect(r).toEqual({ ok: false, code: "unknown", message: "群不存在", upstreamCode: 1400 });
		expect(r).not.toHaveProperty("latencyMs");
		expect(testResultOfDelivery(fail("indeterminate", "超时"))).toEqual({
			ok: false,
			code: "indeterminate",
			message: "超时",
		});
	});

	it("原话是空的 → 兜一句中文,码与 upstreamCode 不动", () => {
		const r = testResultOfDelivery(fail("unknown", "", { upstreamCode: 9 }));
		expect(r).toEqual({
			ok: false,
			code: "unknown",
			message: "没有送达，对端没说原因",
			upstreamCode: 9,
		});
	});
});

describe("testResultOfProbe", () => {
	it("通 → { ok: true, latencyMs }", () => {
		expect(testResultOfProbe({ ok: true, latencyMs: 8 })).toEqual({ ok: true, latencyMs: 8 });
	});

	it("不通 → 码与原话原样过线,不带 latencyMs", () => {
		const r = testResultOfProbe(fail("not_configured", "端口 6700 绑定失败: EADDRINUSE"));
		expect(r).toEqual({
			ok: false,
			code: "not_configured",
			message: "端口 6700 绑定失败: EADDRINUSE",
		});
		expect(r).not.toHaveProperty("latencyMs");
	});

	it("原话是空的 → 兜一句中文", () => {
		expect(testResultOfProbe(fail("unavailable", ""))).toEqual({
			ok: false,
			code: "unavailable",
			message: "连接探测没通过，对端没说原因",
		});
	});

	it("unsupported(适配器没有探测协议)→ 给面板的话统一成一句,既不是通也不是不通", () => {
		const r = testResultOfProbe(fail("unsupported", "webhook does not support connection probe"));
		expect(r).toEqual({ ok: false, code: "unsupported", message: "该平台不支持连接探测" });
	});
});
