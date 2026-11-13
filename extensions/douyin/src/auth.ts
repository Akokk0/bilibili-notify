import { randomBytes, randomUUID } from "node:crypto";
import {
	type AuthState,
	type Disposable,
	type ExtensionContext,
	fail,
	ok,
	type Result,
	type SourceAuth,
} from "@bilibili-notify/extension";
import QRCode from "qrcode";
import { passport, smsFields } from "./passport";
import { cookieValue, dict, str, trusted, WEB } from "./web";

const cookieKey = "login.cookies";
type Attempt = {
	controller: AbortController;
	session: ReturnType<typeof passport>;
	id: string;
	expires: number;
	token: string;
	timer?: Disposable;
	challenge?: { data: Record<string, unknown>; way: string; trace: string; busy: boolean };
};
export function createDouyinAuth(ctx: ExtensionContext) {
	const listeners = new Set<() => void>();
	let state: AuthState = { status: "logged-out" },
		accountName: string | null = null,
		active: Attempt | undefined;
	let cookies = ctx.createCookieSession(),
		identity = new AbortController(),
		epoch = 0,
		pending: Promise<unknown> = Promise.resolve();
	const t = (key: string) => ctx.i18n.t(`auth.${key}`);
	const publish = (s: AuthState) => {
		state = s;
		for (const cb of listeners) cb();
	};
	function end() {
		active?.controller.abort();
		active?.timer?.dispose();
		active = undefined;
	}
	function replace() {
		epoch++;
		identity.abort();
		identity = new AbortController();
		end();
	}
	const signal = (a: Attempt) => AbortSignal.any([ctx.signal, a.controller.signal]);
	const valid = (a: Attempt) => active === a && !signal(a).aborted;
	function enqueue<T>(op: () => Promise<T>) {
		const result = pending.then(op, op);
		pending = result.catch(() => {});
		return result;
	}
	function failure(a: Attempt, message: string) {
		if (valid(a)) {
			end();
			publish({ status: "error", message });
		}
		return fail("unavailable", message);
	}
	function later(a: Attempt, delay: number) {
		if (!valid(a)) return;
		a.timer?.dispose();
		a.timer = ctx.setTimeout(() => poll(a), Math.max(0, Math.min(a.expires - Date.now(), delay)));
	}
	async function poll(a: Attempt) {
		if (!valid(a)) return;
		if (Date.now() >= a.expires) {
			failure(a, t("expired"));
			return;
		}
		const r = await a.session.exchange("check_qrconnect", signal(a), {
			token: a.token,
			next: `${WEB}/`,
			is_frontier: "true",
			need_short_url: "true",
			need_logo: "false",
			is_new_login: "1",
		});
		if (!valid(a)) return;
		if (!r.ok) {
			later(a, 6000);
			return;
		}
		const d = dict(r.body.data),
			err = Number(d.error_code ?? r.body.error_code ?? 0),
			interval =
				typeof d.interval === "number" ? Math.min(30000, Math.max(1500, d.interval)) : 3000;
		if (err === 7) {
			later(a, Math.max(6000, interval * 2));
			return;
		}
		if (err === 2046 || d.account_flow === "verify") {
			if (a.challenge) return;
			const ways = Array.isArray(d.verify_ways)
				? d.verify_ways.map((w) => str(dict(w).verify_way))
				: [];
			const way =
				ways.find((w) => /^(?:assist_)?mobile_sms_verify$/.test(w)) ??
				(/^(?:assist_)?mobile_sms_verify$/.test(str(d.std_verify_way))
					? str(d.std_verify_way)
					: undefined);
			if (way) {
				const trace = randomBytes(4).toString("hex");
				for (const k of ["verify_ticket", "std_verify_token", "encrypt_uid"])
					if (str(d[k])) ctx.redact(str(d[k]));
				const sent = await a.session.exchange("send_code", signal(a), smsFields(d, way), trace);
				if (!valid(a)) return;
				if (!sent.ok || !accepted(sent.body)) {
					failure(a, t("sendFailed"));
					return;
				}
				a.challenge = { data: d, way, trace, busy: false };
				publish({
					status: "confirming",
					message: t("sms"),
					verification: { kind: "sms", attemptId: a.id },
				});
				a.timer = ctx.setTimeout(
					() => {
						failure(a, t("expired"));
					},
					Math.max(0, a.expires - Date.now()),
				);
				return;
			}
			const link = str(d.verify_url) || str(d.verify_center_url);
			try {
				const u = new URL(link);
				if (!trusted(u, ["www.douyin.com", "login.douyin.com", "verify.snssdk.com"])) throw Error();
				publish({
					status: "confirming",
					message: t("official"),
					verification: { kind: "external", url: u.href },
				});
				later(a, 6000);
				return;
			} catch {
				failure(a, t("noVerify"));
				return;
			}
		}
		if (d.status === "new") {
			later(a, interval);
			return;
		}
		if (d.status === "scanned") {
			publish({ status: "confirming", message: t("scanned") });
			later(a, interval);
			return;
		}
		if (d.status !== "confirmed" || err) {
			failure(a, t(d.status === "expired" ? "expired" : "network"));
			return;
		}
		const raw =
			str(d.redirect_url) || (Array.isArray(d.redirect_urls) ? str(d.redirect_urls[0]) : "");
		if (raw) {
			const jumped = await a.session.sso(raw, signal(a));
			if (!valid(a)) return;
			if (!jumped.ok) {
				failure(a, jumped.message);
				return;
			}
		}
		const verified = await a.session.account(signal(a));
		if (!valid(a)) return;
		if (!verified.ok) {
			failure(a, verified.message);
			return;
		}
		const stored = await enqueue(async () =>
			valid(a)
				? ctx.secrets.set(cookieKey, a.session.jar.snapshot())
				: fail("conflict", t("expired")),
		);
		if (!valid(a)) return;
		if (!stored.ok) {
			failure(a, t("saveFailed"));
			return;
		}
		cookies = a.session.jar;
		accountName = verified.name;
		identity.abort();
		identity = new AbortController();
		end();
		publish({ status: "logged-in", loggedInAt: new Date().toISOString() });
	}
	function accepted(obj: Record<string, unknown>) {
		const code = dict(obj.data).error_code ?? obj.error_code;
		return code === undefined ? obj.message === "success" : Number(code) === 0;
	}
	async function beginLogin() {
		replace();
		const token = epoch;
		// A previous user's credentials must not travel with the new QR or later appear after a restart.
		const removed = await enqueue(() => ctx.secrets.delete(cookieKey));
		if (epoch !== token || ctx.signal.aborted) return fail("conflict", t("expired"));
		if (!removed.ok) return removed;
		accountName = null;
		cookies = ctx.createCookieSession();
		const a: Attempt = {
			controller: new AbortController(),
			session: passport(ctx),
			id: randomUUID(),
			expires: Date.now() + 180000,
			token: "",
		};
		active = a;
		publish({ status: "confirming", message: t("requesting") });
		const r = await a.session.exchange("get_qrcode", signal(a), {
			next: `${WEB}/`,
			need_short_url: "true",
			need_logo: "false",
			is_new_login: "1",
		});
		if (!valid(a)) return fail("conflict", t("expired"));
		if (!r.ok) return failure(a, r.message);
		const d = dict(r.body.data);
		a.token = str(d.token);
		if (!a.token) return failure(a, t("qrFailed"));
		ctx.redact(a.token);
		const url = str(d.qrcode_index_url) || a.token;
		ctx.redact(url);
		const exp = Number(d.expire_time) * 1000;
		if (Number.isFinite(exp) && exp > 0) a.expires = Math.min(a.expires, exp);
		if (a.expires <= Date.now() || url.length > 2000) return failure(a, t("expired"));
		const png = await QRCode.toDataURL(url, { errorCorrectionLevel: "M", width: 256 });
		if (!valid(a)) return fail("conflict", t("expired"));
		publish({
			status: "awaiting-scan",
			qr: { dataUrl: png, expiresAt: new Date(a.expires).toISOString() },
		});
		later(a, 3000);
		return ok();
	}
	async function logout() {
		replace();
		const token = epoch;
		const r = await enqueue(() => ctx.secrets.delete(cookieKey));
		if (!r.ok) return r;
		if (epoch === token) {
			accountName = null;
			cookies = ctx.createCookieSession();
			publish({ status: "logged-out" });
		}
		return ok();
	}
	async function submitVerification(id: string, code: string): Promise<Result> {
		const a = active,
			c = a?.challenge;
		if (!a || !c || !valid(a) || a.id !== id || a.expires <= Date.now() || c.busy)
			return fail("conflict", t("expired"));
		if (!/^\d{6}$/.test(code)) return fail("invalid", t("wrongCode"));
		c.busy = true;
		ctx.redact(code);
		try {
			const r = await a.session.exchange(
				"validate_code",
				signal(a),
				smsFields(c.data, c.way, code),
				c.trace,
			);
			if (!valid(a) || a.challenge !== c) return fail("conflict", t("expired"));
			if (!r.ok) return r;
			if (!accepted(r.body)) return fail("invalid", t("wrongCode"));
			a.challenge = undefined;
			publish({ status: "confirming", message: t("scanned") });
			later(a, 1000);
			return ok();
		} finally {
			c.busy = false;
		}
	}
	// A transport error on startup isn't evidence of logout. Recheck with backoff.
	async function restore(token: number) {
		const r = await passport(ctx, cookies).account(AbortSignal.any([identity.signal, ctx.signal]));
		if (ctx.signal.aborted || token !== epoch) return;
		if (r.ok) {
			accountName = r.name;
			publish({ status: "logged-in", loggedInAt: new Date().toISOString() });
		} else if (r.code === "unauthorized") {
			await invalidate(identity.signal, true);
		} else {
			publish({ status: "confirming", message: t("checking") });
			ctx.setTimeout(() => {
				if (token === epoch && !ctx.signal.aborted) return restore(token);
			}, 60000);
		}
	}
	async function invalidate(old: AbortSignal, fromStoredCheck = false) {
		if (
			identity.signal !== old ||
			old.aborted ||
			ctx.signal.aborted ||
			(!fromStoredCheck &&
				!cookieValue(cookies.header(WEB), "sessionid") &&
				!cookieValue(cookies.header(WEB), "sessionid_ss"))
		)
			return;
		replace();
		const token = epoch;
		cookies = ctx.createCookieSession();
		accountName = null;
		const saved = await enqueue(() => ctx.secrets.delete(cookieKey));
		if (token === epoch)
			publish(
				saved.ok
					? { status: "expired", message: t("credentials") }
					: { status: "error", message: t("saveFailed") },
			);
	}
	const saved = ctx.secrets.get<string>(cookieKey);
	if (saved) {
		try {
			cookies = ctx.createCookieSession(saved);
			state = { status: "confirming", message: t("checking") };
			void restore(epoch);
		} catch {
			state = { status: "error", message: t("credentials") };
		}
	}
	ctx.onDispose(() => {
		replace();
		listeners.clear();
	});
	const auth: SourceAuth = {
		beginLogin,
		logout,
		submitVerification,
		state: () => state,
		account: () => (accountName ? { name: accountName } : null),
		onChange(cb) {
			listeners.add(cb);
			return {
				dispose: () => {
					listeners.delete(cb);
				},
			};
		},
	};
	return {
		...auth,
		credentials: (url: URL) => cookies.header(url.href),
		sessionSignal: () => identity.signal,
		invalidate,
	};
}
