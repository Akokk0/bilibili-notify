import {
	ok,
	type Result,
	type SourceContext,
	type SourceSubscriptionView,
} from "@bilibili-notify/internal";
import { vi } from "vite-plus/test";
import { memoryKeyValueStores } from "../../../../../__tests__/support/memory-key-value-store.js";
import type { LiveEvent } from "../../../protocol/events.js";
import { createRoomIds } from "../../../room-ids.js";
import type { LiveProblems } from "../../room-context.js";
import { RoomSessionCoordinator } from "../../room-session-coordinator.js";
import { makeLiveProblems } from "./live-problems.js";

type EventHandler = (event: LiveEvent) => void | Promise<void>;

export function makeRoomSessionCoordinatorHarness(
	options: {
		listener?: (roomId: string, handler: EventHandler) => Promise<boolean>;
		roomInfo?: (roomId: string) => Promise<Record<string, unknown> | undefined>;
		problems?: LiveProblems;
		setTimeout?: (fn: () => void, ms: number) => { dispose(): void };
	} = {},
) {
	const activeHandlers = new Map<string, EventHandler>();
	const reports: Array<{ externalId: string; report: unknown }> = [];
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
		setTimeout:
			options.setTimeout ??
			((fn: () => void, ms: number) => {
				const timer = globalThis.setTimeout(fn, ms);
				return { dispose: () => globalThis.clearTimeout(timer) };
			}),
		onDispose() {},
		signal: new AbortController().signal,
		track() {},
	};
	let subscriptions: SourceSubscriptionView[] = [];
	const api = {
		fetchUserInfo: async (
			externalId: string,
		): Promise<Result<{ data: { live_room?: { roomid?: number } } }>> =>
			ok({
				data: { live_room: { roomid: Number.parseInt(externalId.slice(1), 10) * 100 } },
			}),
		fetchUpDetails: async () => ({ data: { medal_name: "牌" } }),
	};
	const roomIds = createRoomIds({
		api: api as never,
		state: memoryKeyValueStores("state").store,
		subscriptions: () => subscriptions,
		setTimeout: (fn) => {
			fn();
			return { dispose() {} };
		},
		logger: liveContext.logger,
	});
	const ctx = {
		logger: liveContext.logger,
		api,
		liveContext,
		source,
		problems,
		roomIds,
		rememberFanClubName() {},
		rememberSuperchatAvatar() {},
		startLiveRoomListener,
		closeListener,
		fetchRoomInfo,
		fetchUpProfile: async () => ({ name: "U", fanClubName: "牌" }),
		isDisposed: () => false,
	};
	const manager = new RoomSessionCoordinator(ctx as never);
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
			subscriptions = externalIds.map(subscription);
			roomIds.syncSubscriptions();
			await manager.sync(subscriptions);
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
