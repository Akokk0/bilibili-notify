import { type ExtensionContext, fail, ok, type Result } from "@bilibili-notify/extension";
import { createCooldown } from "./cooldown";

export function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function decimal(value: unknown): string | undefined {
	const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
	return typeof id === "string" && /^[1-9]\d*$/.test(id) ? id : undefined;
}

const verification = /安全验证|人机验证|访问验证|请.{0,6}完成验证|验证码|captcha|security check/i;
function challenge(body: string, status: number) {
	if (!verification.test(body)) return false;
	if (body.trimStart().startsWith("<")) {
		const title = /<title\b[^>]*>\s*([^<]{1,160})<\/title>/i.exec(body)?.[1];
		if (title && verification.test(title) && !/<link\b[^>]*\bcanonical\b/i.test(body)) return true;
	}
	try {
		const envelope = record(JSON.parse(body));
		return Number(envelope.status) !== 200 && verification.test(String(envelope.message ?? ""));
	} catch {
		return [401, 403].includes(status) && body.length < 4000;
	}
}

/** 冷却后的试探要认得正常房间页或接口信封，单独 HTTP 200 也可能是拦截页。 */
function usableProbe(url: URL, body: string) {
	if (
		url.hostname === "www.huya.com" ||
		url.hostname === "m.huya.com" ||
		url.hostname === "huya.com"
	)
		return /J_userLinkLive|<link\b[^>]*\bcanonical\b/i.test(body);
	try {
		const json = record(JSON.parse(body));
		if (url.hostname === "mp.huya.com")
			return (
				(json.status === 200 && !!record(record(json.data).profileInfo).uid) ||
				(json.status === 422 && /^该主播不存在[！!。]?$/.test(String(json.message)))
			);
		return Array.isArray(record(record(json.response)["1"]).docs);
	} catch {
		return false;
	}
}

export function createClient(ctx: ExtensionContext) {
	const unavailable = () => fail("unavailable", ctx.i18n.t("request.unavailable"));
	const cancelled = () => fail("indeterminate", ctx.i18n.t("request.cancelled"));
	const cooldown = createCooldown(ctx);
	type Page = Result<{ body: string; location?: string }>;
	type Pending = { controller: AbortController; result: Promise<Page>; readers: number };
	const pending = new Map<string, Pending>();
	let tail = Promise.resolve();
	let nextRequest = 0;

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
	async function request(url: URL, signal: AbortSignal): Promise<Page> {
		const blocked = cooldown.blocked();
		if (blocked) return blocked;
		await wait(nextRequest - Date.now(), signal);
		if (signal.aborted) return cancelled();
		const response = await ctx.http.fetch(url, {
			bare: true,
			maxRedirects: 0,
			maxBodyBytes: 2 * 1024 * 1024,
			timeoutMs: 10000,
			signal,
		});
		nextRequest = Date.now() + 3000;
		if (response.ok && response.status === 429)
			return cooldown.pause("limited", response.headers.get("retry-after"));
		if (signal.aborted) return cancelled();
		if (!response.ok) return cooldown.probing() ? cooldown.retryProbe() : response;
		const location = response.headers.get("location");
		const body = response.text();
		if ([301, 302, 303, 307, 308].includes(response.status) && location) {
			const target = URL.parse(location, url);
			if (
				target &&
				/(?:^|\.)huya\.com$/.test(target.hostname) &&
				(target.hostname === "udblgn.huya.com" ||
					/\/(?:login|passport|captcha|verify)(?:[./?]|$)/i.test(target.pathname))
			)
				return cooldown.pause("verify");
			return ok({ body: "", location });
		}
		if (challenge(body, response.status)) return cooldown.pause("verify");
		if (!response.isSuccess) return cooldown.probing() ? cooldown.retryProbe() : unavailable();
		if (cooldown.probing()) {
			if (!usableProbe(url, body)) return cooldown.retryProbe();
			await cooldown.recovered();
		}
		return ok({ body });
	}
	async function read(url: URL, signal: AbortSignal): Promise<Page> {
		if (signal.aborted) return cancelled();
		const blocked = cooldown.blocked();
		if (blocked) return blocked;
		const key = url.href;
		let call = pending.get(key);
		if (!call) {
			const controller = new AbortController();
			const result = tail.then(() => request(url, controller.signal));
			call = { controller, result, readers: 0 };
			pending.set(key, call);
			const entry = call;
			const finish = () => {
				if (pending.get(key) === entry) pending.delete(key);
			};
			tail = result.then(finish, finish);
		}
		call.readers++;
		let cancel!: () => void;
		const aborted = new Promise<Page>((resolve) => {
			cancel = () => resolve(cancelled());
		});
		signal.addEventListener("abort", cancel, { once: true });
		try {
			return await Promise.race([call.result, aborted]);
		} finally {
			signal.removeEventListener("abort", cancel);
			if (--call.readers === 0 && signal.aborted) {
				call.controller.abort();
				if (pending.get(key) === call) pending.delete(key);
			}
		}
	}
	async function json(url: URL, signal: AbortSignal) {
		const response = await read(url, signal);
		if (!response.ok) return response;
		try {
			const value = JSON.parse(
				response.body,
				(_key, value: unknown, context?: { source?: string }) =>
					typeof value === "number" &&
					!Number.isSafeInteger(value) &&
					context?.source &&
					/^\d+$/.test(context.source)
						? context.source
						: value,
			);
			return ok({ data: record(value) });
		} catch {
			return unavailable();
		}
	}
	return { read, json, unavailable };
}
export type HuyaClient = ReturnType<typeof createClient>;
