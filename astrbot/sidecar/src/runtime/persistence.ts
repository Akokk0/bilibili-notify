import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	DEFAULT_FEATURE_FLAGS,
	FEATURE_KEYS,
	type FeatureFlags,
	makeEmptySubscription,
	type Subscription,
	SubscriptionSchema,
} from "@bilibili-notify/internal";
import { ASTRBOT_TARGET_ID } from "./callback-sink.js";

export interface StoredSubscriptionInput {
	readonly id?: string;
	readonly uid: string;
	readonly name?: string;
	readonly enabled?: boolean;
	readonly dynamic?: boolean;
	readonly live?: boolean;
}

export interface SubscriptionStoreSnapshot {
	readonly count: number;
	readonly path: string;
}

export class JsonSubscriptionPersistence {
	constructor(private readonly filePath: string) {}

	async load(): Promise<Subscription[]> {
		let text: string;
		try {
			text = await readFile(this.filePath, "utf8");
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
		const parsed: unknown = JSON.parse(text);
		const result = SubscriptionSchema.array().safeParse(parsed);
		if (!result.success) {
			throw new Error(`Invalid AstrBot sidecar subscriptions: ${result.error.message}`);
		}
		return result.data.map(normalizeAstrBotSubscription);
	}

	async save(subscriptions: readonly Subscription[]): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		const tmpPath = `${this.filePath}.${process.pid}.tmp`;
		await writeFile(tmpPath, `${JSON.stringify(subscriptions, null, 2)}\n`, "utf8");
		await rename(tmpPath, this.filePath);
	}

	async clear(): Promise<void> {
		await rm(this.filePath, { force: true });
	}

	snapshot(count: number): SubscriptionStoreSnapshot {
		return { count, path: this.filePath };
	}
}

export interface CreateAstrBotSubscriptionOptions {
	readonly defaultTargetIds?: readonly string[];
	readonly defaultFeatures?: FeatureFlags;
}

export function createAstrBotSubscription(
	input: StoredSubscriptionInput,
	options: CreateAstrBotSubscriptionOptions = {},
): Subscription {
	if (!/^\d+$/.test(input.uid)) {
		throw new Error(`Invalid uid: ${input.uid}`);
	}
	const sub = makeEmptySubscription({ id: input.id ?? randomUUID(), uid: input.uid });
	const features = resolveCreateFeatureFlags(
		input,
		options.defaultFeatures ?? DEFAULT_FEATURE_FLAGS,
	);
	return normalizeAstrBotSubscription({
		...sub,
		name: input.name,
		enabled: input.enabled ?? true,
		routing: buildAstrBotRouting({
			features,
			defaultTargetIds: options.defaultTargetIds ?? [],
		}),
		overrides: buildExplicitFeatureOverrides(input),
	});
}

export function normalizeAstrBotSubscription(subscription: Subscription): Subscription {
	return SubscriptionSchema.parse(subscription);
}

export function resolveAstrBotDefaultTargetIds(
	targets: readonly { readonly id: string; readonly enabled: boolean }[],
): string[] {
	return targets
		.filter((target) => target.enabled && target.id !== ASTRBOT_TARGET_ID)
		.map((target) => target.id);
}

function resolveCreateFeatureFlags(
	input: StoredSubscriptionInput,
	defaults: FeatureFlags,
): FeatureFlags {
	const features = { ...defaults };
	if (input.dynamic !== undefined) features.dynamic = input.dynamic;
	if (input.live !== undefined) {
		features.live = input.live;
		features.liveEnd = input.live;
	}
	return features;
}

function buildExplicitFeatureOverrides(input: StoredSubscriptionInput): Subscription["overrides"] {
	const features: Partial<FeatureFlags> = {};
	if (input.dynamic !== undefined) features.dynamic = input.dynamic;
	if (input.live !== undefined) {
		features.live = input.live;
		features.liveEnd = input.live;
	}
	return Object.keys(features).length > 0 ? { features } : {};
}

function buildAstrBotRouting(options: {
	features: FeatureFlags;
	defaultTargetIds: readonly string[];
}): Subscription["routing"] {
	const targetIds = [...new Set(options.defaultTargetIds)];
	const routing = Object.fromEntries(
		FEATURE_KEYS.map((feature) => [feature, []]),
	) as unknown as Subscription["routing"];
	for (const feature of FEATURE_KEYS) {
		if (options.features[feature]) routing[feature] = targetIds;
	}
	return routing;
}

function isNotFound(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
