import type {
	AuthState,
	LiveSessionChange,
	MessageBus,
	SourceAuth,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SourceView } from "../../subscriptions/registry.js";
import type { StatsSubscription } from "../file-key.js";
import { attachLiveStatsSource } from "../live-source.js";
import type { StatsRecorderCore } from "../recorder.js";
import { attachRegistryStatsSource, RECORDING_CHECK_MS } from "../registry-source.js";

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
			recorder,
			subscriptions: () => [],
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
			recorder: makeRecorder(),
			subscriptions: () => [],
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
			recorder: makeRecorder(),
			subscriptions: () => [],
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
			recorder: makeRecorder(),
			subscriptions: () => [],
		});
		expect(() => {
			trigger("subscription-auth-changed", { sourceKey: "missing", state: { status: "expired" } });
			trigger("subscription-auth-changed", { sourceKey: "no-auth", state: { status: "expired" } });
		}).not.toThrow();
		expect(forgetOpenSessions).not.toHaveBeenCalled();
	});
});

// ———— 「这个小时在记」:核心对所有在册来源记 ————

const T0 = Date.parse("2026-05-16T10:00:00.000Z");
const LOGGED_IN: AuthState = { status: "logged-in", loggedInAt: "2026-05-16T09:00:00.000Z" };
const sub = (
	id: string,
	sourceKey: string,
	over: Partial<StatsSubscription> = {},
): StatsSubscription => ({
	id,
	identity: { sourceKey, externalId: id },
	enabled: true,
	recordsPosts: true,
	recordsLive: true,
	...over,
});

describe("RegistryStatsSource — 记这个小时在记", () => {
	let subs: StatsSubscription[];
	let views: Record<string, SourceView>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		subs = [];
		views = {};
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function setup() {
		const { bus, trigger } = makeBus();
		const recorder = makeRecorder();
		const source = attachRegistryStatsSource({
			bus,
			sources: { get: (key) => views[key] },
			forgetOpenSessions: vi.fn(),
			recorder,
			subscriptions: () => subs,
		});
		return { trigger, recorder, source };
	}
	const calls = (recorder: ReturnType<typeof makeRecorder>) =>
		(recorder.recordActive as ReturnType<typeof vi.fn>).mock.calls.map((c) => `${c[0]}/${c[1]}`);

	it("没有登录口的在册来源:挂上时就按两格开关记", () => {
		views.alpha = {} as SourceView;
		subs = [sub("a-1", "alpha"), sub("a-2", "alpha", { recordsLive: false })];
		const { recorder } = setup();
		expect(calls(recorder)).toEqual(["a-1/posts", "a-1/live", "a-2/posts"]);
	});

	it("登录口六种状态:只有 logged-in 记", () => {
		const states: AuthState[] = [
			LOGGED_IN,
			{ status: "logged-out" },
			{ status: "awaiting-scan", qr: { dataUrl: "data:x", expiresAt: "2026-05-16T10:03:00.000Z" } },
			{ status: "confirming", message: "正在向 B 站确认登录状态" },
			{ status: "expired", message: "m" },
			{ status: "error", message: "m" },
		];
		subs = [sub("a-1", "alpha")];
		const recorded: string[] = [];
		for (const state of states) {
			views.alpha = authView(() => state);
			const { recorder, source } = setup();
			if (calls(recorder).length > 0) recorded.push(state.status);
			vi.advanceTimersByTime(RECORDING_CHECK_MS);
			source.dispose();
		}
		expect(recorded).toEqual(["logged-in"]);
	});

	it("事件只当扳机:载荷说已登录、现读是 logged-out → 不记", () => {
		subs = [sub("a-1", "alpha")];
		views.alpha = authView(() => ({ status: "logged-out" }));
		const { trigger, recorder } = setup();
		trigger("subscription-auth-changed", { sourceKey: "alpha", state: LOGGED_IN });
		expect(calls(recorder)).toEqual([]);
	});

	it("发已登录事件不推时钟就立刻记", () => {
		subs = [sub("a-1", "alpha")];
		let state: AuthState = { status: "logged-out" };
		views.alpha = authView(() => state);
		const { trigger, recorder } = setup();
		expect(calls(recorder)).toEqual([]);
		state = LOGGED_IN;
		trigger("subscription-auth-changed", { sourceKey: "alpha", state });
		expect(calls(recorder)).toEqual(["a-1/posts", "a-1/live"]);
	});

	it("登记表里没有的键(拓展订阅、没人认领)不记", () => {
		views.alpha = {} as SourceView;
		subs = [sub("a-1", "alpha"), sub("x-1", "ext-bot"), sub("m-1", "nobody")];
		const { recorder } = setup();
		vi.advanceTimersByTime(RECORDING_CHECK_MS);
		expect([...new Set(calls(recorder))]).toEqual(["a-1/posts", "a-1/live"]);
	});

	it("开机登记表空 → 一行不写;之后登记一个来源,推一个 RECORDING_CHECK_MS 就记上", () => {
		subs = [sub("a-1", "alpha")];
		const { recorder } = setup();
		vi.advanceTimersByTime(RECORDING_CHECK_MS - 1);
		expect(calls(recorder)).toEqual([]);
		views.alpha = {} as SourceView;
		vi.advanceTimersByTime(1);
		expect(calls(recorder)).toEqual(["a-1/posts", "a-1/live"]);
	});

	it("两格开关各看各的:recordsPosts 关着不记 posts", () => {
		views.alpha = {} as SourceView;
		subs = [sub("a-1", "alpha", { recordsPosts: false })];
		const { recorder } = setup();
		expect(calls(recorder)).toEqual(["a-1/live"]);
	});

	it("定时器不挡进程退出(unref)", () => {
		const spy = vi.spyOn(global, "setInterval");
		setup();
		const timer = spy.mock.results[0]?.value as { hasRef?: () => boolean } | undefined;
		expect(timer?.hasRef?.()).toBe(false);
		spy.mockRestore();
	});

	it("dispose 清掉定时器:之后不再记", () => {
		views.alpha = {} as SourceView;
		subs = [sub("a-1", "alpha")];
		const { recorder, source } = setup();
		(recorder.recordActive as ReturnType<typeof vi.fn>).mockClear();
		source.dispose();
		vi.advanceTimersByTime(RECORDING_CHECK_MS * 3);
		expect(calls(recorder)).toEqual([]);
	});
});
