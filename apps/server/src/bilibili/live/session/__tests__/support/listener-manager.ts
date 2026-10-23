import type { SourceContext, SourceSubscriptionView } from "@bilibili-notify/internal";
import { vi } from "vite-plus/test";
import type { LiveEvent } from "../../../protocol/events.js";
import { ListenerManager } from "../../listener-manager.js";
import type { LiveProblems } from "../../room-context.js";
import { makeLiveProblems } from "./live-problems.js";

type EventHandler = (event: LiveEvent) => void | Promise<void>;

export function makeListenerManagerHarness(
	options: {
		listener?: (roomId: string, handler: EventHandler) => Promise<boolean>;
		roomInfo?: (roomId: string) => Promise<Record<string, unknown> | undefined>;
		problems?: LiveProblems;
	} = {},
) {
	const activeHandlers = new Map<string, EventHandler>();
	const reports: Array<{ externalId: string; report: unknown }> = [];
	const roomIds = new Map<string, string>();
	const problems = (options.problems ?? makeLiveProblems()) as ReturnType<typeof makeLiveProblems>;
	const startLiveRoomListener = vi.fn(async (roomId: string, handler: EventHandler) => {
		activeHandlers.set(roomId, handler);
		return options.listener ? options.listener(roomId, handler) : true;
	});
	const fetchRoomInfo = vi.fn(
		options.roomInfo ??
			(async (roomId: string) => ({
				uid: Number.parseInt(roomId.replace(/\D/g, ""), 10) || 1,
				live_status: 0,
				live_time: "0000-00-00 00:00:00",
			})),
	);
	const closeListener = vi.fn();
	const source = {
		subscriptions: () => [],
		reportLive: (externalId: string, report: unknown) => {
			reports.push({ externalId, report });
		},
		reportLiveInteraction() {},
		fetchImage: async () => ({ ok: true as const, ref: `${"c".repeat(64)}.webp` }),
	} as unknown as SourceContext;
	const liveContext = {
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose() {},
		signal: new AbortController().signal,
		track() {},
	};
	const knownLive = new Set<string>();
	const ctx = {
		logger: liveContext.logger,
		api: {
			fetchUserInfo: async (externalId: string) => ({
				data: { live_room: { roomid: Number.parseInt(externalId.slice(1), 10) * 100 } },
			}),
			getMasterInfo: async () => ({ data: { medal_name: "牌" } }),
		},
		liveContext,
		source,
		problems,
		liveRoomIds: {
			get: (externalId: string) => roomIds.get(externalId),
			set: (externalId: string, roomId: string) => void roomIds.set(externalId, roomId),
		},
		rememberFanClubName() {},
		rememberSuperchatAvatar() {},
		startLiveRoomListener,
		closeListener,
		fetchRoomInfo,
		fetchMasterSnapshot: async () => ({ name: "U", fanClubName: "牌" }),
		isDisposed: () => false,
		hasReportedLive: (externalId: string) => knownLive.has(externalId),
		markReportedLive: (externalId: string, live: boolean) => {
			if (live) knownLive.add(externalId);
			else knownLive.delete(externalId);
		},
	};
	const manager = new ListenerManager(ctx as never);
	const subscription = (externalId: string): SourceSubscriptionView => ({
		externalId,
		features: new Set(["liveStart"]),
		monitorsLive: true,
	});
	const settle = async () => {
		for (let i = 0; i < 12; i++) await Promise.resolve();
	};
	return {
		manager,
		ctx,
		problems,
		reports,
		roomIds,
		startLiveRoomListener,
		closeListener,
		fetchRoomInfo,
		activeHandlers,
		subscription,
		settle,
		async sync(externalIds: readonly string[]) {
			await manager.sync(externalIds.map(subscription));
			await settle();
		},
	};
}

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
