/**
 * AI 连接探活 —— 端点跟实例的接口风味走;没过的带标准码(ADR-0026):要主人回去改配置的
 * `not_configured`,对端暂时不行的 `unavailable`,限速 `rate_limited`,超时 `timeout`。
 * 平台自己的 HTTP 状态放 `upstreamCode`,不占 `code`。
 *
 * fetch 用 vi.stubGlobal 假掉,不打真实网络。
 */

import { createI18n, type Locale } from "@bilibili-notify/internal/i18n";
import {
	bindPackageText,
	type PackageTextKey,
	withPackageDicts,
} from "@bilibili-notify/internal/texts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { probeAiProvider } from "../provider-probe";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const okJson = () => ({ ok: true, status: 200, text: async () => "" }) as unknown as Response;
const httpResponse = (status: number, text = "boom") =>
	({ ok: false, status, text: async () => text }) as unknown as Response;

const fields = { apiKey: "k", baseUrl: "https://api.example.com", model: "m", apiFlavor: "chat" };

/** 取第 n 次 fetch 调用的 url 与解析后的 body。 */
function call(n: number): { url: string; body: Record<string, unknown>; init: RequestInit } {
	const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
	return { url, body: JSON.parse(String(init.body)), init };
}

describe("probeAiProvider — 探活打的端点要跟实例的接口风味走", () => {
	it("chat 风味(默认)→ 打 /chat/completions", async () => {
		fetchMock.mockResolvedValue(okJson());
		const r = await probeAiProvider({ ...fields, baseUrl: "https://api.example.com/" });
		expect(r.ok).toBe(true);
		expect(call(0).url).toBe("https://api.example.com/chat/completions");
		expect(call(0).body.messages).toBeDefined();
	});

	// temperature 已整个退役、真聊天路径一律不发;探活要是还带着,Claude Opus 4.7 起的
	// 模型与 OpenAI 推理模型会 400 拒掉这一发,主人就被探活挡在门外,而真聊天本来能通。
	it("chat 风味的 ping 同样不带 temperature —— 探活不能比真聊天多踩一颗雷", async () => {
		fetchMock.mockResolvedValue(okJson());
		const r = await probeAiProvider({ ...fields, model: "claude-opus-4-7" });
		expect(r.ok).toBe(true);
		expect(call(0).url).toBe("https://api.example.com/chat/completions");
		expect("temperature" in call(0).body).toBe(false);
	});

	// responses-only 的模型(o1-pro 这类)在 /chat/completions 上是 404 ——
	// 探活打错端点,用户就被自己的探活永久挡在门外,而真聊天路径本来能通。
	it("responses 风味 → 打 /responses,body 是 input 形状且不带 temperature", async () => {
		fetchMock.mockResolvedValue(okJson());
		const r = await probeAiProvider({ ...fields, model: "o1-pro", apiFlavor: "responses" });
		expect(r.ok).toBe(true);
		expect(call(0).url).toBe("https://api.example.com/responses");
		expect(call(0).body.input).toBeDefined();
		expect(call(0).body.messages).toBeUndefined();
		// o 系推理模型会 400 拒掉 temperature —— 探活自己不能先踩雷
		expect("temperature" in call(0).body).toBe(false);
	});

	it("打出去的请求:POST + JSON 头 + Bearer 鉴权 + 固定的 ping 体", async () => {
		fetchMock.mockResolvedValue(okJson());
		await probeAiProvider({ ...fields, apiKey: "sk-test", apiFlavor: "chat" });
		await probeAiProvider({ ...fields, apiKey: "sk-test", apiFlavor: "responses" });
		expect(call(0).init.method).toBe("POST");
		expect(call(0).init.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer sk-test",
		});
		expect(call(0).body).toEqual({
			model: "m",
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 5,
			stream: false,
		});
		expect(call(1).body).toEqual({
			model: "m",
			input: [{ role: "user", content: "ping" }],
			max_output_tokens: 16,
			stream: false,
		});
	});
});

