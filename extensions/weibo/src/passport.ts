import { type ExtensionContext, fail, type HttpResponse, ok } from "@bilibili-notify/extension";

import {
	type Cookies,
	challenge,
	decimalId,
	HOME,
	json,
	loginRequired,
	record,
	trustedHttps,
	urlAt,
	type WeiboClient,
} from "./client";

const PASSPORT = "https://passport.weibo.com";
const QR_IMAGE = "https://v2.qr.weibo.cn/";
const RETURN_URL =
	"https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/";

function ssoBody(text: string) {
	// Some Passport responses wrap the JSON in a named callback.
	const body = text.trim();
	const wrapped = /^[\w.$]+\(([\s\S]*)\);?$/.exec(body);
	return record(json(wrapped?.[1] ?? body));
}

function homeUser(html: string) {
	const match = /window\.\$CONFIG\s*=\s*(?=\{)/.exec(html);
	if (!match) return;
	const start = match.index + match[0].length;
	let depth = 0,
		quoted = false;
	for (let i = start; i < html.length; i++) {
		const c = html[i];
		if (quoted && c === "\\") i++;
		else if (c === '"') quoted = !quoted;
		else if (!quoted && c === "{") depth++;
		else if (!quoted && c === "}" && --depth === 0)
			return record(record(json(html.slice(start, i + 1))).user);
	}
}

export function checkedAccount(ctx: ExtensionContext, response: HttpResponse, expected?: string) {
	if (response.status >= 500 || response.status === 429)
		return fail("unavailable", ctx.i18n.t("request.unavailable"));
	const user = response.isSuccess ? homeUser(response.text()) : undefined;
	const uid = user && decimalId(user.idstr ?? user.id);
	if (uid) {
		if (expected && expected !== uid)
			return fail("conflict", ctx.i18n.t("auth.changed"), {
				upstreamCode: "weibo.account_changed",
			});
		return ok({
			uid,
			name:
				typeof user.screen_name === "string" && user.screen_name.trim() ? user.screen_name : uid,
		});
	}
	if (challenge(response.text()))
		return fail("unavailable", ctx.i18n.t("auth.verify"), { upstreamCode: "weibo.verify" });
	if (loginRequired(response) || user?.id === 0 || user?.idstr === "0")
		return fail("unauthorized", ctx.i18n.t("auth.expired"));
	return fail("unavailable", ctx.i18n.t("request.unavailable"));
}

const LOGIN_PATHS: Record<string, readonly string[]> = {
	"passport.weibo.com": ["/sso/v2/login", "/sso/crossdomain", "/sso/v2/pmproxy"],
	"login.sina.com.cn": ["/sso/login.php", "/sso/v2/crossdomain"],
	"passport.weibo.cn": ["/sso/crossdomain"],
	"weibo.com": ["/", "/newlogin"],
	"www.weibo.com": ["/", "/newlogin"],
};

function redirectFromHtml(html: string) {
	const replace = /(?:window\.)?location\.replace\(\s*(['"])([^'"]+)\1\s*\)/i.exec(html)?.[2];
	const meta = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh\b[^>]*>/i.exec(html)?.[0];
	const url =
		replace ??
		(meta && /\burl\s*=\s*(?:&#39;|["'])?([^'"<>]+)/i.exec(meta)?.[1]?.replace(/&#39;$/, ""));
	return url?.trim().replaceAll("&amp;", "&");
}

export async function loginChain(
	client: WeiboClient,
	cookies: Cookies,
	start: URL,
	signal: AbortSignal,
	expected?: string,
	renewal = false,
) {
	const { ctx, request } = client;
	const visited = new Set<string>();
	let url: URL | null = start;
	let issued = false;
	while (
		url &&
		trustedHttps(url) &&
		LOGIN_PATHS[url.hostname]?.includes(url.pathname) &&
		!visited.has(url.href) &&
		visited.size < 10
	) {
		visited.add(url.href);
		ctx.redact(url.href);
		const response = await request(cookies, url, signal, "text/html");
		if (!response.ok) return response;
		if (response.status === 429 || response.status >= 500)
			return fail("unavailable", ctx.i18n.t("request.unavailable"));
		if (
			url.origin === PASSPORT &&
			url.pathname === "/sso/crossdomain" &&
			response.headers.getSetCookie().some((line) => /^SUB=[^;\s]+/.test(line)) &&
			/(?:^|; )SUB=/.test(cookies.header(HOME))
		)
			issued = true;
		if (
			response.isSuccess &&
			["weibo.com", "www.weibo.com"].includes(url.hostname) &&
			url.pathname === "/"
		) {
			if (renewal && !issued) return fail("unauthorized", ctx.i18n.t("auth.expired"));
			return checkedAccount(ctx, response, expected);
		}
		const html = response.text();
		if (challenge(html))
			return fail("unavailable", ctx.i18n.t("auth.verify"), { upstreamCode: "weibo.verify" });
		if (response.status === 401 || url.searchParams.get("retcode") === "6102")
			return fail("unauthorized", ctx.i18n.t("auth.expired"));
		const to =
			response.headers.get("location") ?? (response.isSuccess ? redirectFromHtml(html) : undefined);
		if (to && URL.parse(to, url)?.pathname === "/sso/signin")
			return fail("unauthorized", ctx.i18n.t("auth.expired"));
		if (!to && response.isSuccess && (!renewal || issued)) {
			const home = await request(cookies, new URL(HOME), signal, "text/html");
			return home.ok ? checkedAccount(ctx, home, expected) : home;
		}
		url = to ? URL.parse(to, url) : null;
	}
	return fail("unavailable", ctx.i18n.t("auth.redirect"), { upstreamCode: "weibo.protocol" });
}

export async function checkQr(
	client: WeiboClient,
	cookies: Cookies,
	id: string,
	signal: AbortSignal,
) {
	const { ctx, request } = client;
	const body = await request(
		cookies,
		urlAt(PASSPORT, "/sso/v2/qrcode/check", {
			entry: "miniblog",
			source: "miniblog",
			url: RETURN_URL,
			qrid: id,
			disp: "popup",
		}),
		signal,
	);
	if (!body.ok) return body;
	if (!body.isSuccess) return fail("unavailable", ctx.i18n.t("auth.qr"));
	const reply = ssoBody(body.text());
	const code = Number(reply.retcode);
	if (code === 50114001 || code === 50114002)
		return ok({ kind: "waiting" as const, scanned: code === 50114002 });
	const target = record(reply.data).url;
	if (code !== 20000000 || typeof target !== "string")
		return fail("unavailable", ctx.i18n.t("auth.qrExpired"));
	const url = URL.parse(target);
	if (url?.origin !== PASSPORT || !trustedHttps(url) || url.pathname !== "/sso/v2/login")
		return fail("invalid", ctx.i18n.t("auth.redirect"));
	return ok({ kind: "confirmed" as const, url });
}

export async function beginQr(client: WeiboClient, cookies: Cookies, signal: AbortSignal) {
	const { ctx, request } = client;
	const init = await request(
		cookies,
		urlAt(PASSPORT, "/sso/signin", {
			entry: "miniblog",
			source: "miniblog",
			disp: "popup",
			url: RETURN_URL,
			from: "weibopro",
		}),
		signal,
		"text/html",
	);
	if (!init.ok) return init;
	if (!init.isSuccess) return fail("unavailable", ctx.i18n.t("auth.qr"));
	const issued = await request(
		cookies,
		urlAt(PASSPORT, "/sso/v2/qrcode/image", {
			entry: "miniblog",
			size: "180",
		}),
		signal,
	);
	if (!issued.ok) return issued;
	const reply = ssoBody(issued.text());
	const data = record(reply.data);
	if (
		!issued.isSuccess ||
		Number(reply.retcode) !== 20000000 ||
		typeof data.qrid !== "string" ||
		!data.qrid ||
		typeof data.image !== "string"
	)
		return fail("unavailable", ctx.i18n.t("auth.qr"));
	ctx.redact(data.qrid);
	const url = URL.parse(data.image, QR_IMAGE);
	if (
		url?.hostname !== "v2.qr.weibo.cn" ||
		url.port ||
		url.username ||
		url.password ||
		!["http:", "https:"].includes(url.protocol)
	)
		return fail("invalid", ctx.i18n.t("auth.redirect"));
	url.protocol = "https:";
	ctx.redact(url.href);
	const image = await request(cookies, url, signal, "image/png");
	if (!image.ok) return image;
	const bytes = Buffer.from(image.body);
	if (
		!image.isSuccess ||
		image.headers.get("content-type")?.split(";")[0]?.trim() !== "image/png" ||
		!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
	)
		return fail("unavailable", ctx.i18n.t("auth.qr"));
	return ok({ id: data.qrid, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` });
}
