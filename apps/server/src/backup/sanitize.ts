/**
 * Sanitization core for the backup feature.
 *
 * The sanitized backup must never carry a credential. Rather than enumerate
 * every platform-specific secret field (a denylist that silently rots as new
 * connection/target platforms land), {@link redactSecretKeys} walks the whole tree
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
 * denylist structurally cannot see — `?access_token=` in the query, `user:pass@`
 * in the userinfo, and for 飞书 / 钉钉 style webhooks the token **is the path** —
 * so no part of a network URL can be assumed safe. The whole thing is replaced
 * by {@link REDACTED_URL}, keeping only the scheme so the sanitized config still
 * satisfies `z.url()` and OneBot's `wss?://` regex on import.
 */
export const URL_KEYS: readonly string[] = ["url", "baseUrl"];

/**
 * Schemes we know how to hand back as a valid placeholder. Anything else (a
 * `data:` URI, a relative path, the empty-string default on `ai.baseUrl`) is
 * left untouched — rewriting it would turn "not configured" into "configured
 * wrong", and none of them is an endpoint that can carry a bearer token.
 */
const PLACEHOLDER_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * Host used for the placeholder. `.invalid` is reserved by RFC 2606 and can
 * never resolve, so a restored backup whose endpoint was not refilled fails
 * loudly at DNS instead of quietly reaching some other real host.
 */
const REDACTED_URL_HOST = "redacted.invalid";

const SECRET_KEY_SET = new Set<string>(SECRET_KEYS);
const SECRET_CONTAINER_SET = new Set<string>(SECRET_CONTAINER_KEYS);
const URL_KEY_SET = new Set<string>(URL_KEYS);

/**
 * Deep-clone `value`, replacing every leaf whose key is in {@link SECRET_KEYS}
 * with `""`. Does not mutate the input. Arrays and nested objects are walked.
 */
/**
 * @param extraSecretKeys 额外算作密钥的键名 —— **拓展在字段表里声明 `secret: true` 的那些**。
 *
 * 上面那份黑名单只认约定俗成的名字,而拓展的 config 形状归它自己定:叫 `botKey` 的密钥
 * 黑名单结构性地看不见,于是原样进备份文件 —— 而备份是主人会发出去求助的东西。
 * 所以密钥要**声明**出来,不能靠猜。
 */
export function redactSecretKeys<T>(value: T, extraSecretKeys: readonly string[] = []): T {
	const secrets =
		extraSecretKeys.length > 0 ? new Set([...SECRET_KEY_SET, ...extraSecretKeys]) : SECRET_KEY_SET;
	return redact(value, secrets) as T;
}

function redact(value: unknown, secrets: ReadonlySet<string> = SECRET_KEY_SET): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => redact(entry, secrets));
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) {
			if (secrets.has(key)) out[key] = "";
			else if (SECRET_CONTAINER_SET.has(key)) out[key] = blankLeaves(v);
			else if (URL_KEY_SET.has(key)) out[key] = redactUrl(v, secrets);
			else out[key] = redact(v, secrets);
		}
		return out;
	}
	return value;
}

/** Replace a network URL with a scheme-preserving placeholder. */
function redactUrl(value: unknown, secrets: ReadonlySet<string>): unknown {
	if (typeof value !== "string") return redact(value, secrets);
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		// 不是绝对 URL(默认空串、相对路径、占位文本)—— 原样留着。
		return value;
	}
	if (!PLACEHOLDER_SCHEMES.has(parsed.protocol)) return value;
	return `${parsed.protocol}//${REDACTED_URL_HOST}/`;
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
