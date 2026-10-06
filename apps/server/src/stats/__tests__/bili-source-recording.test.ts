/**
 * 统计的 B 站适配 —— 「在记」小账(ADR-0027 决策 1 / 2 / 13)。
 *
 * - 「来源在跑」= B 站登录有效:定时(每 5 分钟)与挂上时、`auth-restored` 时各看一眼;状态每次现读,不靠事件记;
 *   登录无效不记;没绑好登录读口之前当作没在跑;
 * - 给每条「启用 ∧ 开关开着」的 B 站订阅记当前整点小时的 `posts` / `live`;
 * - 作品开关关着的订阅收到 `dynamic-detected` 不落作品行(不动引擎);
 * - `fans-refreshed` 里 B 站订阅、启用着、采样就在这个小时的条目记 `followers`。
 * 假时钟、假总线;落进记录器的调用看 `recordActive`。
 */

import type { MessageBus } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { attachBiliStatsSource, BILI_SOURCE_CHECK_MS } from "../bili-source.js";
import { createStatsRecorder, type StatsRecorderCore } from "../recorder.js";
import type { StatsStore } from "../store.js";

const T0 = Date.parse("2026-05-16T10:00:00.000Z");
const ON = { enabled: true, recordsPosts: true, recordsLive: true };
const bili = (id: string, uid: string, over: Record<string, unknown> = {}) => ({
	id,
	identity: { sourceKey: "bilibili", externalId: uid },
	...ON,
	...over,
});

function makeBus() {
	const handlers = new Map<string, Array<(payload?: unknown) => void>>();
	const bus = {
		emit: () => {},
		on: (event: string, handler: (payload?: unknown) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return { dispose() {} };
		},
	} as unknown as MessageBus;
	return {
		bus,
		trigger: (event: string, payload?: unknown) => {
			for (const h of handlers.get(event) ?? []) h(payload);
		},
	};
}

function makeRecorder() {
	return {
		recordActive: vi.fn(),
		recordPost: vi.fn(),
		openSession: vi.fn(),
		reportViewers: vi.fn(),
		closeSession: vi.fn(),
		forget: vi.fn(),
		drop: vi.fn(),
		recordFans: vi.fn(),
	} satisfies Record<keyof StatsRecorderCore, unknown> as unknown as StatsRecorderCore & {
		recordActive: ReturnType<typeof vi.fn>;
		recordPost: ReturnType<typeof vi.fn>;
	};
}

let loggedIn: boolean;
let subs: ReturnType<typeof bili>[];

function setup() {
	const { bus, trigger } = makeBus();
	const recorder = makeRecorder();
	const source = attachBiliStatsSource({
		bus,
		recorder,
		now: () => new Date(Date.now()),
		subscriptions: () => subs as never,
		isLoggedIn: () => loggedIn,
	});
	return { trigger, recorder, source };
}

const calls = (recorder: ReturnType<typeof makeRecorder>) =>
	recorder.recordActive.mock.calls.map((c) => `${c[0]}/${c[1]}`);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	loggedIn = true;
	subs = [bili("s1", "1"), bili("s2", "2", { recordsLive: false })];
});
afterEach(() => {
	vi.useRealTimers();
});

