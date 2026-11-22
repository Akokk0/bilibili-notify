import { type ExtensionContext, fail, type HttpResponse, ok } from "@bilibili-notify/extension";

export type Cookies = ReturnType<ExtensionContext["createCookieSession"]>;
export const HOME = "https://weibo.com/";
export function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function json(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function urlAt(origin: string, path: string, params: Record<string, string> = {}) {
	const url = new URL(path, origin);
	url.search = new URLSearchParams(params).toString();
	return url;
}

export function trustedHttps(url: URL) {
	return url.protocol === "https:" && !url.port && !url.username && !url.password;
}

export function decimalId(value: unknown) {
	const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
	return typeof id === "string" && /^[1-9]\d*$/.test(id) ? id : undefined;
}

export function challenge(text: string) {
	return /wbBotDetector|alc-auto-login|captcha|验证码/i.test(text);
}

export function loginRequired(response: HttpResponse) {
	if (response.status === 401) return true;
	const location = response.headers.get("location");
	if (response.status < 300 || response.status >= 400 || !location) return false;
	const url = URL.parse(location, HOME);
	return (
		!!url &&
		trustedHttps(url) &&
		((["weibo.com", "www.weibo.com"].includes(url.hostname) &&
			["/login.php", "/newlogin"].includes(url.pathname)) ||
			(url.hostname === "passport.weibo.com" && url.pathname === "/sso/signin") ||
			(url.hostname === "login.sina.com.cn" && url.pathname === "/sso/login.php"))
	);
}

export function createClient(ctx: ExtensionContext) {
	const storedDeadline = ctx.state.get("requests.retryAt");
	let retryAt =
		typeof storedDeadline === "number" &&
		Number.isFinite(storedDeadline) &&
		storedDeadline > Date.now()
			? storedDeadline
			: 0;
	let nextRead = 0;
	function limited() {
		return fail("rate_limited", ctx.i18n.t("request.limited"));
	}
	async function coolDown(until: number) {
		retryAt = Math.max(retryAt, until);
		const stored = await ctx.state.set("requests.retryAt", retryAt);
		ctx.reportProblem({
			code: "weibo_rate_limited",
			message: ctx.i18n.t(stored.ok ? "request.limited" : "request.limitedLocal"),
		});
		return limited();
	}
	function wait(ms: number, signal: AbortSignal) {
		if (ms <= 0 || signal.aborted) return;
		return new Promise<void>((resolve) => {
			const timer = ctx.setTimeout(finish, ms);
			function finish() {
				timer.dispose();
				signal.removeEventListener("abort", finish);
				resolve();
			}
			signal.addEventListener("abort", finish, { once: true });
		});
	}
	async function request(
		cookies: Cookies,
		url: URL,
		signal: AbortSignal,
		accept = "application/json, text/plain, */*",
		referer = HOME,
	) {
		if (signal.aborted) return fail("indeterminate", ctx.i18n.t("request.cancelled"));
		if (Date.now() < retryAt) return limited();
		const headers = new Headers({ Accept: accept, Referer: referer });
		const cookie = cookies.header(url.href);
		if (cookie) headers.set("Cookie", cookie);
		if (url.pathname.startsWith("/ajax/")) {
			headers.set("X-Requested-With", "XMLHttpRequest");
			const token = /(?:^|;\s*)XSRF-TOKEN=([^;]+)/.exec(cookie)?.[1];
			if (token) headers.set("X-XSRF-TOKEN", token);
		}
		const response = await ctx.http.fetch(url, {
			bare: true,
			maxRedirects: 0,
			timeoutMs: 15000,
			maxBodyBytes: url.hostname === "v2.qr.weibo.cn" ? 1024 * 1024 : 4 * 1024 * 1024,
			headers,
			signal,
		});
		if (signal.aborted) return fail("indeterminate", ctx.i18n.t("request.cancelled"));
		if (!response.ok) return fail(response.code, ctx.i18n.t("request.unavailable"));
		if (response.status === 429) {
			const after = response.headers.get("retry-after")?.trim() ?? "";
			const now = Date.now();
			const end = /^\d+$/.test(after) ? now + Number(after) * 1000 : Date.parse(after);
			return coolDown(Number.isFinite(end) ? Math.max(now + 1000, end) : now + 60000);
		}
		if (retryAt && response.isSuccess && Date.now() >= retryAt) {
			retryAt = 0;
			ctx.resolveProblem({ code: "weibo_rate_limited" });
		}
		for (const line of response.headers.getSetCookie()) cookies.ingest(url.href, line);
		return response;
	}

	async function read(cookies: Cookies, url: URL, signal: AbortSignal, referer: string) {
		if (Date.now() < retryAt) return limited();
		await wait(nextRead - Date.now(), signal);
		const response = await request(
			cookies,
			url,
			signal,
			"application/json, text/plain, */*",
			referer,
		);
		if (signal.aborted) return fail("indeterminate", ctx.i18n.t("request.cancelled"));
		nextRead = Date.now() + 1000;
		if (!response.ok) return response;
		const text = response.text();
		const value = json(text);
		const data = record(value);
		const message = String(data.msg ?? data.message ?? data.error ?? record(data.data).msg ?? "");
		if (response.status >= 500) return fail("unavailable", ctx.i18n.t("request.unavailable"));
		if (response.status === 404) return fail("not_found", ctx.i18n.t("profile.notFound"));
		const refused = !response.isSuccess || (data.ok !== undefined && Number(data.ok) !== 1);
		if ((refused && challenge(message)) || (value === undefined && challenge(text)))
			return fail("unavailable", ctx.i18n.t("auth.verify"), { upstreamCode: "weibo.verify" });
		if (
			loginRequired(response) ||
			(refused && /未登[录陆]|请(?:先|重新)?登[录陆]|登录(?:已)?过期|not logged in/i.test(message))
		)
			return fail("unauthorized", ctx.i18n.t("auth.expired"));
		if (refused && /频繁|rate limit/i.test(message)) {
			return coolDown(Date.now() + 60000);
		}
		if (refused || !Object.keys(data).length)
			return fail("unavailable", ctx.i18n.t("request.unavailable"));
		return ok({ data, updated: response.headers.getSetCookie().length > 0 });
	}
	return { ctx, request, read, retryAt: () => retryAt };
}
export type WeiboClient = ReturnType<typeof createClient>;
