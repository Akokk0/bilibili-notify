import type {
	AuthState,
	LiveSessionChange,
	MessageBus,
	SourceAuth,
} from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SourceView } from "../../subscriptions/registry.js";
import { attachLiveStatsSource } from "../live-source.js";
import type { StatsRecorderCore } from "../recorder.js";
import { attachRegistryStatsSource } from "../registry-source.js";

const NOW = Date.parse("2026-05-16T10:00:00.000Z");

function makeBus() {
	const handlers = new Map<string, Array<(payload?: unknown) => void>>();
	const bus = {
		emit: () => {},
		on: (event: string, handler: (payload?: unknown) => void) => {
			const found = handlers.get(event) ?? [];
			found.push(handler);
			handlers.set(event, found);
			return {
				dispose() {
					handlers.set(
						event,
						(handlers.get(event) ?? []).filter((candidate) => candidate !== handler),
					);
				},
			};
		},
	} as unknown as MessageBus;
	return {
		bus,
		trigger(event: string, payload?: unknown) {
			for (const handler of handlers.get(event) ?? []) handler(payload);
		},
	};
}

function makeRecorder() {
	return {
		recordPost: vi.fn(),
		openSession: vi.fn(),
		closeSession: vi.fn(),
		forget: vi.fn(),
		drop: vi.fn(),
		recordFans: vi.fn(),
		recordFollowers: vi.fn(async () => {}),
		recordActive: vi.fn(),
	} satisfies Record<keyof StatsRecorderCore, unknown> as unknown as StatsRecorderCore & {
		closeSession: ReturnType<typeof vi.fn>;
		forget: ReturnType<typeof vi.fn>;
	};
}

const authView = (state: () => AuthState): SourceView =>
	({ auth: { state } as SourceAuth }) as SourceView;

const liveStart = (
	id: string,
	sourceKey: string,
): Extract<LiveSessionChange, { kind: "start" }> => {
	const session = {
		subscriptionId: id,
		sourceKey,
		startedAt: "2026-05-16T09:00:00.000Z",
		detectedAt: "2026-05-16T10:00:00.000Z",
	};
	return { kind: "start", subscriptionId: id, session, trigger: "start-signal", details: {} };
};

const liveEnd = (change: ReturnType<typeof liveStart>): LiveSessionChange => ({
	kind: "end",
	subscriptionId: change.subscriptionId,
	session: change.session,
	reason: "signal",
	endedAt: new Date(NOW + 3_600_000).toISOString(),
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("RegistryStatsSource — 来源登录丢了", () => {
	it("两个在册来源各开一场:A 失登录只忘 A,B 照常收尾", () => {
		let stateA: AuthState = { status: "logged-in", loggedInAt: "2026-05-16T09:00:00.000Z" };
		const stateB: AuthState = { status: "logged-in", loggedInAt: "2026-05-16T09:00:00.000Z" };
		const { bus, trigger } = makeBus();
		const recorder = makeRecorder();
		const live = attachLiveStatsSource({
			bus,
			recorder,
			now: () => new Date(NOW),
			subscriptions: () => [
				{
					id: "a-1",
					identity: { sourceKey: "alpha", externalId: "1" },
					enabled: true,
					recordsPosts: true,
					recordsLive: true,
				},
				{
					id: "b-1",
					identity: { sourceKey: "beta", externalId: "1" },
					enabled: true,
					recordsPosts: true,
					recordsLive: true,
				},
			],
		});
		attachRegistryStatsSource({
			bus,
			sources: {
				get: (key) =>
					key === "alpha"
						? authView(() => stateA)
						: key === "beta"
							? authView(() => stateB)
							: undefined,
			},
			forgetOpenSessions: live.forgetOpenSessions,
		});

		const a = liveStart("a-1", "alpha");
		const b = liveStart("b-1", "beta");
		trigger("live-session-changed", a);
		trigger("live-session-changed", b);
		stateA = { status: "expired", message: "expired" };
		trigger("subscription-auth-changed", { sourceKey: "alpha", state: stateA });
		trigger("live-session-changed", liveEnd(a));
		trigger("live-session-changed", liveEnd(b));

		expect(recorder.forget).toHaveBeenCalledWith("a-1");
		expect(recorder.forget).not.toHaveBeenCalledWith("b-1");
		expect(recorder.closeSession).toHaveBeenCalledTimes(1);
		expect(recorder.closeSession).toHaveBeenCalledWith("b-1", expect.any(Object));
	});

	it("事件只当扳机:载荷说 logged-out,现读仍是 logged-in 就不忘", () => {
		const state: AuthState = { status: "logged-in", loggedInAt: "2026-05-16T09:00:00.000Z" };
		const { bus, trigger } = makeBus();
		const forgetOpenSessions = vi.fn();
		attachRegistryStatsSource({
			bus,
			sources: { get: () => authView(() => state) },
			forgetOpenSessions,
		});
		trigger("subscription-auth-changed", {
			sourceKey: "alpha",
			state: { status: "logged-out" },
		});
		expect(forgetOpenSessions).not.toHaveBeenCalled();
	});

	it("logged-in / awaiting-scan / confirming / error 都不忘", () => {
		let state: AuthState = { status: "logged-in", loggedInAt: "2026-05-16T09:00:00.000Z" };
		const { bus, trigger } = makeBus();
		const forgetOpenSessions = vi.fn();
		attachRegistryStatsSource({
			bus,
			sources: { get: () => authView(() => state) },
			forgetOpenSessions,
		});
		const states: AuthState[] = [
			{ status: "logged-in", loggedInAt: "2026-05-16T09:00:00.000Z" },
			{
				status: "awaiting-scan",
				qr: { dataUrl: "data:x", expiresAt: "2026-05-16T10:03:00.000Z" },
			},
			{ status: "confirming" },
			{ status: "error", message: "error" },
		];
		for (const next of states) {
			state = next;
			trigger("subscription-auth-changed", { sourceKey: "alpha", state: next });
		}
		expect(forgetOpenSessions).not.toHaveBeenCalled();
	});

	it("登记表没有这个键、来源没有登录口 → 不忘也不抛", () => {
		const { bus, trigger } = makeBus();
		const forgetOpenSessions = vi.fn();
		attachRegistryStatsSource({
			bus,
			sources: {
				get: (key) => (key === "no-auth" ? ({} as SourceView) : undefined),
			},
			forgetOpenSessions,
		});
		expect(() => {
			trigger("subscription-auth-changed", { sourceKey: "missing", state: { status: "expired" } });
			trigger("subscription-auth-changed", { sourceKey: "no-auth", state: { status: "expired" } });
		}).not.toThrow();
		expect(forgetOpenSessions).not.toHaveBeenCalled();
	});
});