describe("B 站适配 —— 登录有效时定时记当前小时", () => {
	it("挂上时看一眼:登录有效就给「启用 ∧ 开关开着」的订阅记 posts / live", () => {
		const { recorder } = setup();
		expect(calls(recorder)).toEqual(["s1/posts", "s1/live", "s2/posts"]);
	});

	it("没登录:挂上时、定时都不记;登录读口每次现读,中途登上之后下一次定时就记", () => {
		loggedIn = false;
		const { recorder } = setup();
		expect(calls(recorder)).toEqual([]);
		vi.advanceTimersByTime(BILI_SOURCE_CHECK_MS * 3);
		expect(calls(recorder)).toEqual([]);
		loggedIn = true;
		vi.advanceTimersByTime(BILI_SOURCE_CHECK_MS);
		expect(calls(recorder)).toEqual(["s1/posts", "s1/live", "s2/posts"]);
	});

	it("定时每 5 分钟看一眼;停用 / 开关关着的订阅不记", () => {
		subs = [
			bili("s1", "1"),
			bili("off", "3", { enabled: false, recordsPosts: false, recordsLive: false }),
		];
		const { recorder } = setup();
		recorder.recordActive.mockClear();
		vi.advanceTimersByTime(BILI_SOURCE_CHECK_MS * 2);
		expect(calls(recorder)).toEqual(["s1/posts", "s1/live", "s1/posts", "s1/live"]);
	});

	it("auth-lost 之后停,直到恢复:定时现读状态,auth-restored 立刻补记一次", () => {
		const { trigger, recorder } = setup();
		recorder.recordActive.mockClear();
		// 登录丢了:状态读口回 false,事件只负责清理在飞状态。
		loggedIn = false;
		trigger("auth-lost");
		vi.advanceTimersByTime(BILI_SOURCE_CHECK_MS * 3);
		expect(calls(recorder)).toEqual([]);
		// 恢复:不等下一次定时,事件到了就补记。
		loggedIn = true;
		trigger("auth-restored");
		expect(calls(recorder)).toEqual(["s1/posts", "s1/live", "s2/posts"]);
	});

	it("dispose 清掉定时器:之后不再记", () => {
		const { recorder, source } = setup();
		recorder.recordActive.mockClear();
		source.dispose();
		vi.advanceTimersByTime(BILI_SOURCE_CHECK_MS * 3);
		expect(calls(recorder)).toEqual([]);
	});

	it("定时器不挡进程退出(unref)", () => {
		const unref = vi.spyOn(global, "setInterval");
		setup();
		const timer = unref.mock.results[0]?.value as { hasRef?: () => boolean } | undefined;
		expect(timer?.hasRef?.()).toBe(false);
		unref.mockRestore();
	});
});

describe("B 站适配 —— 登录读口没绑好之前当作没在跑", () => {
	it("真记录器:绑上之前什么都不落;绑上的那一刻立刻看一眼并落当前小时", async () => {
		const { bus } = makeBus();
		const store = {
			appendRecording: vi.fn(async () => {}),
			listRecording: vi.fn(async () => []),
			appendPost: vi.fn(async () => {}),
			drop: vi.fn(async () => {}),
		} as unknown as StatsStore & { appendRecording: ReturnType<typeof vi.fn> };
		const handle = createStatsRecorder({
			isEnabled: () => true,
			bus,
			store,
			fans: {} as never,
			fansCron: () => "*/10 * * * *",
			logger: { info() {}, warn() {}, error() {}, debug() {} },
			now: () => new Date(Date.now()),
			subscriptions: () => subs as never,
		});
		vi.advanceTimersByTime(BILI_SOURCE_CHECK_MS * 2);
		await handle.flush();
		expect(store.appendRecording).not.toHaveBeenCalled();
		handle.bindLoginState(() => true);
		await handle.flush();
		expect(
			store.appendRecording.mock.calls
				.map((c) => `${c[0]}/${(c[1] as { kind: string }).kind}`)
				.sort(),
		).toEqual(["s1/live", "s1/posts", "s2/posts"]);
		handle.dispose();
	});
});

describe("B 站适配 —— 作品开关与粉丝", () => {
	it("作品开关关着的订阅收到 dynamic-detected:不落作品行;开着的照落", () => {
		subs = [bili("s1", "1", { recordsPosts: false }), bili("s2", "2")];
		const { trigger, recorder } = setup();
		for (const uid of ["1", "2"]) {
			trigger("dynamic-detected", {
				uid,
				id: `d${uid}`,
				type: "DYNAMIC_TYPE_AV",
				ts: "2026-05-16T09:00:00.000Z",
			});
		}
		expect(recorder.recordPost.mock.calls.map((c) => c[0])).toEqual(["s2"]);
	});

	it("fans-refreshed:B 站订阅、启用着、本小时采样的条目记 followers;拓展、停用、老条目不记", () => {
		subs = [bili("s1", "1"), bili("off", "3", { enabled: false })];
		const { trigger, recorder } = setup();
		recorder.recordActive.mockClear();
		const entry = (subscriptionId: string, ts: string) => ({
			subscriptionId,
			current: 1,
			ts,
			deltaSubscribed: null,
			delta24h: null,
			delta7d: null,
		});
		trigger("fans-refreshed", {
			entries: [
				entry("s1", new Date(T0 - 60_000).toISOString()),
				entry("off", new Date(T0 - 60_000).toISOString()),
				entry("ext-1", new Date(T0 - 60_000).toISOString()),
				// 这一轮没采到、快照里还留着上一轮的(两小时前):不算「这个小时拉成功了」。
				entry("s1", new Date(T0 - 2 * 3_600_000).toISOString()),
			],
		});
		expect(recorder.recordActive.mock.calls).toEqual([["s1", "followers", T0 - 60_000]]);
	});
});
