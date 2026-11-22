import {
	type AuthState,
	type Disposable,
	type ExtensionContext,
	fail,
	ok,
	type Result,
	type SourceAuth,
} from "@bilibili-notify/extension";
import { type Cookies, createClient, decimalId, HOME, json, record, urlAt } from "./client";
import { beginQr, checkedAccount, checkQr, loginChain } from "./passport";

const SECRET = "login.session";
const HOUR = 3600000;
const SINA = "https://login.sina.com.cn/sso/login.php";
interface Session {
	uid: string;
	name: string;
	cookies: Cookies;
	renewedAt: number;
	renewalBlocked?: boolean;
}

function canRenew(cookies: Cookies) {
	return /(?:^|;\s*)(?:ALC|tgc|TGC|TGT)=[^;]+/.test(cookies.header(SINA));
}

export function createAccount(ctx: ExtensionContext) {
	const client = createClient(ctx);
	const listeners = new Set<() => void>();
	let state: AuthState = { status: "logged-out" };
	let life = new AbortController();
	let session: Session | undefined;
	let timer: Disposable | undefined;
	let failures = 0;
	let writes = Promise.resolve();
	let operations = Promise.resolve();
	function serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = operations.then(operation);
		operations = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	function write(signal: AbortSignal, operation: () => Promise<Result>) {
		const work = writes.then(() => (signal.aborted ? cancelled() : operation()));
		writes = work.then(
			() => undefined,
			() => undefined,
		);
		return work;
	}
	function cancelled() {
		return fail("indeterminate", ctx.i18n.t("request.cancelled"));
	}
	function publish(next: AuthState) {
		state = next;
		for (const listener of listeners) listener();
	}
	function replace() {
		life.abort();
		timer?.dispose();
		failures = 0;
		life = new AbortController();
		return AbortSignal.any([life.signal, ctx.signal]);
	}
	function error(message: string) {
		publish({ status: "error", message });
	}
	async function save(next: Session, signal: AbortSignal) {
		const stored = await write(signal, () =>
			ctx.secrets.set(
				SECRET,
				JSON.stringify({
					uid: next.uid,
					cookies: next.cookies.snapshot(),
					renewedAt: next.renewedAt,
					renewalBlocked: next.renewalBlocked,
				}),
			),
		);
		if (signal.aborted) return cancelled();
		if (!stored.ok) return fail(stored.code, ctx.i18n.t("auth.storage"));
		session = next;
		return ok();
	}
	async function confirm(next: Session, signal: AbortSignal) {
		const stored = await save(next, signal);
		if (signal.aborted) return cancelled();
		if (!stored.ok) {
			error(stored.message);
			return stored;
		}
		publish({
			status: "logged-in",
			loggedInAt: state.status === "logged-in" ? state.loggedInAt : new Date().toISOString(),
		});
		if (next.renewalBlocked || !canRenew(next.cookies))
			ctx.reportProblem({ code: "weibo_renewal", message: ctx.i18n.t("auth.renewal") });
		else ctx.resolveProblem({ code: "weibo_renewal" });
		scheduleCheck(6 * HOUR, signal);
		return ok();
	}
	function scheduleCheck(delay: number, signal: AbortSignal) {
		timer?.dispose();
		timer = ctx.setTimeout(() => {
			void serial(() => maintain(signal));
		}, delay);
	}
	async function maintain(signal: AbortSignal, force = false): Promise<Result> {
		if (signal.aborted || !session) return cancelled();
		const result = await check(session, signal, force);
		if (signal.aborted) return cancelled();
		if (result.ok) {
			failures = 0;
			return result;
		}
		if (result.code === "unauthorized" || result.upstreamCode === "weibo.account_changed") {
			timer?.dispose();
			publish({ status: "expired", message: result.message });
		} else if (result.upstreamCode === "weibo.verify" || result.upstreamCode === "weibo.protocol") {
			timer?.dispose();
			error(result.message);
		} else {
			if (state.status !== "logged-in" || force)
				publish({ status: "confirming", message: result.message });
			const delays = [300000, 1800000, 6 * HOUR];
			scheduleCheck(
				Math.min(
					2147483647,
					Math.max(delays[Math.min(failures++, delays.length - 1)], client.retryAt() - Date.now()),
				),
				signal,
			);
		}
		return result;
	}
	function pollQr(id: string, cookies: Cookies, until: number, signal: AbortSignal) {
		timer = ctx.setTimeout(async () => {
			if (signal.aborted) return;
			if (Date.now() >= until) {
				error(ctx.i18n.t("auth.qrExpired"));
				return;
			}
			const result = await checkQr(client, cookies, id, signal);
			if (signal.aborted) return;
			if (!result.ok) {
				error(result.message);
				return;
			}
			if (result.kind === "waiting") {
				if (result.scanned) publish({ status: "confirming", message: ctx.i18n.t("auth.scanned") });
				pollQr(id, cookies, until, signal);
				return;
			}
			publish({ status: "confirming", message: ctx.i18n.t("auth.checking") });
			const verified = await loginChain(client, cookies, result.url, signal);
			if (signal.aborted) return;
			if (!verified.ok) {
				error(verified.message);
				return;
			}
			await confirm(
				{ uid: verified.uid, name: verified.name, cookies, renewedAt: Date.now() },
				signal,
			);
		}, 3000);
	}
	async function check(current: Session, signal: AbortSignal, force = false) {
		if (signal.aborted) return cancelled();
		const cookies = ctx.createCookieSession(current.cookies.snapshot());
		const home = await client.request(cookies, new URL(HOME), signal, "text/html");
		if (signal.aborted) return cancelled();
		const checked = home.ok ? checkedAccount(ctx, home, current.uid) : home;
		if (!checked.ok && checked.code !== "unauthorized") return checked;
		if (
			!current.renewalBlocked &&
			canRenew(current.cookies) &&
			(!checked.ok || force || Date.now() - current.renewedAt >= 24 * HOUR)
		) {
			const candidate = ctx.createCookieSession(
				(checked.ok ? cookies : current.cookies).snapshot(),
			);
			const start = urlAt(SINA, "/sso/login.php", {
				url: HOME,
				gateway: "1",
				service: "miniblog",
				entry: "miniblog",
				useticket: "1",
				returntype: "META",
			});
			const renewed = await loginChain(client, candidate, start, signal, current.uid, true);
			if (!renewed.ok) {
				if (signal.aborted || force || !checked.ok) return renewed;
				// A proactive renewal can fail while the original, separately verified session still works.
				const blocked =
					renewed.code === "unauthorized" ||
					renewed.code === "conflict" ||
					renewed.upstreamCode === "weibo.verify" ||
					renewed.upstreamCode === "weibo.protocol";
				const kept = await confirm(
					{ ...current, cookies, name: checked.name, renewalBlocked: blocked },
					signal,
				);
				return !kept.ok || blocked ? kept : renewed;
			}
			return confirm(
				{ uid: current.uid, name: renewed.name, cookies: candidate, renewedAt: Date.now() },
				signal,
			);
		}
		return checked.ok ? confirm({ ...current, name: checked.name, cookies }, signal) : checked;
	}
	async function restore(saved: string, signal: AbortSignal) {
		if (signal.aborted) return;
		const fields = record(json(saved));
		const uid = decimalId(fields.uid);
		if (!uid || typeof fields.cookies !== "string") {
			error(ctx.i18n.t("auth.storage"));
			return;
		}
		let cookies: Cookies;
		try {
			cookies = ctx.createCookieSession(fields.cookies);
		} catch {
			error(ctx.i18n.t("auth.storage"));
			return;
		}
		publish({ status: "confirming", message: ctx.i18n.t("auth.checking") });
		session = {
			uid,
			name: uid,
			cookies,
			renewedAt: typeof fields.renewedAt === "number" ? fields.renewedAt : 0,
			renewalBlocked: fields.renewalBlocked === true,
		};
		await maintain(signal);
	}
	ctx.onDispose(() => {
		life.abort();
		timer?.dispose();
		listeners.clear();
	});
	const saved = ctx.secrets.get(SECRET);
	if (typeof saved === "string") {
		const signal = replace();
		void serial(() => restore(saved, signal));
	}
	const auth: SourceAuth = {
		state: () => state,
		account: () => (state.status === "logged-in" && session ? { name: session.name } : null),
		onChange(fn) {
			listeners.add(fn);
			return {
				dispose: () => {
					listeners.delete(fn);
				},
			};
		},
		async beginLogin() {
			const signal = replace();
			publish({ status: "confirming", message: ctx.i18n.t("auth.preparing") });
			const cookies = ctx.createCookieSession();
			const result = await beginQr(client, cookies, signal);
			if (signal.aborted) return fail("indeterminate", ctx.i18n.t("request.cancelled"));
			if (!result.ok) {
				publish({ status: "error", message: result.message });
				return result;
			}
			const until = Date.now() + 180000;
			publish({
				status: "awaiting-scan",
				qr: { dataUrl: result.dataUrl, expiresAt: new Date(until).toISOString() },
			});
			pollQr(result.id, cookies, until, signal);
			return ok();
		},
		async logout() {
			const signal = replace();
			session = undefined;
			const removed = await write(signal, () => ctx.secrets.delete(SECRET));
			if (signal.aborted) return cancelled();
			if (!removed.ok) {
				error(ctx.i18n.t("auth.storage"));
				return removed;
			}
			ctx.resolveProblem({ code: "weibo_renewal" });
			publish({ status: "logged-out" });
			return ok();
		},
	};
	function sessionSignal() {
		return AbortSignal.any([life.signal, ctx.signal]);
	}
	function uid() {
		return state.status === "logged-in" ? session?.uid : undefined;
	}
	function get(path: string, params: Record<string, string>, caller: AbortSignal, referer = HOME) {
		const generation = sessionSignal();
		const signal = AbortSignal.any([caller, generation]);
		const url = urlAt(HOME, path, params);
		async function read(current: Session) {
			const cookies = ctx.createCookieSession(current.cookies.snapshot());
			const response = await client.read(cookies, url, signal, referer);
			if (response.ok && response.updated) {
				const stored = await save({ ...current, cookies }, signal);
				if (!stored.ok) return stored;
			}
			return response;
		}
		return serial(async (): Promise<Result<{ data: Record<string, unknown> }>> => {
			if (signal.aborted) return cancelled();
			if (!uid() || !session) return fail("unauthorized", ctx.i18n.t("auth.required"));
			let response = await read(session);
			if (!response.ok && response.code === "unauthorized" && !signal.aborted) {
				const recovery = await maintain(generation, true);
				if (!recovery.ok) return recovery;
				if (signal.aborted || !session) return cancelled();
				response = await read(session);
				if (!response.ok && response.code === "unauthorized" && !signal.aborted) {
					timer?.dispose();
					publish({ status: "expired", message: response.message });
				}
			}
			if (!response.ok && response.upstreamCode === "weibo.verify" && !signal.aborted) {
				timer?.dispose();
				error(response.message);
			}
			return response;
		});
	}
	return { auth, get, uid, sessionSignal };
}

export type WeiboAccount = ReturnType<typeof createAccount>;
