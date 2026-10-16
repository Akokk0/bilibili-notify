/**
 * Credential scrub applied once at the log call entry (`wrapLogger` in
 * runtime/service-context.ts), BEFORE the call reaches pino (stdout), the WS
 * ring (browser) or the on-disk archive. After this pass the cleartext secret
 * is gone from all three exits — irreversible.
 *
 * Two passes over every string, in this order:
 *   1. by value — the values the integrations registered (`logs/value-redactor.ts`:
 *      every string in each integration's `secrets`, every cookie in the jar) are
 *      masked wherever they appear, whatever they look like. A number-typed arg that
 *      equals a registered value (account uid) is masked as a whole.
 *   2. by shape — the fixed patterns below, for secrets nobody registered.
 * If a pass itself fails the affected part is replaced by a placeholder (fail closed).
 *
 * Scope of the by-shape pass (grilled spec): the five shapes we actually emit / could leak —
 *   - `SESSDATA=<v>`            (B 站会话 cookie)
 *   - `bili_jct=<v>`            (CSRF token cookie)
 *   - `refresh_token` 值        (cookie 形 / JSON 形)
 *   - `sk-xxxx`                 (OpenAI 兼容 apiKey)
 *   - `Bearer <token>`          (Authorization header echo)
 *
 * Defense-in-depth — most paths already redact upstream (sanitizeErr in
 * @bilibili-notify/ai; the login bus event carries only `{ sourceKey, state }`
 * and the renewal callback only logs a fixed line, see bilibili/auth/index.ts). This is the last net so a stray `logger.info("...", cookieString)` never reaches disk.
 */

import type { ValueRedactor } from "./value-redactor.js";

type Replacer = readonly [RegExp, string];

// Each regex keeps the key/prefix so the log stays diagnosable ("which secret
// leaked where") while the value itself is masked. `g` flag — a single string
// may carry several pairs (e.g. a full Cookie header).
const REPLACERS: readonly Replacer[] = [
	// cookie-pair form: KEY=value (value = until ; , whitespace, ", or end)
	[/\b(SESSDATA)=[^;,\s"']+/gi, "$1=***"],
	[/\b(bili_jct)=[^;,\s"']+/gi, "$1=***"],
	[/\b(refresh_token)=[^;,\s"']+/gi, "$1=***"],
	// JSON / kv form: "refresh_token":"value"  |  refresh_token: value
	[/("?refresh_token"?\s*[:=]\s*")[^"]+(")/gi, "$1***$2"],
	[/\b(refresh_token)\b(\s*[:=]\s*)(?!\*\*\*)[^\s",;}]+/gi, "$1$2***"],
	// OpenAI-compatible API keys: sk- followed by ≥10 token chars
	[/\bsk-[A-Za-z0-9_-]{10,}/g, "sk-***"],
	// Authorization: Bearer <token>
	[/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
];

/** Mask known secret shapes inside a single string. Single linear pass per rule. */
export function scrubSecrets(input: string): string {
	let out = input;
	for (const [re, sub] of REPLACERS) out = out.replace(re, sub);
	return out;
}

const MAX_DEPTH = 6;

/**
 * Recursively scrub every string reachable in an arg value. Cyclic refs and
 * over-deep structures are collapsed to a marker rather than thrown — a
 * misbehaving log arg must never break the logging path.
 */
function scrubValue(
	value: unknown,
	seen: WeakSet<object>,
	depth: number,
	scrub: (text: string) => string,
	masks: (text: string) => boolean,
): unknown {
	if (typeof value === "string") return scrub(value);
	// 数字形态的值(账号 uid 之类)不是字符串,按子串遮够不着:十进制串恰好等于登记的值就整格遮掉。
	if (typeof value === "number" || typeof value === "bigint") {
		return masks(String(value)) ? "***" : value;
	}
	if (value === null || typeof value !== "object") return value;
	if (depth >= MAX_DEPTH) return "[depth-capped]";
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	if (Array.isArray(value)) {
		return value.map((v) => scrubValue(v, seen, depth + 1, scrub, masks));
	}
	const out: Record<string, unknown> = {};
	// Error 的 name / message / stack 不可枚举,Object.entries 看不见:不单独交出来,
	// 作为日志参数传进来的错误就只剩 `{}`,原文丢了。cause 同理(也递归打码)。
	if (value instanceof Error) {
		out.name = scrub(value.name);
		out.message = scrub(value.message);
		if (typeof value.stack === "string") out.stack = scrub(value.stack);
		if (value.cause !== undefined) {
			out.cause = scrubValue(value.cause, seen, depth + 1, scrub, masks);
		}
	}
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		out[k] = scrubValue(v, seen, depth + 1, scrub, masks);
	}
	return out;
}

/** 打码过程自己出错时换上的占位:失败就关 —— 宁可丢内容,不能把登记的值原样放出去。 */
const REDACTION_FAILED = "[redaction-failed]";

/**
 * 日志调用的打码口:`wrapLogger` 在调用入口调一次,打过码的 `{ msg, args }` 同时交给 pino(stdout)
 * 与日志钩子(环形缓冲 / 归档),三处出口看到的是同一份。
 *
 * 每一段字符串先按值打码(`values`)、再过固定形状的正则。打码过程自己抛错(参数里有会抛的 getter、
 * 按值那一遍出错之类)时不许弄断日志,也不许漏明文,**失败就关**:出错的那一部分整个换成占位 ——
 * msg 出错 msg 换占位;参数出错参数整体换占位(msg 自己没出错就照常交出)。
 *
 * `values`:按值打码的登记册。字符串按子串遮;数字 / bigint 形态的参数,十进制串恰好等于登记的值
 * 就整格换成 `***`(整值相等,不比子串)。不给就只跑固定形状。
 */
export function redactLogCall(
	msg: string,
	args: readonly unknown[],
	values?: Pick<ValueRedactor, "scrub" | "has">,
): { msg: string; args: unknown[] } {
	const scrub = (text: string): string => scrubSecrets(values ? values.scrub(text) : text);
	const masks = (text: string): boolean => values?.has(text) ?? false;
	let safeMsg: string;
	try {
		safeMsg = scrub(msg);
	} catch {
		safeMsg = REDACTION_FAILED;
	}
	let safeArgs: unknown[];
	try {
		const seen = new WeakSet<object>();
		safeArgs = args.map((a) => scrubValue(a, seen, 0, scrub, masks));
	} catch {
		safeArgs = args.map(() => REDACTION_FAILED);
	}
	return { msg: safeMsg, args: safeArgs };
}
