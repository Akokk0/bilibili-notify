import { Buffer } from "node:buffer";
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { readCookie } from "./cookie.js";

/**
 * Stateless signed-cookie dashboard session (plan: dashboard-session-auth).
 *
 * Replaces browser-native HTTP Basic — Basic has no clean logout (the browser
 * caches credentials with no JS-reachable way to forget them). The session
 * cookie is a server-issued, signed, time-limited token the SPA never reads
 * (httpOnly); logout = clear it.
 *
 * Token = `base64url(JSON{v,exp}) "." HMAC-SHA256`. No server-side session
 * store: the signing key is derived once via HKDF from the runtime's stable
 * key material (the same key infra StorageManager uses — `cookieEncryptionKey`
 * when `BN_COOKIE_KEY` is set, else the persisted random master.key), with the
 * info label providing domain separation from cookie/secret encryption.
 *
 * The credential fingerprint (`sha256(user:pass)`) is folded into the HKDF
 * salt: rotating the configured dashboard username/password changes the
 * derived key, so every previously issued cookie's HMAC stops verifying —
 * "logout everywhere on password change" with zero state.
 */

const COOKIE_NAME = "bn_session";
const HKDF_INFO = "bn-dashboard-session-v1";
const TOKEN_VERSION = 1;
/** Sliding idle window — re-issued past half-life (Q2 locked: 7d idle). */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionCreds {
	username: string;
	password: string;
}

interface SessionPayload {
	v: number;
	/** Absolute expiry, epoch ms. */
	exp: number;
}

export interface SessionCodec {
	readonly cookieName: string;
	readonly ttlMs: number;
	/** Issue a fresh signed token valid for `ttlMs` from `now`. */
	sign(now?: number): string;
	/** True iff token signature + version + non-expiry all hold. */
	verify(token: string | undefined | null, now?: number): boolean;
	/**
	 * True iff `token` is currently valid AND past its half-life — the gate
	 * uses this to slide the window by re-issuing a fresh Set-Cookie.
	 */
	shouldReissue(token: string | undefined | null, now?: number): boolean;
	/** `Set-Cookie` value establishing a fresh session. */
	buildSetCookie(token: string, opts: { secure: boolean }): string;
	/** `Set-Cookie` value that immediately clears the session cookie. */
	buildClearCookie(opts: { secure: boolean }): string;
	/** Extract the `bn_session` value out of a raw `Cookie` request header. */
	readCookie(cookieHeader: string | undefined | null): string | undefined;
}

export interface CreateSessionCodecOptions {
	/**
	 * Stable key material — pass `await keyProvider.getKey()`. This is the same
	 * 32-byte key StorageManager uses (passphrase-derived from
	 * `cookieEncryptionKey`, or the persisted random master.key). Stable across
	 * restarts in both modes, so sessions survive a server restart.
	 */
	keyMaterial: Buffer;
	/** Configured dashboard credentials — folded into the HKDF salt. */
	creds: SessionCreds;
	/** Override the sliding idle TTL (tests). Defaults to 7 days. */
	ttlMs?: number;
}

export function createSessionCodec(opts: CreateSessionCodecOptions): SessionCodec {
	const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	// NUL separator (not ":") so the fingerprint is unambiguous — `a:b`/`c`
	// and `a`/`b:c` must derive different keys. A NUL byte can't appear in a
	// realistic username/password.
	const credFp = createHash("sha256")
		.update(opts.creds.username, "utf8")
		.update(Buffer.from([0]))
		.update(opts.creds.password, "utf8")
		.digest();
	const key = Buffer.from(hkdfSync("sha256", opts.keyMaterial, credFp, HKDF_INFO, 32));

	function mac(payloadB64: string): string {
		return createHmac("sha256", key).update(payloadB64).digest("base64url");
	}

	function parse(token: string | undefined | null): SessionPayload | null {
		if (!token) return null;
		const dot = token.indexOf(".");
		if (dot <= 0 || dot === token.length - 1) return null;
		const payloadB64 = token.slice(0, dot);
		const sig = token.slice(dot + 1);
		const expected = mac(payloadB64);
		const a = Buffer.from(sig, "utf8");
		const b = Buffer.from(expected, "utf8");
		if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
		try {
			const payload = JSON.parse(
				Buffer.from(payloadB64, "base64url").toString("utf8"),
			) as SessionPayload;
			if (payload?.v !== TOKEN_VERSION || typeof payload.exp !== "number") return null;
			return payload;
		} catch {
			return null;
		}
	}

	function sign(now = Date.now()): string {
		const payload: SessionPayload = { v: TOKEN_VERSION, exp: now + ttlMs };
		const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
		return `${payloadB64}.${mac(payloadB64)}`;
	}

	function verify(token: string | undefined | null, now = Date.now()): boolean {
		const p = parse(token);
		return !!p && p.exp > now;
	}

	function shouldReissue(token: string | undefined | null, now = Date.now()): boolean {
		const p = parse(token);
		if (!p || p.exp <= now) return false;
		const issuedAt = p.exp - ttlMs;
		return now - issuedAt >= ttlMs / 2;
	}

	function attrs(secure: boolean): string {
		// SameSite=Strict: the dashboard is a same-origin SPA with no cross-site
		// flows. Secure only when the request arrived over https (direct or via
		// a TLS-terminating proxy) — forcing it would make plain-http LAN
		// deployments unable to receive the cookie at all.
		return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
	}

	return {
		cookieName: COOKIE_NAME,
		ttlMs,
		sign,
		verify,
		shouldReissue,
		buildSetCookie(token, { secure }) {
			return `${COOKIE_NAME}=${token}; Max-Age=${Math.floor(ttlMs / 1000)}; ${attrs(secure)}`;
		},
		buildClearCookie({ secure }) {
			return `${COOKIE_NAME}=; Max-Age=0; ${attrs(secure)}`;
		},
		readCookie(cookieHeader) {
			return readCookie(cookieHeader, COOKIE_NAME);
		},
	};
}
