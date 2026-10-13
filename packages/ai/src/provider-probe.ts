import { fail, ok, type Result } from "@bilibili-notify/internal";

/** 探活要用的那份实例连接字段(面板保存时 merge 之后的值)。 */
export interface AiProbeFields {
	apiKey: string;
	baseUrl: string;
	model: string;
	apiFlavor: string;
}

/**
 * AI 连接探活:拿一份服务商配置真打一次 ping。端点必须跟实例的接口风味走。
 * 没过的一律是带标准码的失败,`message` 面板原样内联显示。
 */
export async function probeAiProvider(fields: AiProbeFields): Promise<Result> {
	if (!fields.apiKey) return fail("not_configured", "apiKey 字段为空，启用 AI 前请先填写。");
	if (!fields.baseUrl) return fail("not_configured", "baseUrl 字段为空，启用 AI 前请先填写。");
	if (!fields.model) return fail("not_configured", "model 字段为空，启用 AI 前请先填写。");

	// 探活打的端点跟实例的接口风味走 —— responses-only 的模型(o1-pro 这类)在
	// /chat/completions 上是 404,打错端点等于把用户永久挡在自己的探活门外,
	// 而真正的聊天路径本来能通。两种 ping 都不带 temperature:真聊天路径一律不发它,
	// 而 o 系推理模型、Claude Opus 4.7 起的模型收到它会 400 —— 探活自己不能先踩雷。
	const base = fields.baseUrl.replace(/\/+$/, "");
	const responses = fields.apiFlavor === "responses";
	const url = responses ? `${base}/responses` : `${base}/chat/completions`;
	const body = responses
		? {
				model: fields.model,
				input: [{ role: "user", content: "ping" }],
				max_output_tokens: 16,
				stream: false,
			}
		: {
				model: fields.model,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 5,
				stream: false,
			};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${fields.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (res.ok) return ok();
		const text = await res.text().catch(() => "");
		return failureOfAiHttpError(res.status, text, fields);
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			return fail("timeout", `连接 ${fields.baseUrl} 超时（10s），请检查 baseUrl 与网络。`);
		}
		const detail = err instanceof Error ? err.message : String(err);
		return fail(
			"unavailable",
			`连接 ${fields.baseUrl} 失败：${detail}。请检查 baseUrl 拼写、网络可达性与 TLS 证书。`,
		);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 探活遇到的 HTTP 错 → 带码的失败,状态码原样放 `upstreamCode`(平台自己的码不占 `code`)。
 * key 被拒 / model 或路径不对是要主人回去改的配置 → `not_configured`(不是 `unauthorized`:那个码
 * 留给「看板自己没登录」一类,而面板对 401 有全局反应);被限速 `rate_limited`;服务端错和别的
 * 一律 `unavailable`。
 */
function failureOfAiHttpError(status: number, text: string, fields: AiProbeFields): Result {
	const truncated = text.length > 200 ? `${text.slice(0, 200)}…` : text;
	const upstreamCode = status;
	if (status === 401 || status === 403) {
		return fail(
			"not_configured",
			`apiKey 鉴权失败（HTTP ${status}）。响应：${truncated || "(空)"}`,
			{
				upstreamCode,
			},
		);
	}
	if (status === 404) {
		return fail(
			"not_configured",
			`model "${fields.model}" 不存在或 baseUrl 路径不对（HTTP 404）。响应：${truncated || "(空)"}`,
			{ upstreamCode },
		);
	}
	if (status === 429) {
		return fail("rate_limited", `请求被限速（HTTP 429）。响应：${truncated || "(空)"}`, {
			upstreamCode,
		});
	}
	if (status >= 500) {
		return fail("unavailable", `服务端错误（HTTP ${status}）。响应：${truncated || "(空)"}`, {
			upstreamCode,
		});
	}
	return fail("unavailable", `请求失败（HTTP ${status}）。响应：${truncated || "(空)"}`, {
		upstreamCode,
	});
}
