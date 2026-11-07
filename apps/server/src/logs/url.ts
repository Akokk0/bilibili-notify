/** Diagnostic URL only; never feed this value back into a request. */
export function logUrl(raw: string): string {
	try {
		const url = new URL(raw);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return "invalid-url";
	}
}
