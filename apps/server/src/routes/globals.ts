import { Hono } from "hono";
import { z } from "zod";
import { ConfigValidationError } from "../config/store.js";
import type { StandalonePuppeteer } from "../runtime/puppeteer.js";
import type { RouteDeps } from "./types.js";

/**
 * GET 返回 globals 时,把 `defaults.ai.apiKey` 替换成这个 sentinel,**永不**把真实 key
 * 通过 REST 暴露给浏览器。PATCH 收到这个 sentinel 视为「保留原值」(用户没动这个字段)。
 *
 * 注意保持长度 ≠ 任何合理 apiKey 长度,避免被认成"用户改了一个奇怪的字符串"。
 */
const REDACTED_API_KEY = "__BN_REDACTED__";

/**
 * `/api/globals` — read + patch the runtime GlobalConfig.
 *
 * - GET: returns a snapshot
 * - PATCH: accepts a deep-partial JSON body, merges, validates, persists
 *
 * No PUT (full set) — keep the API surface deliberately small until a UI demands it.
 *
 * Enable-check pre-flight (plan: 启用前验证):
 * When the resulting config would have `defaults.cardStyle.enabled = true` or
 * `defaults.ai.enabled = true`, we actively probe before letting the patch
 * land. For image we require puppeteer to be wired AND able to spawn a page;
 * for AI we require apiKey/baseUrl/model + a successful OpenAI-compatible
 * chat completion. Failures surface as `400 enable_check_failed` with a
 * `message` the dashboard renders inline (Cards.tsx / Ai.tsx already wire
 * `ApiError.message` into their existing error bar).
 */
export function createGlobalsRoute(deps: RouteDeps): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	app.get("/", (c) => c.json(redactGlobals(deps.store.getGlobals())));

	app.patch("/", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch (_err) {
			return c.json({ error: "invalid_json", message: "request body must be valid JSON" }, 400);
		}
		// We accept any shape here; the merged result is re-validated by Zod inside the store.
		// Cheap upfront guard: must be an object (not array / scalar).
		const shapeCheck = z.record(z.string(), z.unknown()).safeParse(body);
		if (!shapeCheck.success) {
			return c.json(
				{
					error: "invalid_payload",
					message: "PATCH /api/globals body must be a JSON object",
					issues: shapeCheck.error.issues,
				},
				400,
			);
		}
		// 把 REDACTED sentinel 从 patch 里剥掉:前端 GET 拿到的是 redact 占位,如果
		// 用户没在 UI 改 apiKey,PATCH body 会把占位原样回传 — 视为"保留原值"。
		const patch = stripRedactedSecrets(shapeCheck.data);
		// Enable-check pre-flight. Runs against the *merged* view so a request
		// that only toggles `enabled=true` without restating apiKey still works
		// (we read the still-persisted value as the effective field).
		const enableCheck = await runEnableCheck({
			current: deps.store.getGlobals(),
			patch,
			puppeteer: deps.puppeteer,
		});
		if (!enableCheck.ok) {
			return c.json(
				{ error: "enable_check_failed", scope: enableCheck.scope, message: enableCheck.message },
				400,
			);
		}
		try {
			const next = await deps.store.patchGlobals(patch);
			return c.json(redactGlobals(next));
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, 400);
			}
			log.error("PATCH /api/globals failed", err);
			throw err;
		}
	});

	return app;
}

// ---------------------------------------------------------------------------
// Enable check
// ---------------------------------------------------------------------------

type EnableCheckResult = { ok: true } | { ok: false; scope: "cardStyle" | "ai"; message: string };

interface EnableCheckArgs {
	current: import("@bilibili-notify/internal").GlobalConfig;
	patch: Record<string, unknown>;
	puppeteer: StandalonePuppeteer | null;
}

async function runEnableCheck(args: EnableCheckArgs): Promise<EnableCheckResult> {
	// Per-scope gating: the check only fires when *this* PATCH actually touches
	// the scope. Otherwise saving the Cards tab would re-validate the live AI
	// connection (and vice versa) simply because the persisted state already had
	// `enabled = true`. Each dashboard tab now only validates what it owns.
	const touchesCardStyle = pluck(args.patch, ["defaults", "cardStyle"]) !== undefined;
	const touchesAi = pluck(args.patch, ["defaults", "ai"]) !== undefined;

	if (touchesCardStyle) {
		const cardEnabled = mergedFlag(
			args.current.defaults.cardStyle.enabled,
			pluck(args.patch, ["defaults", "cardStyle", "enabled"]),
		);
		if (cardEnabled) {
			const r = await checkCardEnable(args.puppeteer);
			if (!r.ok) return r;
		}
	}

	if (touchesAi) {
		const aiEnabled = mergedFlag(
			args.current.defaults.ai.enabled,
			pluck(args.patch, ["defaults", "ai", "enabled"]),
		);
		if (aiEnabled) {
			const apiKey = mergedString(
				args.current.defaults.ai.apiKey,
				pluck(args.patch, ["defaults", "ai", "apiKey"]),
			);
			const baseUrl = mergedString(
				args.current.defaults.ai.baseUrl,
				pluck(args.patch, ["defaults", "ai", "baseUrl"]),
			);
			const model = mergedString(
				args.current.defaults.ai.model,
				pluck(args.patch, ["defaults", "ai", "model"]),
			);
			const r = await checkAiEnable({ apiKey, baseUrl, model });
			if (!r.ok) return r;
		}
	}

	return { ok: true };
}

