/** 从原始 `Cookie` 请求头里按名字取一个 cookie 的值;没有或是空串都是 `undefined`。 */
export function readCookie(
	cookieHeader: string | undefined | null,
	name: string,
): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) {
			return part.slice(eq + 1).trim() || undefined;
		}
	}
	return undefined;
}
