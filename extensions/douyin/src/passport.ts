import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
	ExtensionContext,
	FetchOptions,
	HttpResponse,
	Result,
} from "@bilibili-notify/extension";
import { fail, ok } from "@bilibili-notify/extension";
import { cookieValue, dict, LOGIN, sign, str, trusted, userAgent, WEB } from "./web";

const key = "163e7ce78d58971a41f5b969996d85c2";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const xor = (s: string) => Buffer.from(Buffer.from(s).map((b) => b ^ 5)).toString("hex");
const loginHosts = ["www.douyin.com", "login.douyin.com", "sso.douyin.com"];
export function passport(ctx: ExtensionContext, jar = ctx.createCookieSession()) {
	const portrait = `${randomUUID()}.login`,
		csrf = randomBytes(16).toString("hex");
	// The double-submit token belongs to this QR attempt alone.
	if (!cookieValue(jar.header(LOGIN), "passport_csrf_token"))
		jar.ingest(LOGIN, `passport_csrf_token=${csrf}; Domain=douyin.com; Path=/; Secure`);
	async function request(
		url: URL,
		signal: AbortSignal,
		options: FetchOptions = {},
	): Promise<Result<HttpResponse>> {
		if (!trusted(url, loginHosts)) return fail("invalid", ctx.i18n.t("auth.redirect"));
		const headers = new Headers(options.headers);
		headers.set("user-agent", userAgent);
		headers.set("referer", `${WEB}/`);
		if (!headers.has("accept")) headers.set("accept", "application/json, */*");
		const cookie = jar.header(url.href);
		if (cookie) headers.set("cookie", cookie);
		const res = await ctx.http.fetch(url, {
			...options,
			headers,
			signal,
			bare: true,
			maxRedirects: 0,
			timeoutMs: 12000,
			maxBodyBytes: 1024 * 1024,
		});
		if (!res.ok || signal.aborted) return fail("unavailable", ctx.i18n.t("auth.network"));
		for (const c of res.headers.getSetCookie()) jar.ingest(url.href, c);
		const token = res.headers.get("x-ms-token");
		if (token && /^[A-Za-z0-9_~+/%=-]{1,4096}$/.test(token)) {
			ctx.redact(token);
			jar.ingest(url.href, `msToken=${token}; Domain=douyin.com; Path=/; Secure`);
		}
		return res;
	}
	async function prepare(signal: AbortSignal): Promise<Result> {
		const response = await request(new URL("/", WEB), signal, {
			headers: { accept: "text/html,application/xhtml+xml" },
		});
		return response.ok && response.isSuccess
			? ok()
			: fail("unavailable", ctx.i18n.t("auth.prepareFailed"));
	}
	async function sso(raw: string, signal: AbortSignal) {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			return fail("invalid", ctx.i18n.t("auth.redirect"));
		}
		for (let i = 0; i < 6; i++) {
			const r = await request(url, signal);
			if (!r.ok) return r;
			if (r.isSuccess) return ok();
			const loc = r.headers.get("location");
			if (![301, 302, 303, 307, 308].includes(r.status) || !loc) break;
			try {
				url = new URL(loc, url);
			} catch {
				break;
			}
		}
		return fail("invalid", ctx.i18n.t("auth.redirect"));
	}
	async function json(url: URL, signal: AbortSignal, options: FetchOptions = {}) {
		const r = await request(url, signal, options);
		if (!r.ok) return r;
		if (!r.isSuccess)
			return fail(r.status === 429 ? "rate_limited" : "unavailable", ctx.i18n.t("auth.network"));
		const body = r.json();
		return body.ok
			? ok({ body: dict(body.value) })
			: fail("unavailable", ctx.i18n.t("auth.network"));
	}
	async function account(signal: AbortSignal) {
		if (!cookieValue(jar.header(WEB), "sessionid") && !cookieValue(jar.header(WEB), "sessionid_ss"))
			return fail("unauthorized", ctx.i18n.t("auth.credentials"));
		const r = await json(new URL("/passport/account/info/v2/", WEB), signal);
		if (!r.ok) return r;
		const d = dict(r.body.data);
		if (
			d.is_visitor_account === true ||
			(r.body.message === "error" && Number(d.error_code) === 13)
		)
			return fail("unauthorized", ctx.i18n.t("auth.credentials"));
		const textId = [d.user_id_str, d.user_id].find(
			(id): id is string => typeof id === "string" && /^[1-9]\d*$/.test(id),
		);
		const numericId = d.user_id;
		const hasNumericId =
			typeof numericId === "number" && Number.isInteger(numericId) && numericId > 0;
		if (r.body.message !== "success" || d.is_visitor_account !== false || !(textId || hasNumericId))
			return fail("unavailable", ctx.i18n.t("auth.network"));
		// An unsafe numeric ID confirms presence but its rounded value must never become a display name.
		const displayId = textId || (Number.isSafeInteger(numericId) ? String(numericId) : "");
		return ok({ name: str(d.screen_name) || str(d.nickname) || str(d.name) || displayId });
	}
	async function exchange(
		action: "get_qrcode" | "check_qrconnect" | "send_code" | "validate_code",
		signal: AbortSignal,
		fields: Record<string, string>,
		trace = randomBytes(4).toString("hex"),
	) {
		const sms = action === "send_code" || action === "validate_code",
			path = `/passport/web/${action}/`;
		const ts = String(Math.floor(new Date().setUTCHours(12, 0, 0, 0) / 1000));
		const hash = (k: string | Buffer, m: string | Buffer) =>
			createHmac("sha256", k).update(m).digest();
		const aidSign = hash(
			hash(hash(ts, key), Buffer.from([1])),
			`aid=6383&path=${path}&ts=${ts}`,
		).toString("hex");
		const url = new URL(path, sms ? WEB : LOGIN);
		const q = url.searchParams;
		const base = {
			aid: "6383",
			language: "zh",
			account_app_language: "zh-CN",
			is_from_ttaccountsdk: "1",
			passport_jssdk_version: sms ? "5.1.2" : "3.1.3",
			passport_jssdk_type: sms ? "lite" : "normal",
			biz_trace_id: trace,
		};
		for (const [k, v] of Object.entries(base)) q.set(k, v);
		if (sms) q.set("new_authn_sdk_version", "1.0.0.420-web");
		else {
			const stamp = String(Date.now()),
				finger = {
					passport_jssdk_version: "3.1.3",
					p_bd: "1.0.1.19-fix.01",
					p_ca: "4.0.17",
					p_ts: stamp,
					p_ver: "1.1.3",
					p_zt: "3.3.14",
				};
			const sorted = (entries: [string, string][]) =>
				entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
			const join = (entries: [string, string][]) => entries.map(([k, v]) => `${k}=${v}`).join("&");
			const extra = {
				...fields,
				...finger,
				p_no: sha(join(sorted(Object.entries(finger)))),
				ts,
				device_platform: "web_app",
				is_from_iesaccountsaas: "1",
				p_ui: "2.1.9-alpha.6",
				p_ca_real: "1.0.0.874",
				p_js_t: "pro",
				p_js_v: "3.1.3",
				p_ver_real: "0",
				account_sdk_source: "web",
				request_host: encodeURIComponent(WEB),
			};
			for (const [k, v] of Object.entries(extra)) q.set(k, v);
			const first = sorted([...q.entries()]).slice(0, 10);
			q.set("sign", sha(`${join(first)}&&app_key=${key}`));
			q.set("qs", xor(first.map(([k]) => k).join(",")));
			const ms = cookieValue(jar.header(url.href), "msToken");
			if (ms) q.set("msToken", ms);
			sign(url);
		}
		const headers = {
			"content-type": "application/x-www-form-urlencoded",
			"x-tt-passport-aid-sign": aidSign,
			"x-tt-passport-trace-id": trace,
			"x-tt-passport-verify-portrait": portrait,
			"x-tt-passport-csrf-token": cookieValue(jar.header(url.href), "passport_csrf_token") ?? csrf,
		};
		return json(url, signal, {
			headers,
			method: sms ? "POST" : "GET",
			...(sms ? { body: new URLSearchParams(fields).toString() } : {}),
		});
	}
	return { prepare, account, exchange, sso, jar };
}
export function smsFields(
	d: Record<string, unknown>,
	way: string,
	code?: string,
): Record<string, string> {
	const fields: Record<string, string> = {
		mix_mode: "1",
		type: "3737",
		aid: "6383",
		new_authn_sdk_version: "1.0.0.420-web",
		std_verify_way: way,
	};
	const defaults: Record<string, string> = {
		encrypt_uid: "",
		verify_ticket: "",
		copywriting_key: "qr_connect",
		ies_safety_diversion_tag: "mfa",
		new_verify_flow: "",
		std_verify_flow_id: "",
		std_verify_scene: "account_login",
		std_verify_template: "ato_web",
		std_verify_token: "",
		std_verify_type: "MFA",
	};
	for (const [k, v] of Object.entries(defaults)) fields[k] = str(d[k]) || v;
	if (code) fields.code = xor(code);
	else fields.is6Digits = "1";
	return fields;
}
