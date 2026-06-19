import { Buffer } from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import { createSessionCodec } from "../session.js";

const KEY = Buffer.from("test-key-material-32-bytes-long!!", "utf8");
const CREDS = { username: "admin", password: "s3cret" };

function codec(ttlMs?: number) {
	return createSessionCodec({ keyMaterial: KEY, creds: CREDS, ttlMs });
}

describe("session codec", () => {
	it("sign → verify round-trips for a fresh token", () => {
		const c = codec();
		const t = c.sign();
		expect(c.verify(t)).toBe(true);
	});

	it("rejects an expired token", () => {
		const c = codec(1000);
		const now = 10_000;
		const t = c.sign(now);
		expect(c.verify(t, now + 500)).toBe(true);
		expect(c.verify(t, now + 1001)).toBe(false);
	});

	it("rejects a tampered signature / payload", () => {
		const c = codec();
		const t = c.sign();
		const [payload, sig] = t.split(".");
		expect(c.verify(`${payload}.${sig}x`)).toBe(false);
		// Flip the payload but keep the old signature.
		const forged = Buffer.from(JSON.stringify({ v: 1, exp: Date.now() + 1e9 }), "utf8").toString(
			"base64url",
		);
		expect(c.verify(`${forged}.${sig}`)).toBe(false);
		expect(c.verify(undefined)).toBe(false);
		expect(c.verify("not-a-token")).toBe(false);
	});

	it("a token does not verify under a different credential fingerprint", () => {
		const a = codec();
		const t = a.sign();
		const b = createSessionCodec({
			keyMaterial: KEY,
			creds: { username: "admin", password: "rotated" },
		});
		// Rotating the dashboard password invalidates every old cookie.
		expect(b.verify(t)).toBe(false);
	});

	it("credential fingerprint is unambiguous (NUL-separated, not ':'-joined)", () => {
		// Regression guard for the post-audit hardening: with a ':' join,
		// {user:"a:b",pass:"c"} and {user:"a",pass:"b:c"} would derive the
		// SAME signing key and cross-verify. The NUL separator prevents that.
		const x = createSessionCodec({ keyMaterial: KEY, creds: { username: "a:b", password: "c" } });
		const y = createSessionCodec({ keyMaterial: KEY, creds: { username: "a", password: "b:c" } });
		expect(y.verify(x.sign())).toBe(false);
		expect(x.verify(y.sign())).toBe(false);
	});

	it("shouldReissue: false when fresh, true past half-life, false when expired", () => {
		const c = codec(1000);
		const now = 100_000;
		const t = c.sign(now);
		expect(c.shouldReissue(t, now + 100)).toBe(false);
		expect(c.shouldReissue(t, now + 600)).toBe(true);
		expect(c.shouldReissue(t, now + 2000)).toBe(false);
		expect(c.shouldReissue(undefined, now)).toBe(false);
	});

	it("readCookie extracts only bn_session", () => {
		const c = codec();
		expect(c.readCookie("a=1; bn_session=abc.def; x=y")).toBe("abc.def");
		expect(c.readCookie("other=1")).toBeUndefined();
		expect(c.readCookie(undefined)).toBeUndefined();
		expect(c.readCookie("bn_session=")).toBeUndefined();
	});

	it("buildSetCookie / buildClearCookie carry the right attributes", () => {
		const c = codec();
		const set = c.buildSetCookie(c.sign(), { secure: true });
		expect(set).toMatch(/^bn_session=/);
		expect(set).toContain("HttpOnly");
		expect(set).toContain("SameSite=Strict");
		expect(set).toContain("Secure");
		expect(set).toMatch(/Max-Age=\d+/);

		const insecure = c.buildSetCookie(c.sign(), { secure: false });
		expect(insecure).not.toContain("Secure");

		const clear = c.buildClearCookie({ secure: false });
		expect(clear).toContain("Max-Age=0");
		expect(clear).not.toContain("Secure");
	});
});
