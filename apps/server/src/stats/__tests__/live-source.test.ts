import type {
	AuthState,
	LiveSession,
	LiveSessionChange,
	LiveSessionEndReason,
	MessageBus,
	SourceAuth,
} from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SourceView } from "../../subscriptions/registry.js";
import { attachLiveStatsSource } from "../live-source.js";
import { createStatsRecorder, type StatsRecorderCore } from "../recorder.js";
import type { StatsStore } from "../store.js";

const NOW = Date.parse("2026-05-16T10:00:00.000Z");
const HOUR = 60 * 60_000;
const BILI_SUB = {
	id: "id-1",
	identity: { sourceKey: "bilibili", externalId: "1" },
	enabled: true,
	recordsPosts: true,
	recordsLive: true,
};
const EXT_SUB = {
	id: "ext-1",
	identity: { sourceKey: "douyin", externalId: "sec-1" },
	enabled: true,
	recordsPosts: true,
	recordsLive: true,
};

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
		recordReportedFollowers: vi.fn(),
		recordFollowers: vi.fn(async () => {}),
		recordActive: vi.fn(),
	} satisfies Record<keyof StatsRecorderCore, unknown> as unknown as StatsRecorderCore & {
		openSession: ReturnType<typeof vi.fn>;
		closeSession: ReturnType<typeof vi.fn>;
		forget: ReturnType<typeof vi.fn>;
	};
}

function session(
	over: Partial<LiveSession> & Pick<LiveSession, "subscriptionId" | "sourceKey">,
): LiveSession {
	return {
		detectedAt: new Date(NOW).toISOString(),
		...over,
	};
}

function start(
	id = BILI_SUB.id,
	sourceKey = "bilibili",
	over: Partial<LiveSession> = {},
): Extract<LiveSessionChange, { kind: "start" }> {
	const current = session({
		subscriptionId: id,
		sourceKey,
		startedAt: new Date(NOW - HOUR).toISOString(),
		...over,
	});
	return {
		kind: "start",
		subscriptionId: id,
		session: current,
		trigger: "start-signal",
		details: {},
	};
}

function end(
	current: LiveSession,
	over: Partial<Extract<LiveSessionChange, { kind: "end" }>> = {},
): Extract<LiveSessionChange, { kind: "end" }> {
	return {
		kind: "end",
		subscriptionId: current.subscriptionId,
		session: current,
		reason: "signal",
		endedAt: new Date(NOW + HOUR).toISOString(),
		...over,
	};
}

