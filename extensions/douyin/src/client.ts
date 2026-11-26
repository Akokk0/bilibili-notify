import { randomBytes } from "node:crypto";
import {
	type ExtensionContext,
	type ExtensionSourceContext,
	type Failure,
	fail,
	ok,
	type Result,
} from "@bilibili-notify/extension";
import { DEFAULT_ENV, getVerifyFp, signWebUrl } from "abogus";
import { liveOrigin, roomSocketUrl } from "./live-socket";
import { dict, sign, str, trusted, userAgent, WEB } from "./web";

type Session = {
	credentials(url: URL): string;
	receiveCookies(url: URL, headers: Headers, from: AbortSignal): Promise<Result>;
	sessionSignal(): AbortSignal;
	invalidate(signal: AbortSignal, url: URL, sentCookies: string): Promise<void>;
};
const shareHosts = ["v.douyin.com", "www.douyin.com", "www.iesdouyin.com"];
const browserFetchHeaders = {
	"accept-language": "zh-CN,zh;q=0.9",
	"sec-fetch-dest": "empty",
	"sec-fetch-mode": "cors",
	"sec-fetch-site": "same-origin",
};
const browserVersion = userAgent.match(/Chrome\/([^ ]+)/)?.[1] ?? "";
// Match the browser identity used by this integration, rather than the machine
// running BN. Search requires its capability envelope even without A-Bogus.
const searchEnvironment = {
	update_version_code: "170400",
	pc_client_type: "1",
	pc_libra_divert: "Mac",
	support_h265: "0",
	support_dash: "1",
	cpu_core_num: "10",
	version_code: "170400",
	version_name: "17.4.0",
	cookie_enabled: "true",
	screen_width: String(DEFAULT_ENV.screen.width),
	screen_height: String(DEFAULT_ENV.screen.height),
	browser_language: "zh-CN",
	browser_platform: DEFAULT_ENV.platform,
	browser_name: "Chrome",
	browser_version: browserVersion,
	browser_online: "true",
	engine_name: "Blink",
	engine_version: browserVersion,
	os_name: "Mac OS",
	os_version: "10.15.7",
	device_memory: "8",
	platform: "PC",
	downlink: "10",
	effective_type: "4g",
	round_trip_time: "50",
};
function retryAfter(header: string | null) {
	if (!header) return 60000;
	const n = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
	return Number.isFinite(n) ? Math.max(1000, n) : 60000;
}
function challenge(h: Headers, d: Record<string, unknown>, body: string) {
	const raw = h.get("bdturing-verify") ?? h.get("x-vc-bdturing-parameters");
	if (raw?.trim()) {
		let subtype: unknown;
		try {
			const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString();
			subtype = dict(JSON.parse(text)).subtype;
		} catch {}
		if (subtype !== "nocaptcha_collect") return true;
	}
	return (
		[d, dict(d.data)].some((envelope) => {
			const directive = envelope.verify_center_decision_conf;
			return (
				(typeof directive === "string" && directive.trim().length > 0) ||
				Object.keys(dict(directive)).length > 0
			);
		}) ||
		(typeof d.verify_data === "string" && !!d.verify_data) ||
		dict(d.verify_data).fp !== undefined ||
		(/^\s*</.test(body) && /验证码|captcha|安全验证|verifycenter/i.test(body.slice(0, 16000)))
	);
}
export function createDouyinClient(ctx: ExtensionContext, auth: Session) {
	let observer: ExtensionSourceContext | undefined;
	const message = (k: string) => ctx.i18n.t(`api.${k}`);
	const fp = getVerifyFp();
	let stamp = auth.sessionSignal();
	type Gate = { until: number; err: Failure; probe: boolean; key?: string };
	type Scope = { revision: number; gate?: Gate };
	const sessionScope: Scope = { revision: 0 };
	const endpoints = new Map<string, Scope>();

	function put(scope: Scope, err: Failure, delay: number) {
		const prev = scope.gate?.key;
		const key =
			typeof err.upstreamCode === "string" ? err.upstreamCode.replaceAll(".", "_") : undefined;
		scope.revision++;
		scope.gate = { until: Date.now() + delay, err, probe: false, key };
		if (prev && prev !== key) resolve(prev);
		if (key) observer?.reportProblem({ code: key, message: err.message });
	}
	function resolve(key: string, notify?: boolean) {
		if (sessionScope.gate?.key === key) return;
		for (const scope of endpoints.values()) if (scope.gate?.key === key) return;
		observer?.resolveProblem({ code: key, ...(notify === false && { notify: false }) });
	}
	function clear(scope: Scope) {
		const key = scope.gate?.key;
		scope.gate = undefined;
		if (key) resolve(key);
	}
	function sameSession() {
		const next = auth.sessionSignal();
		if (stamp === next) return;
		stamp = next;
		const keys = new Set([sessionScope, ...endpoints.values()].map((scope) => scope.gate?.key));
		sessionScope.revision++;
		sessionScope.gate = undefined;
		endpoints.clear();
		for (const key of keys) if (key) resolve(key, false);
	}
	function rememberRateLimit(revision: number, fault: Failure, delay: number) {
		// Concurrent replies may extend the cooldown, but cannot revive a recovered gate.
		const current = sessionScope.gate;
		if (sessionScope.revision === revision || (current && Date.now() + delay > current.until)) {
			put(sessionScope, fault, delay);
		}
	}
	function rateLimit() {
		return fail("rate_limited", message("cooldown"), { upstreamCode: "douyin.cooldown" });
	}
	async function call(
		endpoint: string,
		path: string,
		args: Record<string, string>,
		signal: AbortSignal,
		base = WEB,
		referer = `${WEB}/`,
	): Promise<Result<{ data: unknown }>> {
		sameSession();
		const session = stamp;
		if (signal.aborted || ctx.signal.aborted) return fail("unavailable", message("cancelled"));
		const local = endpoints.get(endpoint) ?? { revision: 0 };
		endpoints.set(endpoint, local);
		const globalRev = sessionScope.revision,
			localRev = local.revision;
		const globalGate = sessionScope.gate,
			localGate = local.gate;
		const gates = [globalGate, localGate].filter((gate): gate is Gate => !!gate);
		const blocked = gates.find((gate) => Date.now() < gate.until || gate.probe);
		if (blocked) return blocked.err;
		for (const gate of gates) gate.probe = true;
		const combined = AbortSignal.any([ctx.signal, signal, session]);
		try {
			let u = new URL(path, base);
			const guest = endpoint === "account";
			const headers: Record<string, string> = {
				accept: "application/json",
				"user-agent": userAgent,
			};
			if (!guest) {
				const cookie = auth.credentials(u);
				if (cookie) headers.cookie = cookie;
				headers.referer = referer;
				const fields = new Map(
					cookie.split(/;\s*/).map((pair) => {
						const split = pair.indexOf("=");
						return [pair.slice(0, split), pair.slice(split + 1)];
					}),
				);
				const defaultQ = {
					device_platform: endpoint === "room" ? "web" : "webapp",
					aid: "6383",
					channel: "channel_pc_web",
					cookie_enabled: "true",
					browser_platform: DEFAULT_ENV.platform,
					browser_name: "Chrome",
					browser_version: browserVersion,
					screen_width: String(DEFAULT_ENV.screen.width),
					screen_height: String(DEFAULT_ENV.screen.height),
					browser_language: "zh-CN",
				};
				const query =
					endpoint === "search"
						? {
								device_platform: "webapp",
								aid: "6383",
								channel: "channel_pc_web",
								...args,
								...searchEnvironment,
							}
						: { ...defaultQ, ...args };
				for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
				if (endpoint === "search") Object.assign(headers, browserFetchHeaders);
				for (const key of ["msToken", "uifid"]) {
					// Search uses a per-request nonce; the response's server token is
					// retained in the cookie jar independently for the shared session.
					const value =
						endpoint === "search" && key === "msToken"
							? `${randomBytes(138).toString("base64url")}==`
							: fields.get(key);
					if (value) u.searchParams.set(key, value);
				}
				const id = fields.get("s_v_web_id") || fp;
				u.searchParams.set("verifyFp", id);
				u.searchParams.set("fp", id);
				const uifid = ["UIFID", "uifid", "UIFID_TEMP", "uifid_temp", "UIFIDTEMP", "uifidtemp"]
					.map((key) => fields.get(key))
					.find(Boolean);
				const protectedVisitor = endpoint === "posts" || endpoint === "detail" ? uifid : undefined;
				if (protectedVisitor) {
					headers.uifid = protectedVisitor;
					u.searchParams.set("uifid", protectedVisitor);
				}
				if (endpoint === "detail" && protectedVisitor) {
					// Detail uses only business parameters plus the SDK signature.
					// The general API environment and A-Bogus trigger verification here.
					u.search = new URLSearchParams({ aid: "6383", ...args }).toString();
					u.searchParams.set("uifid", protectedVisitor);
					Object.assign(headers, browserFetchHeaders);
				} else if (endpoint !== "search") sign(u);
				if (protectedVisitor) u = new URL(signWebUrl(u.href, { uifid: protectedVisitor }));
			} else for (const [k, v] of Object.entries(args)) u.searchParams.set(k, v);
			const r = await ctx.http.fetch(u, {
				bare: true,
				maxRedirects: 0,
				signal: combined,
				timeoutMs: 12000,
				maxBodyBytes: 4 * 1024 * 1024,
				headers,
			});
			if (combined.aborted) return fail("unavailable", message("cancelled"));
			if (!r.ok) {
				const e = fail(r.code === "timeout" ? "timeout" : "unavailable", message("temporary"));
				if (local.revision === localRev) put(local, e, 15000);
				return e;
			}
			const body = r.text(),
				j = r.json(),
				d = dict(j.ok ? j.value : null);
			let fault: Failure | undefined;
			let delay = 0;
			if (r.status === 429) {
				fault = rateLimit();
				delay = retryAfter(r.headers.get("retry-after"));
			} else if (
				r.status === 403 &&
				/ArgusSecurityPlugin.*(sign|uifid)/i.test(body.slice(0, 500))
			) {
				fault = fail("unsupported", message("signature"), { upstreamCode: "douyin.signature" });
				delay = 600000;
			} else if (challenge(r.headers, d, body)) {
				fault = fail("unavailable", message("verify"), { upstreamCode: "douyin.verify" });
				delay = 300000;
			} else if (r.status === 401 || d.status_msg === "用户未登录" || d.status_msg === "请先登录") {
				if (!guest && headers.cookie) await auth.invalidate(session, u, headers.cookie);
				return fail("unauthorized", message("login"));
			} else if (dict(d.filter_detail).filter_reason === "私密账号") {
				return fail("not_found", message("private"), { upstreamCode: "douyin.private" });
			} else if (r.status === 404 || (guest && d.status_code === 5))
				return fail("not_found", message("notFound"));
			else if (
				!r.isSuccess ||
				!j.ok ||
				!Object.keys(d).length ||
				str(dict(d.filter_detail).filter_reason)
			) {
				// A filter can reject data dependencies (e.g. images_base), not just
				// missing content. Preserve uncertainty and allow endpoint recovery.
				fault = fail("unavailable", message("temporary"));
				delay = 30000;
			} else if (d.status_code !== 0) {
				return fail(
					"unavailable",
					message("unexpected"),
					typeof d.status_code === "number" ? { upstreamCode: d.status_code } : {},
				);
			}
			if (!guest) {
				const saved = await auth.receiveCookies(u, r.headers, session);
				if (!saved.ok) return saved;
				if (combined.aborted) return fail("unavailable", message("cancelled"));
			}
			if (fault) {
				if (fault.code === "rate_limited") rememberRateLimit(globalRev, fault, delay);
				else if (local.revision === localRev) put(local, fault, delay);
				return fault;
			}
			if (globalGate && sessionScope.gate === globalGate) clear(sessionScope);
			if (localGate && local.gate === localGate) clear(local);
			return ok({ data: d });
		} finally {
			for (const gate of gates) gate.probe = false;
		}
	}
	async function expand(input: URL, signal: AbortSignal): Promise<Result<{ url: URL }>> {
		sameSession();
		const combined = AbortSignal.any([ctx.signal, signal, stamp]);
		if (combined.aborted) return fail("unavailable", message("cancelled"));
		const revision = sessionScope.revision;
		const gate = sessionScope.gate;
		if (gate && (Date.now() < gate.until || gate.probe)) return gate.err;
		if (gate) gate.probe = true;
		try {
			let u = input;
			const seen = new Set<string>();
			for (let hop = 0; hop < 6; hop++) {
				if (!trusted(u, shareHosts) || seen.has(u.href)) break;
				if (u.hostname !== "v.douyin.com") {
					if (gate && sessionScope.gate === gate && seen.size > 0) clear(sessionScope);
					return ok({ url: u });
				}
				seen.add(u.href);
				const r = await ctx.http.fetch(u, {
					bare: true,
					maxRedirects: 0,
					signal: combined,
					timeoutMs: 7000,
					maxBodyBytes: 65536,
				});
				if (combined.aborted) return fail("unavailable", message("cancelled"));
				if (!r.ok)
					return fail(r.code === "timeout" ? "timeout" : "unavailable", message("temporary"));
				if (r.status === 429) {
					const fault = rateLimit();
					rememberRateLimit(revision, fault, retryAfter(r.headers.get("retry-after")));
					return fault;
				}
				if (r.status === 408) return fail("timeout", message("temporary"));
				if (r.status >= 500) return fail("unavailable", message("temporary"));
				const to = r.headers.get("location");
				if (!to || ![301, 302, 303, 307, 308].includes(r.status)) break;
				try {
					u = new URL(to, u);
				} catch {
					break;
				}
			}
			return fail("invalid", message("invalidLink"));
		} finally {
			if (gate) gate.probe = false;
		}
	}
	return {
		sessionSignal: auth.sessionSignal,
		observe: (s: ExtensionSourceContext | undefined) => {
			observer = s;
		},
		expand,
		account: (id: string, s: AbortSignal) =>
			call("account", "/web/api/v2/user/info/", { unique_id: id }, s, "https://www.iesdouyin.com"),
		profile: (id: string, s: AbortSignal) =>
			call(
				"profile",
				"/aweme/v1/web/user/profile/other/",
				{ sec_user_id: id },
				s,
				WEB,
				`${WEB}/user/${encodeURIComponent(id)}`,
			),
		posts: (id: string, cursor: string, s: AbortSignal) =>
			call(
				"posts",
				"/aweme/v1/web/aweme/post/",
				{ sec_user_id: id, max_cursor: cursor, count: "20" },
				s,
				WEB,
				`${WEB}/user/${encodeURIComponent(id)}`,
			),
		search: (keyword: string, s: AbortSignal) =>
			call(
				"search",
				"/aweme/v1/web/discover/search/",
				{
					keyword,
					search_channel: "aweme_user_web",
					search_source: "switch_tab",
					count: "10",
					offset: "0",
					list_type: "single",
					disable_rs: "0",
					from_group_id: "",
					is_filter_search: "0",
					need_filter_settings: "1",
					query_correct_type: "1",
				},
				s,
				WEB,
				`${WEB}/search/${encodeURIComponent(keyword)}?type=user`,
			),
		room: (web_rid: string, room_id_str: string, s: AbortSignal) =>
			call(
				"room",
				"/webcast/room/web/enter/",
				{
					web_rid,
					room_id_str,
					app_name: "douyin_web",
					live_id: "1",
					language: "zh-CN",
					enter_from: "web_share_link",
				},
				s,
				liveOrigin,
				`${liveOrigin}/${encodeURIComponent(web_rid)}`,
			),
		openLiveSocket(roomId: string, viewerId: string, signal: AbortSignal) {
			sameSession();
			if (signal.aborted || ctx.signal.aborted) return fail("unavailable", message("cancelled"));
			if (sessionScope.gate) return sessionScope.gate.err;
			const url = roomSocketUrl(roomId, viewerId);
			const cookie = auth.credentials(new URL(url.pathname, `https://${url.hostname}`));
			return ctx.http.websocket(url, {
				bare: true,
				signal,
				headers: {
					...(cookie && { Cookie: cookie }),
					Origin: liveOrigin,
					"User-Agent": userAgent,
				},
			});
		},
		detail: (id: string, s: AbortSignal) =>
			call("detail", "/aweme/v1/web/aweme/detail/", { aweme_id: id }, s, WEB, `${WEB}/video/${id}`),
	};
}
export type DouyinClient = ReturnType<typeof createDouyinClient>;
