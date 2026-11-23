import { type ExtensionContext, fail } from "@bilibili-notify/extension";

type Reason = "limited" | "verify";
const key = "requests.cooldown";

function retryDeadline(value: string | null, now: number) {
	const hint = value?.trim();
	if (!hint) return Number.NaN;
	if (/^\d+$/.test(hint)) return now + Number(hint) * 1000;
	// Date.parse 也接受 1.5 等简写日期；HTTP 日期包含星期和时分秒。
	if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[, ]/i.test(hint) || !/\d{2}:\d{2}:\d{2}/.test(hint))
		return Number.NaN;
	return Date.parse(hint.endsWith(" GMT") ? hint : `${hint} GMT`);
}

export function createCooldown(ctx: ExtensionContext) {
	const saved = ctx.state.get(key);
	let until = 0;
	let attempts = 0;
	let reason: Reason = "limited";
	if (
		saved &&
		typeof saved === "object" &&
		!Array.isArray(saved) &&
		typeof saved.until === "number" &&
		Number.isFinite(saved.until) &&
		(saved.reason === "limited" || saved.reason === "verify")
	) {
		until = saved.until;
		reason = saved.reason;
		attempts =
			typeof saved.attempts === "number" && Number.isInteger(saved.attempts)
				? Math.max(1, Math.min(saved.attempts, 7))
				: 1;
	}
	function failure() {
		return reason === "verify"
			? fail("unavailable", ctx.i18n.t("request.verify"), { upstreamCode: "huya.verify" })
			: fail("rate_limited", ctx.i18n.t("request.limited"));
	}
	function problem(message: string) {
		ctx.reportProblem({ code: "huya_requests", message, notify: false });
	}
	async function pause(why: Reason, retry: string | null = null) {
		const now = Date.now();
		const deadline = retryDeadline(retry, now);
		attempts = Math.min(7, attempts + 1);
		reason = why;
		const delay = (why === "verify" ? 300000 : 60000) * 2 ** (attempts - 1);
		until = Math.max(
			until,
			Number.isFinite(deadline) ? Math.max(now + 3000, deadline) : now + Math.min(delay, 3600000),
		);
		const stored = await ctx.state.set(key, { until, reason, attempts });
		const error = failure();
		problem(stored.ok ? error.message : ctx.i18n.t("request.storage"));
		return error;
	}
	function blocked() {
		if (until <= Date.now()) return;
		return failure();
	}
	async function recovered() {
		if (!until || until > Date.now()) return;
		const removed = await ctx.state.delete(key);
		if (!removed.ok) return problem(ctx.i18n.t("request.storage"));
		until = 0;
		attempts = 0;
		ctx.resolveProblem({ code: "huya_requests" });
	}
	if (until > Date.now()) problem(failure().message);
	return {
		blocked,
		pause,
		recovered,
		probing: () => until > 0 && until <= Date.now(),
		retryProbe: () => pause(reason),
	};
}
