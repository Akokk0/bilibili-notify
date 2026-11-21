import { type Failure, fail } from "@bilibili-notify/internal";

/** 上游业务码优先，只有 HTTP 状态时用 http: 前缀区分。 */
export function httpFailure(
	status: number,
	message: string,
	upstreamCode: number | string = `http:${status}`,
): Failure {
	if (status === 401 || status === 403) return fail("unauthorized", message, { upstreamCode });
	if (status === 404 || status === 410) return fail("not_found", message, { upstreamCode });
	if (status === 429) return fail("rate_limited", message, { upstreamCode });
	if (status >= 400 && status < 500) return fail("invalid", message, { upstreamCode });
	return fail("unavailable", message, { upstreamCode });
}
