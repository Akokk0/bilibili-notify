import {
	type CreatorProfileReport,
	type FollowersRefreshEntry,
	fail,
	type Identity,
	ok,
	type Result,
	type Subscription,
} from "@bilibili-notify/internal";
import { expect, vi } from "vite-plus/test";
import type { FollowersAt } from "../../followers/lookup.js";
import type { FollowersStore } from "../../followers/store.js";
import { createProblemTable, type ProblemTable } from "../../problems/problem-table.js";
import { createNodeMessageBus } from "../message-bus.js";
import { createProfileCacheWriter } from "../profile-cache.js";
import { type ProfileRefreshHandle, startProfileRefresh } from "../profile-refresh.js";
import type { SubRuntime } from "../sub-runtime-store.js";

interface MigratedApi {
	fetchUserCard?: (externalId: string) => Promise<unknown>;
}

interface MigratedImages {
	fetchImage?: (url: string) => Promise<Result<{ ref: string }>>;
}

interface MigratedOptions {
	bus: Parameters<typeof startProfileRefresh>[0]["bus"];
	logger: Parameters<typeof startProfileRefresh>[0]["logger"];
	configStore: Parameters<typeof startProfileRefresh>[0]["configStore"];
	subscriptionStore: Parameters<typeof startProfileRefresh>[0]["subscriptionStore"];
	subRuntimeStore: Parameters<typeof startProfileRefresh>[0]["subRuntimeStore"];
	fansStore: Parameters<typeof startProfileRefresh>[0]["fansStore"] & {
		append(key: string, sample: { sampledAt: string; followers: number }): Promise<void>;
		drop(key: string): Promise<void>;
	};
	serviceCtx: Parameters<typeof startProfileRefresh>[0]["serviceCtx"];
	isStatsEnabled(): boolean;
	api: MigratedApi;
	images: MigratedImages;
}

export type FetchProfile = (
	identity: Identity,
	signal: AbortSignal,
) => Promise<Result<CreatorProfileReport>>;

export interface ProfileRefreshHarnessOptions {
	subscriptions: Subscription[];
	sources: Record<string, FetchProfile>;
	runtime?: Record<string, SubRuntime>;
	problems?: ProblemTable;
	findEarliest?: (key: string) => Promise<FollowersAt | undefined>;
	findNearestBefore?: (key: string, beforeIso: string) => Promise<FollowersAt | undefined>;
}

export async function startProfileRefreshHarness(opts: ProfileRefreshHarnessOptions) {
	let subscriptions = [...opts.subscriptions];
	const runtime = new Map(Object.entries(opts.runtime ?? {}));
	const bus = createNodeMessageBus();
	const snapshots: FollowersRefreshEntry[][] = [];
	const changed: string[][] = [];
	const recordFollowers = vi.fn(async () => {});
	const sourceCalls: Array<{ sourceKey: string; externalId: string }> = [];
	const logger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
	const problems = opts.problems ?? createProblemTable({ logger: logger as never });
	const setTimeout = vi.fn(() => ({ dispose() {} }));
	bus.on("followers-refreshed", ({ entries }) => snapshots.push(entries));
	bus.on("subscription-profiles-changed", ({ subscriptionIds }) =>
		changed.push([...subscriptionIds]),
	);
	const cache = createProfileCacheWriter({
		bus,
		subRuntime: {
			get: (id: string) => runtime.get(id),
			patch: async (id: string, patch: SubRuntime) => {
				runtime.set(id, { ...runtime.get(id), ...patch });
			},
		} as never,
		images: { keep: vi.fn(async () => true) },
		logger: logger as never,
		coalesceMs: 0,
	});
	const registry = {
		get: (key: string) =>
			opts.sources[key] ? ({ sourceKey: key, descriptor: { label: key } } as never) : undefined,
		list: () =>
			Object.keys(opts.sources).map((sourceKey) => ({
				sourceKey,
				descriptor: { label: sourceKey },
			})) as never,
	};
	const fans: FollowersStore = {
		findEarliest: opts.findEarliest ?? vi.fn(async () => undefined),
		findNearestBefore: opts.findNearestBefore ?? vi.fn(async () => null),
	} as never;
	const handle = startProfileRefresh({
		bus,
		logger: logger as never,
		configStore: { getGlobals: () => ({ profileRefreshCron: "*/10 * * * *" }) } as never,
		subscriptionStore: {
			list: () => [...subscriptions],
			findById: (id: string) => subscriptions.find((sub) => sub.id === id),
		} as never,
		subRuntimeStore: {
			get: (id: string) => runtime.get(id),
			getAll: () => Object.fromEntries(runtime),
			patch: async (id: string, patch: SubRuntime) => {
				runtime.set(id, { ...runtime.get(id), ...patch });
			},
			prune: vi.fn(async () => {}),
			load: vi.fn(async () => {}),
		} as never,
		fansStore: fans,
		recorder: { recordFollowers, drop: vi.fn() },
		profileCache: cache,
		problems,
		sources: registry,
		fetchProfile: async (identity, signal) => {
			sourceCalls.push(identity);
			const source = opts.sources[identity.sourceKey];
			return source ? source(identity, signal) : ok({ name: identity.externalId });
		},
		serviceCtx: {
			setTimeout,
			track: vi.fn(),
			signal: new AbortController().signal,
		} as never,
		isStatsEnabled: () => true,
	});
	await vi.waitFor(() => expect(setTimeout).toHaveBeenCalled());
	return {
		bus,
		cache,
		changed,
		handle,
		recordFollowers,
		logger,
		runtime,
		problems,
		snapshots,
		sourceCalls,
		setSubscriptions(next: Subscription[]) {
			subscriptions = [...next];
		},
	};
}

