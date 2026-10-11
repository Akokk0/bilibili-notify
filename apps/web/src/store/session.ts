import { create } from "zustand";

/**
 * Dashboard session state (distinct from a source account's login, which
 * lives in the query cache, see `hooks/use-source-auth.ts`). Mirrors `GET /api/session` and drives `<AuthGate>`, the
 * header logout button, and WS connect/disconnect gating.
 *
 * Single synchronous source of truth so non-React consumers (the api-client
 * 401 interceptor, the WS singleton gate) can read it without a hook.
 */
export interface SessionState {
	/** Server requires a dashboard login (basicAuth configured). */
	authRequired: boolean;
	/** A valid `bn_session` cookie is present. */
	authed: boolean;
	/** `GET /api/session` has resolved at least once (avoids login-flash). */
	hydrated: boolean;
	/**
	 * The session dropped *mid-use* (a 401 fired after we were authed) — as
	 * opposed to a cold "never logged in yet". Controls the dialog hint and
	 * whether the app stays mounted underneath (Q5: resume-in-place).
	 */
	expired: boolean;
	/** Apply a fresh `GET /api/session` result. */
	setStatus: (s: { authRequired: boolean; authed: boolean }) => void;
	/** Login succeeded — authed, clear the expired flag. */
	markAuthed: () => void;
	/** Explicit logout — unauthed WITHOUT the "expired" hint (intentional). */
	markLoggedOut: () => void;
	/**
	 * A gated `/api/*` call returned 401. Only meaningful when auth is
	 * required; `expired` is set iff we were previously authed (so a cold
	 * pre-login 401 storm doesn't show a misleading "session expired" hint).
	 */
	onApiUnauthorized: () => void;
}

/**
 * Pure transition for an observed 401 on a gated endpoint. Exported for unit
 * tests (web tests run in node env, no React render).
 */
export function nextOnUnauthorized(prev: SessionState): Pick<SessionState, "authed" | "expired"> {
	if (!prev.authRequired) return { authed: prev.authed, expired: prev.expired };
	return { authed: false, expired: prev.authed || prev.expired };
}

export const useSessionStore = create<SessionState>((set, get) => ({
	authRequired: false,
	authed: false,
	hydrated: false,
	expired: false,
	setStatus: ({ authRequired, authed }) =>
		set((s) => ({
			authRequired,
			authed,
			hydrated: true,
			// A fresh authed status clears any stale expired flag.
			expired: authed ? false : s.expired,
		})),
	markAuthed: () => set({ authed: true, expired: false, hydrated: true }),
	markLoggedOut: () => set({ authed: false, expired: false }),
	onApiUnauthorized: () => set(nextOnUnauthorized(get())),
}));
