/**
 * 引擎那头的结果(`DeliveryResult` / `ProbeResult`)在出口过成线上的 `Result<{ latencyMs }>`。
 * 成功那一支只留耗时;失败那一支(标准码、原话、`upstreamCode`)原样过线,不再一律压成 `unavailable`。
 */

import { fail } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { testResultOfDelivery, testResultOfProbe } from "../test-result.js";

afterEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

it.each([
	["zh-CN", "未能确认送达，对端未提供原因", "该平台不支持连接探测", "连接探测没通过，对端没说原因"],
	[
		"en",
		"Delivery could not be confirmed; the other end gave no reason.",
		"This platform does not support connection probing.",
		"The connection probe did not succeed; the other end gave no reason.",
	],
	[
		"ja",
		"配信を確認できませんでした。相手側から理由が返されていません。",
		"このプラットフォームは接続確認に対応していません。",
		"接続確認に失敗しました。相手側から理由が返されていません。",
	],
	[
		"zh-TW",
		"無法確認送達，對端未提供原因。",
		"此平台不支援連線探測。",
		"連線探測未通過，對端未提供原因。",
	],
] as const)(
	"%s:空原因的无法确认不谎称未送达,保留结果码/上游码/逐项原因",
	(locale, delivery, unsupported, probe) => {
		i18n.set({ locale, voice: "plain" });
		const raw = fail("indeterminate", "", {
			upstreamCode: 9,
			issues: [{ path: ["remote"], message: "Original diagnostic 原文" }],
		});
		expect(testResultOfDelivery(raw)).toEqual({ ...raw, message: delivery });
		expect(raw.message).toBe("");
		const explained = fail("indeterminate", "Original upstream reason 原文", { upstreamCode: 10 });
		expect(testResultOfDelivery(explained)).toBe(explained);
		expect(testResultOfProbe(explained)).toBe(explained);
		expect(testResultOfProbe(fail("unsupported", "Original protocol detail"))).toEqual({
			ok: false,
			code: "unsupported",
			message: unsupported,
		});
		expect(testResultOfProbe(fail("unavailable", "", { upstreamCode: 11 }))).toEqual({
			ok: false,
			code: "unavailable",
			message: probe,
			upstreamCode: 11,
		});
		expect(testResultOfDelivery({ ok: true, latencyMs: 42, isSynthetic: true })).toEqual({
			ok: true,
			latencyMs: 42,
		});
	},
);

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
			message: "未能确认送达，对端未提供原因",
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