/**
 * 迁移期测试适配:老夹具的假 API 在这里被当成一个假来源包起来,被测的仍是新引擎公开口。
 * 生产接线不会经过这层。
 */
export function startMigratedProfileRefresh(opts: MigratedOptions): ProfileRefreshHandle {
	const subscriptions = () => opts.subscriptionStore.list();
	const reported = new Map<string, FollowersAt>();
	const problems = createProblemTable({ logger: opts.logger });
	const cache = createProfileCacheWriter({
		bus: opts.bus,
		subRuntime: opts.subRuntimeStore,
		images: { keep: async () => true },
		logger: opts.logger,
	});

	async function fetchProfile(
		identity: Identity,
		signal: AbortSignal,
	): Promise<Result<CreatorProfileReport>> {
		if (signal.aborted) return fail("unavailable", "the call was cancelled by the host");
		const raw = await opts.api.fetchUserCard?.(identity.externalId);
		const result = raw as
			| { ok: true; data?: { card?: Record<string, unknown> } }
			| { ok: false; code: string; message: string; upstreamCode?: string | number }
			| undefined;
		if (result?.ok === false) return result as never;
		const card =
			result?.data?.card ??
			(raw as { data?: { card?: Record<string, unknown> } } | undefined)?.data?.card;
		if (!card) return fail("unavailable", "the fake source returned no profile");
		let avatar: { ref: string } | undefined;
		if (typeof card.face === "string" && card.face !== "") {
			const fetched = await opts.images.fetchImage?.(card.face);
			if (fetched?.ok) avatar = fetched;
		}
		return ok({
			name: String(card.name ?? identity.externalId),
			...(avatar ? { avatar: avatar.ref as never } : {}),
			...(typeof card.sign === "string" && card.sign !== "" ? { bio: card.sign } : {}),
			...(typeof card.fans === "number" && Number.isInteger(card.fans) && card.fans >= 0
				? { followers: card.fans }
				: {}),
		});
	}

	const sources = {
		get: (sourceKey: string) =>
			sourceKey === "bilibili"
				? ({ sourceKey, descriptor: { label: "bilibili" } } as never)
				: undefined,
		list: () =>
			[
				{
					sourceKey: "bilibili",
					descriptor: { label: "bilibili" },
				},
			] as never,
	};
	const handle = startProfileRefresh({
		...opts,
		problems,
		subscriptionStore: {
			...opts.subscriptionStore,
			findById: (id) => subscriptions().find((sub) => sub.id === id),
		},
		fansStore: {
			async findEarliest(key) {
				const [stored, latest] = await Promise.all([
					opts.fansStore.findEarliest(key),
					Promise.resolve(reported.get(key)),
				]);
				if (!stored) return latest;
				if (!latest) return stored;
				return Date.parse(latest.sampledAt) < Date.parse(stored.sampledAt) ? latest : stored;
			},
			async findNearestBefore(key, beforeIso) {
				const [stored, latest] = await Promise.all([
					opts.fansStore.findNearestBefore(key, beforeIso),
					Promise.resolve(reported.get(key)),
				]);
				if (!latest || Date.parse(latest.sampledAt) > Date.parse(beforeIso)) return stored;
				if (!stored || Date.parse(latest.sampledAt) > Date.parse(stored.sampledAt)) return latest;
				return stored;
			},
		},
		profileCache: cache,
		sources,
		fetchProfile,
		recorder: {
			async recordFollowers(key, value) {
				if (!opts.isStatsEnabled()) return;
				const sample = { sampledAt: new Date().toISOString(), followers: value };
				reported.set(key, sample);
				await opts.fansStore.append(key, sample);
			},
			drop(key) {
				const task = Promise.resolve()
					.then(() => opts.fansStore.drop(key))
					.catch((err) => opts.logger.warn(`[profile-refresh-test] drop ${key}: ${String(err)}`));
				opts.serviceCtx.track(task);
			},
		},
	});
	return {
		getLastEntries: () => handle.getLastEntries(),
		pollNow: () => handle.pollNow(),
		reset() {
			reported.clear();
			return handle.reset();
		},
		dispose() {
			handle.dispose();
			problems.dispose();
			cache.dispose();
		},
	};
}
