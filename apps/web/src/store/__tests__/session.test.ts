import { describe, expect, it } from "vite-plus/test";
import { nextOnUnauthorized, type SessionState, useSessionStore } from "../session";

function state(over: Partial<SessionState>): SessionState {
	return {
		authRequired: false,
		authed: false,
		hydrated: false,
		expired: false,
		setStatus: () => {},
		markAuthed: () => {},
		markLoggedOut: () => {},
		onApiUnauthorized: () => {},
		...over,
	};
}

describe("nextOnUnauthorized", () => {
	it("auth not required → unchanged (a 401 is unrelated to dashboard session)", () => {
		const r = nextOnUnauthorized(state({ authRequired: false, authed: true }));
		expect(r).toEqual({ authed: true, expired: false });
	});

	it("was authed → drops auth AND flags expired (mid-session expiry)", () => {
		const r = nextOnUnauthorized(state({ authRequired: true, authed: true }));
		expect(r).toEqual({ authed: false, expired: true });
	});

	it("cold (never authed) → drops auth WITHOUT expired (no misleading hint)", () => {
		const r = nextOnUnauthorized(state({ authRequired: true, authed: false }));
		expect(r).toEqual({ authed: false, expired: false });
	});

	it("already expired stays expired", () => {
		const r = nextOnUnauthorized(state({ authRequired: true, authed: false, expired: true }));
		expect(r).toEqual({ authed: false, expired: true });
	});
});

describe("useSessionStore actions", () => {
	it("setStatus(authed) clears a stale expired flag and marks hydrated", () => {
		useSessionStore.setState({ authRequired: true, authed: false, expired: true, hydrated: false });
		useSessionStore.getState().setStatus({ authRequired: true, authed: true });
		const s = useSessionStore.getState();
		expect(s).toMatchObject({ authRequired: true, authed: true, expired: false, hydrated: true });
	});

	it("markLoggedOut clears authed + expired (intentional, no expiry hint)", () => {
		useSessionStore.setState({ authRequired: true, authed: true, expired: true });
		useSessionStore.getState().markLoggedOut();
		const s = useSessionStore.getState();
		expect(s.authed).toBe(false);
		expect(s.expired).toBe(false);
	});

	it("onApiUnauthorized routes through nextOnUnauthorized", () => {
		useSessionStore.setState({ authRequired: true, authed: true, expired: false });
		useSessionStore.getState().onApiUnauthorized();
		const s = useSessionStore.getState();
		expect(s.authed).toBe(false);
		expect(s.expired).toBe(true);
	});
});
