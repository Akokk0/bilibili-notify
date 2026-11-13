import { abogus, DEFAULT_ENV } from "abogus";

export const WEB = "https://www.douyin.com";
export const LOGIN = "https://login.douyin.com";
export const userAgent = DEFAULT_ENV.userAgent;
export const dict = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export function trusted(url: URL, hosts: readonly string[]) {
	return (
		url.protocol === "https:" &&
		!url.port &&
		!url.username &&
		!url.password &&
		hosts.includes(url.hostname)
	);
}
export function sign(url: URL) {
	url.searchParams.set("a_bogus", abogus(url.searchParams.toString(), "", { env: { userAgent } }));
	return url;
}

// Read one name from the Cookie header already scoped by BN to this exact URL.
export function cookieValue(header: string, key: string): string | undefined {
	const prefix = `${key}=`;
	const pair = header.split(/;\s*/).find((part) => part.startsWith(prefix));
	return pair?.slice(prefix.length) || undefined;
}
