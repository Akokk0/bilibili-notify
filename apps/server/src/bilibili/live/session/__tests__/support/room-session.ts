import type { LiveDetails, SourceContext } from "@bilibili-notify/internal";
import { vi } from "vite-plus/test";
import { PROBLEM_TEXTS } from "../../../../problem-texts.js";
import type { LiveEvent } from "../../../protocol/events.js";
import type { LiveProblems } from "../../room-context.js";
import { RoomSession } from "../../room-session.js";
import { makeLiveProblems } from "./live-problems.js";

export const EXTERNAL_ID = "u1";
export const ROOM_ID = "r1";
export const STARTED_AT = "2026-01-01T02:00:00.000Z";

const DEFAULT_ROOM = {
	uid: 1,
	room_id: 1,
	live_status: 0,
	live_time: "0000-00-00 00:00:00",
	title: "标题",
	user_cover: "",
	keyframe: "",
	area_name: "分区",
	description: "简介",
};

type Timer = { fn: () => void; disposed: boolean };
type Timeout = Timer & { ms: number };

export type SessionHarnessOptions = {
	externalId?: string;
	roomId?: string;
	problems?: LiveProblems;
	liveStatus?: number;
	roomInfo?: () => Promise<Record<string, unknown> | undefined>;
	listener?: (
		roomId: string,
		handler: (event: LiveEvent) => void | Promise<void>,
		shouldAbort?: () => boolean,
	) => Promise<boolean>;
	master?: () => Promise<{ name?: string; fanClubName?: string }>;
	/** 抓封面口;不给就立刻回一张现成的引用。要卡住抓图的那一下由用例自己挂闸。 */
	fetchImage?: (url: string) => Promise<{ ok: true; ref: string }>;
};

/**
 * `RoomSession` 的公开行为夹具:假 `RoomContext` 只提供会话会调的口,
 * 定时器由测试手动驱动,事件经 `startLiveRoomListener` 拿到的事件漏斗派发。
 */
