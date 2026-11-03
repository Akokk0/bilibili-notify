import { BILIBILI_SOURCE_KEY } from "@bilibili-notify/contract";
import { CreatorProfileSchema, type Json } from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";
import { integrationStateFile, writeIntegrationStateFile } from "../integration-store/files.js";
import {
	createKeyValueStores,
	parseStoredEntries,
	STATE_LIMITS,
	serializeEntries,
} from "../integration-store/key-value-store.js";
import { dataPath } from "../runtime/roots.js";
import { SUBSCRIPTION_STATE_FILE } from "../runtime/subscription-state-store.js";
import { isPlainObject, readJsonFile, rewriteJsonFile } from "./files.js";
import type { BiliSubscriptionKey } from "./subscriptions.js";

/** 报告里的相对路径也从运行态仓与集成状态模块的活路径派生。 */
const SUBSCRIPTION_STATE_PATH = SUBSCRIPTION_STATE_FILE.join("/");
const BILI_STATE_PATH = integrationStateFile(BILIBILI_SOURCE_KEY, [BILIBILI_SOURCE_KEY]).join("/");

const POSITIVE_INTEGER_STRING = /^[1-9]\d*$/;

export interface SubscriptionStateMigrationSummary {
	profilesConverted: number;
	droppedProfiles: number;
	droppedRecords: number;
	roomsWritten: number;
	invalidRooms: number;
	unmappedRooms: number;
	duplicateUids: number;
}

export interface SubscriptionStateMigrationResult {
	rewritten: string[];
	skipped: { path: string; reason: string }[];
	summary: SubscriptionStateMigrationSummary;
}

function roomIdOf(value: unknown): string | undefined {
	if (typeof value === "string" && POSITIVE_INTEGER_STRING.test(value)) return value;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
	return undefined;
}

function profileOf(value: unknown) {
	if (!isPlainObject(value)) return undefined;
	const parsed = CreatorProfileSchema.safeParse({
		name: value.name,
		...(typeof value.avatar === "string" ? { avatar: value.avatar } : {}),
		...(typeof value.sign === "string" && value.sign !== "" ? { bio: value.sign } : {}),
		...(typeof value.fans === "number" ? { followers: value.fans } : {}),
		...(typeof value.fanClubName === "string" ? { fanClubName: value.fanClubName } : {}),
		...(typeof value.lastRefreshedAt === "string" ? { refreshedAt: value.lastRefreshedAt } : {}),
	});
	return parsed.success ? parsed.data : undefined;
}

export async function migrateSubscriptionState(opts: {
	dataRoot: string;
	biliSubscriptions: readonly BiliSubscriptionKey[];
}): Promise<SubscriptionStateMigrationResult> {
	const runtimeFile = dataPath(opts.dataRoot, ...SUBSCRIPTION_STATE_FILE);
	const summary: SubscriptionStateMigrationSummary = {
		profilesConverted: 0,
		droppedProfiles: 0,
		droppedRecords: 0,
		roomsWritten: 0,
		invalidRooms: 0,
		unmappedRooms: 0,
		duplicateUids: 0,
	};
	const skipped: SubscriptionStateMigrationResult["skipped"] = [];
	const rewritten: string[] = [];

	const read = await readJsonFile(runtimeFile);
	if (read.kind !== "ok") {
		if (read.kind === "unreadable") {
			skipped.push({
				path: SUBSCRIPTION_STATE_PATH,
				reason: t("migration.subscriptionState.unreadable"),
			});
		}
		return { rewritten, skipped, summary };
	}
	if (!isPlainObject(read.value)) {
		skipped.push({
			path: SUBSCRIPTION_STATE_PATH,
			reason: t("migration.subscriptionState.unreadable"),
		});
		return { rewritten, skipped, summary };
	}

	const records = read.value;
	const next: Record<string, { cachedProfile: NonNullable<ReturnType<typeof profileOf>> }> = {};
	for (const [id, record] of Object.entries(records)) {
		const profile = isPlainObject(record) ? profileOf(record.cachedProfile) : undefined;
		if (profile) {
			next[id] = { cachedProfile: profile };
			summary.profilesConverted += 1;
		} else {
			summary.droppedRecords += 1;
			if (isPlainObject(record) && isPlainObject(record.cachedProfile)) {
				summary.droppedProfiles += 1;
			}
		}
	}
	if (JSON.stringify(next) !== JSON.stringify(records)) {
		await rewriteJsonFile(runtimeFile, next);
		rewritten.push(runtimeFile);
	}
	if (summary.droppedProfiles > 0) {
		skipped.push({
			path: SUBSCRIPTION_STATE_PATH,
			reason: t("migration.subscriptionState.droppedProfiles", {
				count: summary.droppedProfiles,
			}),
		});
	}

	const biliIds = new Set(opts.biliSubscriptions.map((row) => row.id));
	for (const [id, record] of Object.entries(records)) {
		if (isPlainObject(record) && record.roomId !== undefined && !biliIds.has(id)) {
			summary.unmappedRooms += 1;
		}
	}

	const rooms = new Map<string, string>();
	const writtenUids = new Set<string>();
	for (const subscription of opts.biliSubscriptions) {
		const record = records[subscription.id];
		if (!isPlainObject(record) || record.roomId === undefined) continue;
		const roomId = roomIdOf(record.roomId);
		if (roomId === undefined) {
			summary.invalidRooms += 1;
			continue;
		}
		if (writtenUids.has(subscription.uid)) {
			summary.duplicateUids += 1;
			continue;
		}
		rooms.set(`room:${subscription.uid}`, roomId);
		writtenUids.add(subscription.uid);
	}

	if (rooms.size > 0) {
		const biliStateFile = dataPath(
			opts.dataRoot,
			...integrationStateFile(BILIBILI_SOURCE_KEY, [BILIBILI_SOURCE_KEY]),
		);
		const readBiliState = await readJsonFile(biliStateFile);
		const entries =
			readBiliState.kind === "missing"
				? new Map<string, Json>()
				: readBiliState.kind === "ok"
					? parseStoredEntries(readBiliState.value)
					: undefined;
		if (entries === undefined) {
			skipped.push({
				path: BILI_STATE_PATH,
				reason: t("migration.subscriptionState.biliStateUnreadable"),
			});
		} else {
			const stores = createKeyValueStores({
				initial: entries,
				limits: STATE_LIMITS,
				persist: (nextEntries) =>
					writeIntegrationStateFile(opts.dataRoot, BILIBILI_SOURCE_KEY, nextEntries, [
						BILIBILI_SOURCE_KEY,
					]),
			});
			const merged = new Map(entries);
			for (const [key, value] of rooms) merged.set(key, value);
			const result = await stores.commit(
				() => [],
				[...rooms].map(([key, value]) => ({ kind: "set" as const, key, value })),
			);
			if (!result.ok) {
				skipped.push({
					path: BILI_STATE_PATH,
					reason: t("migration.subscriptionState.biliStateUnwritable", {
						reason: result.message,
					}),
				});
			} else {
				if (serializeEntries(entries) !== serializeEntries(merged)) {
					rewritten.push(biliStateFile);
				}
				summary.roomsWritten = rooms.size;
			}
		}
	}

	if (summary.invalidRooms > 0 || summary.unmappedRooms > 0 || summary.duplicateUids > 0) {
		skipped.push({
			path: BILI_STATE_PATH,
			reason: t("migration.subscriptionState.roomsDropped", {
				invalid: summary.invalidRooms,
				unmapped: summary.unmappedRooms,
				duplicates: summary.duplicateUids,
			}),
		});
	}

	return { rewritten, skipped, summary };
}
