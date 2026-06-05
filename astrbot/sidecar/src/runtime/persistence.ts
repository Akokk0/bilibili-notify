import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	FEATURE_KEYS,
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

export function createAstrBotSubscription(input: StoredSubscriptionInput): Subscription {
	if (!/^\d+$/.test(input.uid)) {
		throw new Error(`Invalid uid: ${input.uid}`);
	}
	const sub = makeEmptySubscription({ id: input.id ?? randomUUID(), uid: input.uid });
	return normalizeAstrBotSubscription({
		...sub,
		name: input.name,
		enabled: input.enabled ?? true,
		routing: buildAstrBotRouting({
			dynamic: input.dynamic ?? true,
			live: input.live ?? true,
		}),
		overrides: {
			features: {
				dynamic: input.dynamic ?? true,
				live: input.live ?? true,
			},
		},
	});
}

export function normalizeAstrBotSubscription(subscription: Subscription): Subscription {
	const dynamicEnabled = subscription.overrides.features?.dynamic ?? true;
	const liveEnabled = subscription.overrides.features?.live ?? true;
	return SubscriptionSchema.parse({
		...subscription,
		routing: {
			...subscription.routing,
			...buildAstrBotRouting({ dynamic: dynamicEnabled, live: liveEnabled }),
		},
	});
}

function buildAstrBotRouting(options: {
	dynamic: boolean;
	live: boolean;
}): Subscription["routing"] {
	const routing = Object.fromEntries(
		FEATURE_KEYS.map((feature) => [feature, []]),
	) as unknown as Subscription["routing"];
	if (options.dynamic) routing.dynamic = [ASTRBOT_TARGET_ID];
	if (options.live) {
		routing.live = [ASTRBOT_TARGET_ID];
		routing.liveEnd = [ASTRBOT_TARGET_ID];
	}
	return routing;
}

function isNotFound(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
