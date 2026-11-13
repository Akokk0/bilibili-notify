import { CookieJar, isCookiePublicSuffix } from "@bilibili-notify/http";
import type { ExtensionContext } from "@bilibili-notify/internal/extension";
import { z } from "zod";

const key = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const cookie = z.strictObject({
	key: z.string().regex(key),
	value: z.string().refine((value) => !/[;\r\n\0]/.test(value)),
	domain: z
		.string()
		.min(1)
		.refine(
			(domain) => !domain.startsWith(".") && URL.parse(`https://${domain}/`)?.hostname === domain,
		),
	path: z.string().startsWith("/"),
	expires: z.union([
		z.literal("Infinity"),
		z.string().refine((value) => {
			const date = new Date(value);
			return Number.isFinite(date.getTime()) && date.toISOString() === value;
		}),
	]),
	secure: z.boolean(),
	httpOnly: z.boolean(),
	hostOnly: z.boolean().optional(),
	sameSite: z.string().optional(),
});
const snapshotSchema = z.strictObject({
	cookies: z.array(cookie.refine((c) => c.hostOnly || !isCookiePublicSuffix(c.domain))),
});

function httpUrl(input: string) {
	const url = URL.parse(input);
	if (!url || !(url.protocol === "https:" || url.protocol === "http:"))
		throw new TypeError("Invalid cookie URL");
	return url;
}

export function createCookieSession(
	snapshot: string | undefined,
	redact: (value: string) => void,
	signal: AbortSignal,
): ReturnType<ExtensionContext["createCookieSession"]> {
	const jar = new CookieJar();
	if (snapshot !== undefined) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(snapshot);
		} catch {
			throw new TypeError("Invalid cookie snapshot");
		}
		const result = snapshotSchema.safeParse(parsed);
		if (!result.success) throw new TypeError("Invalid cookie snapshot");
		jar.load(result.data.cookies);
		for (const cookie of jar.serialize()) redact(cookie.value);
	}
	return {
		header(url) {
			signal.throwIfAborted();
			return jar.cookieHeaderFor(httpUrl(url));
		},
		ingest(url, line) {
			signal.throwIfAborted();
			const origin = httpUrl(url);
			const eq = line.indexOf("=");
			if (eq < 1 || !key.test(line.slice(0, eq).trim()) || /[\r\n\0]/.test(line)) return;
			jar.setFromSetCookie(line, origin);
			const end = line.indexOf(";", eq + 1);
			redact(line.slice(eq + 1, end === -1 ? undefined : end).trim());
		},
		snapshot() {
			signal.throwIfAborted();
			return JSON.stringify({ cookies: jar.serialize() });
		},
	};
}
