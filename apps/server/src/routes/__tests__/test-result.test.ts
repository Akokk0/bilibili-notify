/**
 * 引擎那头的老形状结果(`DeliveryResult` / `ProbeResult`)在出口翻成线上的 `Result<{ latencyMs }>`。
 * 耗时只在成功那一支;没真发出去的失败不带假的 `0`;适配器没带码就不猜。
 */

import { describe, expect, it } from "vite-plus/test";
import { testResultOfDelivery, testResultOfProbe } from "../test-result.js";

describe("testResultOfDelivery", () => {
	it("送达 → { ok: true, latencyMs }", () => {
		expect(testResultOfDelivery({ ok: true, latencyMs: 42 })).toEqual({ ok: true, latencyMs: 42 });
	});

	it("截流标记(synthetic)不上线", () => {
		expect(testResultOfDelivery({ ok: true, latencyMs: 0, synthetic: true })).toEqual({
			ok: true,
			latencyMs: 0,
		});
	});

	it("没送达 → unavailable,原话进 message,不带 latencyMs", () => {
		const r = testResultOfDelivery({ ok: false, latencyMs: 0, err: "retcode 1400: 群不存在" });
		expect(r).toEqual({ ok: false, code: "unavailable", message: "retcode 1400: 群不存在" });
		expect(r).not.toHaveProperty("latencyMs");
	});

	it("适配器一句话都没给 → 兜一句中文,message 不许是空的", () => {
		const r = testResultOfDelivery({ ok: false, latencyMs: 3 });
		expect(r).toMatchObject({ ok: false, code: "unavailable" });
		expect((r as { message: string }).message).not.toBe("");
	});
});

describe("testResultOfProbe", () => {
	it("通 → { ok: true, latencyMs }", () => {
		expect(testResultOfProbe({ ok: true, latencyMs: 8 })).toEqual({ ok: true, latencyMs: 8 });
	});

	it("不通 → unavailable + 原话,不带 latencyMs", () => {
		const r = testResultOfProbe({ ok: false, latencyMs: 20, err: "正向 WS 未连接" });
		expect(r).toEqual({ ok: false, code: "unavailable", message: "正向 WS 未连接" });
		expect(r).not.toHaveProperty("latencyMs");
	});

	it("ok: null(适配器没有探测协议)→ unsupported,既不是通也不是不通", () => {
		const r = testResultOfProbe({
			ok: null,
			latencyMs: 0,
			err: "webhook does not support connection probe",
		});
		expect(r).toEqual({ ok: false, code: "unsupported", message: "该平台不支持连接探测" });
	});
});
