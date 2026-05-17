import type { LogEntry } from "../ws/types.js";

/**
 * Credential scrub applied at the single log fan-out point, BEFORE the entry
 * is teed to either the WS ring (browser) or the on-disk archive. After this
 * pass the cleartext secret is gone from both sinks — irreversible.
 *
 * Scope (grilled spec): the five shapes we actually emit / could leak —
 *   - `SESSDATA=<v>`            (B 站会话 cookie)
 *   - `bili_jct=<v>`            (CSRF token cookie)
 *   - `refresh_token` 值        (cookie 形 / JSON 形)
 *   - `sk-xxxx`                 (OpenAI 兼容 apiKey)
 *   - `Bearer <token>`          (Authorization header echo)
 *
 * Defense-in-depth — most paths already redact upstream (sanitizeErr in
 * @bilibili-notify/ai, cookies-refreshed strip in ws/channels.ts). This is the
 * last net so a stray `logger.info("...", cookieString)` never reaches disk.
 */

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
function scrubValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
	if (typeof value === "string") return scrubSecrets(value);
	if (value === null || typeof value !== "object") return value;
	if (depth >= MAX_DEPTH) return "[depth-capped]";
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	if (Array.isArray(value)) {
		return value.map((v) => scrubValue(v, seen, depth + 1));
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		out[k] = scrubValue(v, seen, depth + 1);
	}
	return out;
}

/**
 * Return a copy of the entry with `msg` + every `args` element scrubbed. The
 * level / ts / name carry no secrets and pass through untouched.
 */
export function redactLogEntry(entry: LogEntry): LogEntry {
	const seen = new WeakSet<object>();
	return {
		...entry,
		msg: scrubSecrets(entry.msg),
		args: entry.args.map((a) => scrubValue(a, seen, 0)),
	};
}
