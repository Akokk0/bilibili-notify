import { abogus, DEFAULT_ENV } from "abogus";

export const WEB = "https://www.douyin.com";
export const LOGIN = "https://login.douyin.com";
export const userAgent = DEFAULT_ENV.userAgent;
export const dict = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function retryAfter(header: string | null) {
	const value = header?.trim() ?? "";
	let delay = Number.NaN;
	if (/^\d+$/.test(value)) delay = Number(value) * 1000;
	else if (
		/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[, ]/i.test(value) &&
		/\d{2}:\d{2}:\d{2}/.test(value)
	) {
		const date = / GMT$/i.test(value) ? value : `${value} GMT`;
		delay = Date.parse(date) - Date.now();
	}
	return Number.isFinite(delay) ? Math.max(1000, delay) : 60_000;
}

export function trusted(url: URL, hosts: readonly string[]) {
	return (
		url.protocol === "https:" &&
		!url.port &&
		!url.username &&
		!url.password &&
		hosts.includes(url.hostname)
	);
}
export function sign(url: URL, pageId = DEFAULT_ENV.pageId, body = "") {
	url.searchParams.set(
		"a_bogus",
		abogus(url.searchParams.toString(), body, { env: { userAgent, pageId } }),
	);
	return url;
}

// Homepage nonce protocol. No page script is evaluated in the extension.
export function homepageSignature(nonce: string, atMs = Date.now()) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-.";
	const mix = (input: string, seed = 0) => {
		let hash = seed;
		for (let i = 0; i < input.length; i++)
			hash = Math.imul(hash ^ input.charCodeAt(i), 65599) >>> 0;
		return hash;
	};
	const word = (value: number) =>
		[24, 18, 12, 6, 0].map((shift) => alphabet[(value >>> shift) & 63]).join("");
	const seconds = (atMs / 1000) >>> 0;
	const clock = mix(`${seconds}www.douyin.com/`) % 65521;
	const digest = (Math.imul(clock, 65521) ^ seconds) >>> 0;
	const seed = mix(String(8240 * 2 ** 32 + digest));
	const identity = ((mix(userAgent, seed) % 65521) << 16) | (mix(nonce, seed) % 65521);
	const packed =
		word(digest >>> 2) +
		word(((digest & 15) << 28) | (8240 >>> 4)) +
		word((8240 << 26) | (~digest >>> 6)) +
		alphabet[~digest & 63] +
		word(identity >>> 2) +
		word(((identity & 15) << 28) | ((digest ^ 0x88120) >>> 4)) +
		word(clock);
	const signed = `_02B4Z6wo00f01${packed}`;
	let checksum = 0;
	for (let i = 0; i < signed.length; i++)
		checksum = (Math.imul(checksum, 65599) + signed.charCodeAt(i)) >>> 0;
	return signed + (checksum & 255).toString(16).padStart(2, "0");
}

// Read one name from the Cookie header already scoped by BN to this exact URL.
export function cookieValue(header: string, key: string): string | undefined {
	const prefix = `${key}=`;
	const pair = header.split(/;\s*/).find((part) => part.startsWith(prefix));
	return pair?.slice(prefix.length) || undefined;
}