describe("probeAiProvider — 没过的带标准码", () => {
	it.each(["apiKey", "baseUrl", "model"] as const)("%s 是空的 → not_configured", async (field) => {
		const r = await probeAiProvider({ ...fields, [field]: "" });
		expect(r).toMatchObject({ ok: false, code: "not_configured" });
		expect(r.ok === false && r.message).toContain(field);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		[401, "not_configured"],
		[403, "not_configured"],
		[404, "not_configured"],
		[429, "rate_limited"],
		[500, "unavailable"],
		[503, "unavailable"],
		[400, "unavailable"],
	] as const)("HTTP %i → %s,状态码放 upstreamCode", async (status, code) => {
		fetchMock.mockResolvedValue(httpResponse(status));
		const r = await probeAiProvider(fields);
		expect(r).toMatchObject({ ok: false, code, upstreamCode: status });
		expect(r.ok === false && r.message).toContain(`HTTP ${status}`);
	});

	it("连不上 → unavailable,话里带底层的原因", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));
		const r = await probeAiProvider(fields);
		expect(r).toMatchObject({ ok: false, code: "unavailable" });
		expect(r.ok === false && r.message).toContain("fetch failed");
	});

	it("失败的 message 原样带响应(截 200 字)与 baseUrl;空响应写 (空)", async () => {
		fetchMock.mockResolvedValueOnce(httpResponse(401, "x".repeat(250)));
		const long = await probeAiProvider(fields);
		expect(long.ok === false && long.message).toBe(
			`主人，apiKey 鉴权失败（HTTP 401）。响应：${"x".repeat(200)}…`,
		);
		fetchMock.mockResolvedValueOnce(httpResponse(404, ""));
		const empty = await probeAiProvider(fields);
		expect(empty.ok === false && empty.message).toBe(
			'主人，model "m" 不存在或 baseUrl 路径不对（HTTP 404）。响应：(空)',
		);
		fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
		const down = await probeAiProvider(fields);
		expect(down.ok === false && down.message).toBe(
			"主人，连接 https://api.example.com 失败：fetch failed。请检查 baseUrl 拼写、网络可达性与 TLS 证书。",
		);
	});

	it("超时 → timeout", async () => {
		const err = new Error("aborted");
		err.name = "AbortError";
		fetchMock.mockRejectedValue(err);
		const r = await probeAiProvider(fields);
		expect(r).toMatchObject({ ok: false, code: "timeout" });
	});
});

it("reads configuration error text at the call without making a request", async () => {
	const bound = bindPackageText(() => "Current configuration error");
	try {
		const result = await probeAiProvider({ ...fields, apiKey: "" });
		expect(result).toMatchObject({
			ok: false,
			code: "not_configured",
			message: "Current configuration error",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	} finally {
		bound.dispose();
	}
});

it("localizes probe failures while preserving upstream diagnostics and classification", async () => {
	const texts = createI18n<PackageTextKey, Locale>({
		dicts: withPackageDicts({
			"zh-CN": { plain: {} },
			en: { plain: {} },
			ja: { plain: {} },
			"zh-TW": { plain: {} },
		}),
		fallback: "zh-CN",
		locale: "zh-CN",
		voice: "plain",
	});
	const binding = bindPackageText(texts.t);
	try {
		for (const [locale, message] of [
			["en", "apiKey authentication failed (HTTP 401). Response: 原始原因"],
			["ja", "apiKeyの認証に失敗しました（HTTP 401）。レスポンス：原始原因"],
			["zh-TW", "apiKey 驗證失敗（HTTP 401）。回應：原始原因"],
		] as const) {
			texts.set({ locale });
			fetchMock.mockResolvedValue(httpResponse(401, "原始原因"));
			expect(await probeAiProvider(fields)).toMatchObject({
				ok: false,
				code: "not_configured",
				upstreamCode: 401,
				message,
			});
		}
		expect(fetchMock).toHaveBeenCalledTimes(3);
	} finally {
		binding.dispose();
	}
});