function setup(
	subs: Array<typeof BILI_SUB> | (() => Array<typeof BILI_SUB>) = [BILI_SUB, EXT_SUB],
) {
	const { bus, trigger } = makeBus();
	const recorder = makeRecorder();
	const source = attachLiveStatsSource({
		bus,
		recorder,
		now: () => new Date(NOW),
		subscriptions: () => (typeof subs === "function" ? subs() : subs),
	});
	return { bus, source, recorder, trigger };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("live-session-changed → 一场直播", () => {
	it("开播把 lastDetails 的标题(截 100 字)与分区交进去", () => {
		const { recorder, trigger } = setup();
		const change = start();
		const title = "题".repeat(120);
		trigger("live-session-changed", {
			...change,
			session: {
				...change.session,
				lastDetails: { title, category: "游戏" },
			},
		} satisfies LiveSessionChange);
		expect(recorder.openSession).toHaveBeenCalledWith("id-1", {
			startedAt: change.session.startedAt,
			title: "题".repeat(100),
			category: "游戏",
		});
	});

	it("没有 lastDetails 时开播只交开播时刻", () => {
		const { recorder, trigger } = setup();
		const change = start();
		trigger("live-session-changed", change);
		expect(recorder.openSession).toHaveBeenCalledWith("id-1", {
			startedAt: change.session.startedAt,
		});
	});

	it("下播把峰值与五格互动汇总交进去;没有的格不补默认值", () => {
		const { recorder, trigger } = setup();
		const change = start();
		const interactions = {
			viewerChatCount: 30,
			viewerChatSenderCount: 8,
			superchatCount: 2,
			superchatTotals: { CNY: 50 },
			membershipCounts: { bilibili: { captain: 1 } },
		};
		trigger("live-session-changed", change);
		trigger(
			"live-session-changed",
			end({
				...change.session,
				peakTotalViewers: 12_000,
				interactions,
			}),
		);
		expect(recorder.closeSession).toHaveBeenCalledWith("id-1", {
			endedAt: new Date(NOW + HOUR).toISOString(),
			peakTotalViewers: 12_000,
			...interactions,
		});

		const bare = setup();
		const bareChange = start();
		bare.trigger("live-session-changed", bareChange);
		bare.trigger("live-session-changed", end(bareChange.session));
		expect(bare.recorder.closeSession).toHaveBeenCalledWith("id-1", {
			endedAt: new Date(NOW + HOUR).toISOString(),
		});
	});

	it("开播开一场,结束按变化里带的时刻与峰值收场", () => {
		const { recorder, trigger } = setup();
		const change = start();
		trigger("live-session-changed", change);
		trigger("live-session-changed", end({ ...change.session, peakTotalViewers: 12_000 }));

		expect(recorder.openSession).toHaveBeenCalledWith("id-1", {
			startedAt: new Date(NOW - HOUR).toISOString(),
		});
		expect(recorder.closeSession).toHaveBeenCalledWith("id-1", {
			endedAt: new Date(NOW + HOUR).toISOString(),
			peakTotalViewers: 12_000,
		});
	});

	it("手里没有这一场时,resume / tick / 在播 status 都能再认出来;已经在手上就不重复开", () => {
		const { recorder, source, trigger } = setup();
		const base = start();
		trigger("live-session-changed", {
			kind: "resume",
			subscriptionId: base.subscriptionId,
			session: base.session,
			details: {},
		} satisfies LiveSessionChange);
		trigger("live-session-changed", {
			kind: "tick",
			subscriptionId: base.subscriptionId,
			session: base.session,
		} satisfies LiveSessionChange);
		expect(recorder.openSession).toHaveBeenCalledTimes(1);

		source.forgetOpenSessions("bilibili");
		trigger("live-session-changed", {
			kind: "tick",
			subscriptionId: base.subscriptionId,
			session: base.session,
		} satisfies LiveSessionChange);
		source.forgetOpenSessions("bilibili");
		trigger("live-session-changed", {
			kind: "status",
			subscriptionId: base.subscriptionId,
			isLive: true,
			session: base.session,
		} satisfies LiveSessionChange);
		const opened = recorder.openSession.mock.calls.length;
		expect(opened).toBe(3);
		expect(recorder.openSession).toHaveBeenNthCalledWith(1, "id-1", {
			startedAt: base.session.startedAt,
		});
	});

	it("已经在手上的场次来 tick / 在播 status 时不查订阅", () => {
		const subscriptions = vi.fn(() => [BILI_SUB, EXT_SUB]);
		const { trigger } = setup(subscriptions);
		const base = start();
		trigger("live-session-changed", base);
		subscriptions.mockClear();

		trigger("live-session-changed", {
			kind: "tick",
			subscriptionId: base.subscriptionId,
			session: base.session,
		} satisfies LiveSessionChange);
		trigger("live-session-changed", {
			kind: "status",
			subscriptionId: base.subscriptionId,
			isLive: true,
			session: base.session,
		} satisfies LiveSessionChange);

		expect(subscriptions).not.toHaveBeenCalled();
	});

	it("ending、unmatched-end、不在播的 status 都不开也不关", () => {
		const { recorder, trigger } = setup();
		const current = start().session;
		trigger("live-session-changed", {
			kind: "ending",
			subscriptionId: current.subscriptionId,
			session: current,
		} satisfies LiveSessionChange);
		trigger("live-session-changed", {
			kind: "unmatched-end",
			subscriptionId: current.subscriptionId,
			endedAt: new Date(NOW).toISOString(),
		} satisfies LiveSessionChange);
		trigger("live-session-changed", {
			kind: "status",
			subscriptionId: current.subscriptionId,
			isLive: false,
			session: current,
		} satisfies LiveSessionChange);
		expect(recorder.openSession).not.toHaveBeenCalled();
		expect(recorder.closeSession).not.toHaveBeenCalled();
	});

	it("每种结束原因都收场;订阅不在了只忘掉,不再写回文件", () => {
		const reasons: LiveSessionEndReason[] = [
			"signal",
			"grace-expired",
			"poll",
			"superseded",
			"stopped",
		];
		for (const reason of reasons) {
			const { recorder, trigger } = setup();
			const current = start().session;
			trigger("live-session-changed", start(current.subscriptionId, current.sourceKey, current));
			trigger("live-session-changed", end(current, { reason }));
			expect(recorder.closeSession, reason).toHaveBeenCalledTimes(1);
		}

		let subs = [BILI_SUB];
		const gone = setup(() => subs);
		const current = start().session;
		gone.trigger("live-session-changed", start());
		subs = [];
		gone.trigger("live-session-changed", end(current, { reason: "stopped" }));
		expect(gone.recorder.forget).toHaveBeenCalledWith("id-1");
		expect(gone.recorder.closeSession).not.toHaveBeenCalled();
	});

	it("没开着的 end 不写", () => {
		const { recorder, trigger } = setup();
		trigger("live-session-changed", end(start().session));
		expect(recorder.closeSession).not.toHaveBeenCalled();
	});

	it("两条订阅的结束各按自己的峰值收场", () => {
		const { recorder, trigger } = setup();
		const bili = start();
		const ext = start(EXT_SUB.id, "douyin");
		trigger("live-session-changed", bili);
		trigger("live-session-changed", ext);
		trigger("live-session-changed", end({ ...bili.session, peakTotalViewers: 120 }));
		trigger("live-session-changed", end({ ...ext.session, peakTotalViewers: 430 }));
		expect(recorder.closeSession).toHaveBeenNthCalledWith(1, BILI_SUB.id, {
			endedAt: end(bili.session).endedAt,
			peakTotalViewers: 120,
		});
		expect(recorder.closeSession).toHaveBeenNthCalledWith(2, EXT_SUB.id, {
			endedAt: end(ext.session).endedAt,
			peakTotalViewers: 430,
		});
	});

	it("同一订阅的新一场不带上另一场的峰值", () => {
		const { recorder, trigger } = setup();
		const first = start();
		trigger("live-session-changed", first);
		trigger("live-session-changed", end({ ...first.session, peakTotalViewers: 900 }));
		const second = start(BILI_SUB.id, "bilibili", {
			startedAt: new Date(NOW).toISOString(),
			detectedAt: new Date(NOW + 1).toISOString(),
		});
		trigger("live-session-changed", second);
		trigger("live-session-changed", end(second.session));
		expect(recorder.closeSession).toHaveBeenNthCalledWith(2, BILI_SUB.id, {
			endedAt: end(second.session).endedAt,
		});
	});

	it("开播时刻晚于此刻或解析不出时,退回这一场被认出的时刻", () => {
		for (const [sourceKey, id] of [
			["bilibili", BILI_SUB.id],
			["douyin", EXT_SUB.id],
		] as const) {
			const { recorder, trigger } = setup();
			for (const startedAt of [new Date(NOW + HOUR).toISOString(), "不是时间"]) {
				trigger(
					"live-session-changed",
					start(id, sourceKey, {
						startedAt,
						detectedAt: new Date(NOW + 1).toISOString(),
					}),
				);
			}
			expect(recorder.openSession).toHaveBeenNthCalledWith(1, id, {
				startedAt: new Date(NOW + 1).toISOString(),
			});
			expect(recorder.openSession).toHaveBeenNthCalledWith(2, id, {
				startedAt: new Date(NOW + 1).toISOString(),
			});
		}
	});
});

describe("登录失效后忘掉在飞的场次", () => {
	it("忘掉之后同一场再发 end → 不写(今天会写)", () => {
		const { bus, recorder, source, trigger } = setup();
		const change = start();
		trigger("live-session-changed", change);
		source.forgetOpenSessions("bilibili");
		trigger("live-session-changed", end(change.session));
		expect(recorder.forget).toHaveBeenCalledWith("id-1");
		expect(recorder.closeSession).not.toHaveBeenCalled();
		expect(bus).toBeDefined();
	});

	it("忘掉之后同一开播时刻的在播 status → 再认出,之后的 end 照写", () => {
		const { recorder, source, trigger } = setup();
		const change = start();
		trigger("live-session-changed", change);
		source.forgetOpenSessions("bilibili");
		trigger("live-session-changed", {
			kind: "status",
			subscriptionId: change.subscriptionId,
			isLive: true,
			session: change.session,
		} satisfies LiveSessionChange);
		trigger("live-session-changed", end({ ...change.session, peakTotalViewers: 4321 }));
		expect(recorder.openSession).toHaveBeenCalledTimes(2);
		expect(recorder.openSession).toHaveBeenLastCalledWith("id-1", {
			startedAt: change.session.startedAt,
		});
		expect(recorder.closeSession).toHaveBeenCalledWith("id-1", {
			endedAt: new Date(NOW + HOUR).toISOString(),
			peakTotalViewers: 4321,
		});
	});

	it("来源登录丢了:经记录器忘掉这一场,end 不写;同一开播时刻再认出后照常收尾", async () => {
		let state: AuthState = { status: "logged-in", loggedInAt: new Date(NOW).toISOString() };
		const { bus, trigger } = makeBus();
		const store = {
			openLiveSession: vi.fn(async () => {}),
			closeLiveSession: vi.fn(async () => {}),
			// 在册来源登录着,挂上时登记表适配会记「这个小时在记」,与场次写进同一个键的队。
			appendRecording: vi.fn(async () => {}),
			listRecording: vi.fn(async () => []),
		} as unknown as StatsStore & {
			openLiveSession: ReturnType<typeof vi.fn>;
			closeLiveSession: ReturnType<typeof vi.fn>;
		};
		const readState = vi.fn(() => state);
		const auth = { state: readState } as unknown as SourceAuth;
		const getSource = vi.fn((sourceKey: string) =>
			sourceKey === "douyin" ? ({ auth } as SourceView) : undefined,
		);
		const handle = createStatsRecorder({
			isEnabled: () => true,
			bus,
			store,
			followers: {} as never,
			logger: { info() {}, warn() {}, error() {}, debug() {} },
			now: () => new Date(NOW),
			subscriptions: () => [EXT_SUB],
			sources: { get: getSource },
		});

		const change = start(EXT_SUB.id, "douyin");
		trigger("live-session-changed", change);
		// 排在「在记」那一笔后面:等队落地。
		await handle.flush();
		expect(store.openLiveSession).toHaveBeenCalledTimes(1);

		state = { status: "logged-out" };
		expect(auth.state()).toEqual({ status: "logged-out" });
		trigger("subscription-auth-changed", { sourceKey: "douyin", state });
		expect(getSource).toHaveBeenCalledWith("douyin");
		expect(readState).toHaveReturnedWith({ status: "logged-out" });
		trigger("live-session-changed", end(change.session));
		expect(store.closeLiveSession).not.toHaveBeenCalled();

		trigger("live-session-changed", {
			kind: "status",
			subscriptionId: change.subscriptionId,
			isLive: true,
			session: change.session,
		} satisfies LiveSessionChange);
		await handle.flush();
		expect(store.openLiveSession).toHaveBeenCalledTimes(2);
		expect(store.openLiveSession).toHaveBeenLastCalledWith("ext-1", {
			startedAt: change.session.startedAt,
		});
		trigger("live-session-changed", end(change.session));
		await handle.flush();
		expect(store.closeLiveSession).toHaveBeenCalledWith("ext-1", {
			endedAt: new Date(NOW + HOUR).toISOString(),
		});
		handle.dispose();
	});
});

describe("记录开关", () => {
	it("enabled 但 recordsLive 关着 → 不开、end 不写", () => {
		const sub = { ...BILI_SUB, recordsLive: false };
		const { recorder, trigger } = setup([sub]);
		const change = start();
		trigger("live-session-changed", change);
		trigger("live-session-changed", end(change.session));
		expect(recorder.openSession).not.toHaveBeenCalled();
		expect(recorder.closeSession).not.toHaveBeenCalled();
	});
});
