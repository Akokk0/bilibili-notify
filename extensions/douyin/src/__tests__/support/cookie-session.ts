import { CookieJar } from "tough-cookie";

// The host owns the real implementation. This fixture only exchanges HTTP headers in memory.
export function testCookieSession(saved?: string) {
	const jar =
		saved === undefined ? new CookieJar() : CookieJar.deserializeSync(JSON.parse(saved).session);
	return {
		header(url: string) {
			return jar.getCookieStringSync(url);
		},
		ingest(url: string, line: string) {
			jar.setCookieSync(line, url, { ignoreError: true });
		},
		snapshot() {
			return JSON.stringify({ session: jar.serializeSync() });
		},
	};
}