// ── Image / puppeteer probe ────────────────────────────────────────────────

async function checkCardEnable(puppeteer: StandalonePuppeteer | null): Promise<EnableCheckResult> {
	if (!puppeteer) {
		return {
			ok: false,
			scope: "cardStyle",
			message:
				"chromePath 未配置，无法启用卡片渲染。请在服务端 yaml 或 BN_CHROME_PATH 环境变量中配置 Chromium / Chrome 路径后重启。",
		};
	}
	try {
		const page = await puppeteer.page();
		try {
			await page.close();
		} catch {
			// best-effort; closing the probe page should not surface
		}
		return { ok: true };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			scope: "cardStyle",
			message: `puppeteer 启动失败：${detail}。请确认 chromePath 指向可执行的 Chromium / Chrome 二进制。`,
		};
	}
}

// ── AI connectivity probe ──────────────────────────────────────────────────

interface AiProbeFields {
	apiKey: string;
	baseUrl: string;
	model: string;
}

async function checkAiEnable(fields: AiProbeFields): Promise<EnableCheckResult> {
	if (!fields.apiKey) {
		return { ok: false, scope: "ai", message: "apiKey 字段为空，启用 AI 前请先填写。" };
	}
	if (!fields.baseUrl) {
		return { ok: false, scope: "ai", message: "baseUrl 字段为空，启用 AI 前请先填写。" };
	}
	if (!fields.model) {
		return { ok: false, scope: "ai", message: "model 字段为空，启用 AI 前请先填写。" };
	}

	const url = `${fields.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${fields.apiKey}`,
			},
			body: JSON.stringify({
				model: fields.model,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 5,
				temperature: 0,
				stream: false,
			}),
			signal: controller.signal,
		});
		if (res.ok) return { ok: true };
		const text = await res.text().catch(() => "");
		return { ok: false, scope: "ai", message: mapAiHttpError(res.status, text, fields) };
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			return {
				ok: false,
				scope: "ai",
				message: `连接 ${fields.baseUrl} 超时（10s），请检查 baseUrl 与网络。`,
			};
		}
		const detail = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			scope: "ai",
			message: `连接 ${fields.baseUrl} 失败：${detail}。请检查 baseUrl 拼写、网络可达性与 TLS 证书。`,
		};
	} finally {
		clearTimeout(timer);
	}
}

function mapAiHttpError(status: number, text: string, fields: AiProbeFields): string {
	const truncated = text.length > 200 ? `${text.slice(0, 200)}…` : text;
	if (status === 401 || status === 403) {
		return `apiKey 鉴权失败（HTTP ${status}）。响应：${truncated || "(空)"}`;
	}
	if (status === 404) {
		return `model "${fields.model}" 不存在或 baseUrl 路径不对（HTTP 404）。响应：${truncated || "(空)"}`;
	}
	if (status === 429) {
		return `请求被限速（HTTP 429）。响应：${truncated || "(空)"}`;
	}
	if (status >= 500) {
		return `服务端错误（HTTP ${status}）。响应：${truncated || "(空)"}`;
	}
	return `请求失败（HTTP ${status}）。响应：${truncated || "(空)"}`;
}

// ── Merge helpers ──────────────────────────────────────────────────────────

function pluck(root: Record<string, unknown>, path: string[]): unknown {
	let cur: unknown = root;
	for (const key of path) {
		if (!cur || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
}

function mergedFlag(current: boolean, patchValue: unknown): boolean {
	return typeof patchValue === "boolean" ? patchValue : current;
}

function mergedString(current: string | undefined, patchValue: unknown): string {
	if (typeof patchValue === "string") return patchValue.trim();
	return (current ?? "").trim();
}

// ── Secret redaction ───────────────────────────────────────────────────────

/**
 * 浅复制 globals,把所有 secret 字段(目前只有 `defaults.ai.apiKey`)替换成
 * REDACTED 占位 — 仅当原值非空。空值保持空,让前端能区分"未配置"与"已配置"。
 */
function redactGlobals(
	g: import("@bilibili-notify/internal").GlobalConfig,
): import("@bilibili-notify/internal").GlobalConfig {
	const apiKey = g.defaults.ai.apiKey;
	if (!apiKey) return g;
	return {
		...g,
		defaults: {
			...g.defaults,
			ai: { ...g.defaults.ai, apiKey: REDACTED_API_KEY },
		},
	};
}

/**
 * Patch body 入口处理:用户没改 apiKey 字段时,前端会把 GET 拿到的 REDACTED 占位原样
 * 回传 — 这里识别并删掉该字段,让 patchGlobals 不会用占位字符串覆盖真实 key。
 */
function stripRedactedSecrets(patch: Record<string, unknown>): Record<string, unknown> {
	const defaults = patch.defaults;
	if (!defaults || typeof defaults !== "object") return patch;
	const ai = (defaults as Record<string, unknown>).ai;
	if (!ai || typeof ai !== "object") return patch;
	const aiObj = ai as Record<string, unknown>;
	if (aiObj.apiKey !== REDACTED_API_KEY) return patch;
	const { apiKey: _drop, ...aiRest } = aiObj;
	return {
		...patch,
		defaults: {
			...(defaults as Record<string, unknown>),
			ai: aiRest,
		},
	};
}
