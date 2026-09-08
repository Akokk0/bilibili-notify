/**
 * Sanitization core for the backup feature.
 *
 * The sanitized backup must never carry a credential. Rather than enumerate
 * every platform-specific secret field (a denylist that silently rots as new
 * adapter/target platforms land), {@link redactSecretKeys} walks the whole tree
 * and blanks any leaf whose *key name* is a known secret. This is structural:
 * a newly-added `accessToken` under any future shape is caught for free.
 *
 * Two kinds of credential are not leaves with names of their own, so they get
 * their own structural rules: containers whose leaf names the user invents
 * ({@link SECRET_CONTAINER_KEYS} — `headers`, `keys`) and credentials embedded
 * inside a URL ({@link URL_KEYS}).
 *
 * Blanks to `""` (rather than deleting) so the object keeps its shape — an
 * imported sanitized config still parses; the user just re-enters the blanked
 * credentials. The value, never the key, is what leaks.
 */

/** Key names whose values are credentials anywhere they appear in the config tree. */
export const SECRET_KEYS: readonly string[] = [
	"apiKey",
	"accessToken",
	"refreshToken",
	"appSecret",
	"secret",
	"token",
	"password",
];

/**
 * Key names whose values are **containers of credentials**: every leaf below
 * them is a secret regardless of its own key name. `ai.search.keys` is the
 * archetype — its leaves are named after backends (`bocha`/`tavily`), so the
 * per-key denylist above can never keep up as new backends land; the container
 * name is the stable signal.
 */
export const SECRET_CONTAINER_KEYS: readonly string[] = ["keys", "headers"];

/**
 * Key names whose values are URLs. A URL carries credentials in places the key
 * denylist structurally cannot see — `?access_token=` on a webhook endpoint,
 * `user:pass@` on a bot API base — because neither is a leaf with a name of its
 * own. The query string and the userinfo are dropped; scheme, host and path
 * survive, so a sanitized backup still shows where the connection pointed and
 * still satisfies the `z.url()` / `wss?://` constraints on import.
 */
export const URL_KEYS: readonly string[] = ["url", "baseUrl"];

const SECRET_KEY_SET = new Set<string>(SECRET_KEYS);
const SECRET_CONTAINER_SET = new Set<string>(SECRET_CONTAINER_KEYS);
const URL_KEY_SET = new Set<string>(URL_KEYS);

/**
 * Deep-clone `value`, replacing every leaf whose key is in {@link SECRET_KEYS}
 * with `""`. Does not mutate the input. Arrays and nested objects are walked.
 */
export function redactSecretKeys<T>(value: T): T {
	return redact(value) as T;
}

function redact(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(redact);
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) {
			if (SECRET_KEY_SET.has(key)) out[key] = "";
			else if (SECRET_CONTAINER_SET.has(key)) out[key] = blankLeaves(v);
			else if (URL_KEY_SET.has(key)) out[key] = stripUrlCredentials(v);
			else out[key] = redact(v);
		}
		return out;
	}
	return value;
}

/**
 * Drop the query string and the userinfo from a URL, leaving everything else
 * byte-identical. Returns the input untouched when there is nothing to strip —
 * `new URL().href` normalises (adds a trailing slash, lowercases the host), and
 * a sanitized backup must not quietly rewrite an endpoint that leaked nothing.
 */
function stripUrlCredentials(value: unknown): unknown {
	if (typeof value !== "string") return redact(value);
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		// 不是绝对 URL(默认空串、相对路径、占位文本)—— 原样留着。
		return value;
	}
	if (!parsed.search && !parsed.username && !parsed.password) return value;
	parsed.search = "";
	parsed.username = "";
	parsed.password = "";
	return parsed.href;
}

/** Blank every leaf under a secret container, keeping the shape intact. */
function blankLeaves(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(blankLeaves);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) out[key] = blankLeaves(v);
		return out;
	}
	return "";
}