export function makeSessionHarness(options: SessionHarnessOptions = {}) {
	const timeouts: Timeout[] = [];
	const timeoutDelays: number[] = [];
	const intervals: Timer[] = [];
	const warnings: unknown[][] = [];
	const reports: Array<{ externalId: string; report: unknown }> = [];
	const interactions: Array<{ externalId: string; report: unknown }> = [];
	const superchatAvatars: Array<{ viewerId: string; url: string }> = [];
	const problems = (options.problems ?? makeLiveProblems()) as ReturnType<typeof makeLiveProblems>;
	let handler: ((event: LiveEvent) => void | Promise<void>) | undefined;
	let disposed = false;
	let roomInfo = options.roomInfo;

	const logger = {
		debug() {},
		info() {},
		warn: (...args: unknown[]) => void warnings.push(args),
		error(...args: unknown[]) {
			warnings.push(args);
		},
	};
	const source = {
		reportLive: (externalId: string, report: unknown) => {
			reports.push({ externalId, report });
		},
		reportLiveInteraction: (externalId: string, report: unknown) => {
			interactions.push({ externalId, report });
		},
		fetchImage:
			options.fetchImage ?? (async () => ({ ok: true as const, ref: `${"c".repeat(64)}.webp` })),
	} as unknown as SourceContext;

	const startLiveRoomListener = vi.fn(
		async (
			roomId: string,
			nextHandler: (event: LiveEvent) => void | Promise<void>,
			shouldAbort?: () => boolean,
		) => {
			handler = nextHandler;
			if (options.listener) return options.listener(roomId, nextHandler, shouldAbort);
			return true;
		},
	);
	const closeListener = vi.fn();
	const fetchRoomInfo = vi.fn(async () => {
		if (roomInfo) return roomInfo();
		return { ...DEFAULT_ROOM, live_status: options.liveStatus ?? 0 };
	});
	const fetchMasterSnapshot = vi.fn(
		options.master ??
			(async () => ({
				name: "U1",
				fanClubName: "测试牌",
			})),
	);

	const liveContext = {
		logger,
		setInterval: (fn: () => void) => {
			const item = { fn, disposed: false };
			intervals.push(item);
			return {
				dispose: () => {
					item.disposed = true;
				},
			};
		},
		setTimeout: (fn: () => void, ms: number) => {
			const item = { fn, ms, disposed: false };
			timeouts.push(item);
			timeoutDelays.push(ms);
			return {
				dispose: () => {
					item.disposed = true;
				},
			};
		},
		onDispose: () => {},
		signal: new AbortController().signal,
		track: () => {},
	};
	const ctx = {
		logger,
		liveContext,
		source,
		problems,
		fetchRoomInfo,
		fetchMasterSnapshot,
		startLiveRoomListener,
		closeListener,
		isDisposed: () => disposed,
		rememberSuperchatAvatar: (viewerId: string, url: string) => {
			superchatAvatars.push({ viewerId, url });
		},
	};
	const session = new RoomSession(ctx as never, {
		externalId: options.externalId ?? EXTERNAL_ID,
		roomId: options.roomId ?? ROOM_ID,
	});
	/** 「已报在播」现在是会话自己的私有状态;夹具只在断言处读它。 */
	const reportedLiveOf = (target: RoomSession): boolean =>
		(target as unknown as { reportedLive: boolean }).reportedLive;

	const settle = async () => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	};
	const runTimeouts = async () => {
		const batch = timeouts.splice(0);
		for (const item of batch) {
			if (!item.disposed) item.fn();
		}
		await settle();
	};

	return {
		session,
		ctx,
		problems,
		startLiveRoomListener,
		closeListener,
		fetchRoomInfo,
		fetchMasterSnapshot,
		reports,
		interactions,
		superchatAvatars,
		warnings,
		timeouts,
		timeoutDelays,
		intervals,
		settle,
		runTimeouts,
		async flushTimeouts(maxIterations = 50) {
			for (let i = 0; i < maxIterations && timeouts.length > 0; i++) {
				await runTimeouts();
			}
		},
		get handler() {
			if (!handler) throw new Error("listener 还没有建立");
			return handler;
		},
		async dispatch(event: LiveEvent) {
			await handler?.(event);
			await settle();
		},
		async bootstrap() {
			await session.bootstrap();
			await settle();
		},
		setRoomInfo(next: () => Promise<Record<string, unknown> | undefined>) {
			roomInfo = next;
		},
		setDisposed(value: boolean) {
			disposed = value;
		},
		setReportedLive(value: boolean) {
			session.noteLiveStatus(value);
		},
		get reportedLive() {
			return reportedLiveOf(session);
		},
	};
}

export function liveDetails(totalViewers?: number): LiveDetails {
	return {
		title: "标题",
		cover: { url: "https://i0.hdslb.com/bfs/live/cover.jpg", ref: `${"c".repeat(64)}.webp` },
		category: "分区",
		url: "https://live.bilibili.com/1",
		description: "简介",
		...(totalViewers === undefined ? {} : { totalViewers }),
	};
}

export function makeRecordedFailure(externalId: string, roomId: string, reason: string) {
	const text = PROBLEM_TEXTS.liveMonitorStopped;
	return {
		asymmetricMatch(actual: unknown) {
			const failure = actual as {
				externalId?: string;
				code?: string;
				message?: () => string;
				recoveryMessage?: () => string;
			};
			return (
				failure.externalId === externalId &&
				failure.code === "live_monitor_stopped" &&
				failure.message?.() === text.text(roomId, reason) &&
				failure.recoveryMessage?.() === text.recovery(roomId)
			);
		},
		toString: () => "RecordedStoppedFailure",
		getExpectedType: () => "object",
		toAsymmetricMatcher: () => "RecordedStoppedFailure",
	};
}
