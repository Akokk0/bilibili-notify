import { LoadingBlock } from "@bilibili-notify/ui";
import { type ReactNode, useEffect } from "react";
import { setUnauthorizedHandler } from "../services/api";
import { fetchSessionStatus } from "../services/session";
import { setWsEnabled } from "../services/wsSingleton";
import { useSessionStore } from "../store/session";
import { LoginDialog } from "./LoginDialog";

/**
 * Top-level dashboard auth gate (Q5).
 *
 * - Probes `GET /api/session` once on mount and registers the api-client 401
 *   interceptor (mid-session cookie expiry → login dialog).
 * - `authRequired:false` or authed → renders the app.
 * - Cold + not authed → renders ONLY the login card. The authed app stays
 *   unmounted, so WS never connects before login (Q3/Q5).
 * - Mid-session expiry → keeps the app mounted (frozen) under an overlay
 *   login card so the user resumes in place after re-login.
 */
export function AuthGate({ children }: { children: ReactNode }) {
	const authRequired = useSessionStore((s) => s.authRequired);
	const authed = useSessionStore((s) => s.authed);
	const hydrated = useSessionStore((s) => s.hydrated);
	const expired = useSessionStore((s) => s.expired);
	const setStatus = useSessionStore((s) => s.setStatus);

	useEffect(() => {
		setUnauthorizedHandler(() => useSessionStore.getState().onApiUnauthorized());
		let alive = true;
		fetchSessionStatus()
			.then((s) => {
				if (alive) setStatus(s);
			})
			.catch(() => {
				// Network failure → treat as "auth required, not authed" so the
				// dialog shows rather than a blank app; backend-down is then
				// surfaced by the login attempt / health probe.
				if (alive) setStatus({ authRequired: true, authed: false });
			});
		return () => {
			alive = false;
			setUnauthorizedHandler(null);
		};
	}, [setStatus]);

	// Gate the WS socket on session state: connected only while authed (or auth
	// disabled). Tears down on logout / mid-session expiry so the ticket fetch
	// doesn't 401-spam on reconnect backoff; reconnects + replays on re-login.
	useEffect(() => {
		setWsEnabled(!authRequired || authed);
	}, [authRequired, authed]);

	if (!hydrated) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<LoadingBlock label="正在唤醒女仆" variant="inset" />
			</div>
		);
	}

	if (!authRequired || authed) return <>{children}</>;

	// Not authed + auth required.
	if (expired) {
		return (
			<>
				{children}
				<LoginDialog variant="overlay" />
			</>
		);
	}
	return <LoginDialog variant="cold" />;
}
