import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GenerationInfo } from "@bilibili-notify/contract";
import { vi } from "vite-plus/test";
import { type ConversationStore, createConversationStore } from "../../ai/conversation-store.js";
import { createFollowersStore, type FollowersStore } from "../../followers/store.js";
import { createRepushStore, listRepushImageRefs } from "../../history/repush-store.js";
import { listHistoryImageRefs } from "../../history/retention.js";
import { createHistoryStore, type HistoryStore } from "../../history/store.js";
import { IMAGE_REFERRERS } from "../../images/image-referrers.js";
import { createImageStore, type ImageStore, type ImageWriter } from "../../images/image-store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { dataPath } from "../../runtime/roots.js";
import {
	createStorageUsage,
	type StorageClearOptions,
	type StorageUsage,
} from "../../runtime/storage-usage.js";
import {
	createSubscriptionStateStore,
	type SubscriptionStateStore,
} from "../../runtime/subscription-state-store.js";
import { createStatsRecorderCore } from "../../stats/recorder.js";
import { createStatsStore, type StatsStore } from "../../stats/store.js";
import { distinctPng } from "./chat-images.js";
import { silentLogger } from "./silent-logger.js";

/** 测试里的「此刻」:所有清扫、保留水位都按它算,不碰真时钟。 */
export const NOW = Date.parse("2026-10-06T12:00:00.000Z");
export const DAY = 24 * 60 * 60 * 1000;
/** 比宽限期老(2 天前)与还在宽限期里(1 小时前)的修改时间。 */
export const OLD_MTIME = NOW - 2 * DAY;
export const FRESH_MTIME = NOW - 60 * 60 * 1000;

/**
 * 一整个「数据根 + 宿主根」的真装配(都在自己建的临时目录里):六个真仓、一个真图库、四家真引用方(历史、重推原件、
 * 女仆对话、订阅资料),与 `createStorageUsage` 要的全部依赖。测试往盘上摆东西、调用口、再量盘。
 * 粉丝轮询与总览缓存是替身(它们的作用只是被通知)。
 */
export interface StorageWorld {
	host: string;
	dataRoot: string;
	imageStore: ImageStore;
	/** 各家引用方存图的口。 */
	writers: { history: ImageWriter; repush: ImageWriter; chat: ImageWriter; profiles: ImageWriter };
	/** 订阅资料这一家当前交出的引用(测试直接改它)。 */
	profileRefs: string[];
	statsStore: StatsStore;
	fansStore: FollowersStore;
	historyStore: HistoryStore;
	conversationStore: ConversationStore;
	subscriptionStateStore: SubscriptionStateStore;
	recorder: ReturnType<typeof createStatsRecorderCore>;
	pollerReset: ReturnType<typeof vi.fn>;
	invalidate: ReturnType<typeof vi.fn>;
	/** 假的旧代列表(测试直接改它)。 */
	generations: GenerationInfo[];
	storage: StorageUsage;
	/** 造 `storage` 用的那份依赖:想换掉其中一两样(比如换成真的粉丝轮询)的测试展开它再改。 */
	options: StorageClearOptions;
	/** 往数据根(或宿主根)下写一个 `size` 字节的文件;回绝对路径。 */
	file(root: "data" | "host", rel: string, size: number): Promise<string>;
	/** 往数据根(或宿主根)下写一份文本;回它的字节数。 */
	write(root: "data" | "host", rel: string, body: string): Promise<number>;
	/** 登记进 `track` 的活(清理与清扫)。 */
	tracked: Promise<unknown>[];
	/** 往图库存一张第 `n` 号图(大小固定 = PNG + 1 字节),并把修改时间改成 `mtime`;回 `{ ref, size }`。 */
	image(writer: ImageWriter, n: number, mtime?: number): Promise<{ ref: string; size: number }>;
	/** 目录里所有文件大小之和(递归;目录不在是 0),测试自己的量法,与被测实现无关。 */
	bytesIn(path: string): Promise<number>;
	/** 目录下的文件名(递归,相对路径、排序);目录不在是空。 */
	namesIn(path: string): Promise<string[]>;
	dispose(): Promise<void>;
}

export async function makeStorageWorld(): Promise<StorageWorld> {
	const host = await mkdtemp(join(tmpdir(), "bn-storage-"));
	const dataRoot = join(host, "data");
	await mkdir(dataRoot, { recursive: true });
	const bus = createNodeMessageBus();
	const logger = silentLogger;

	const conversationStore = createConversationStore({ dataRoot, logger });
	const imageStore = createImageStore({ dir: dataPath(dataRoot, "images") });
	const profileRefs: string[] = [];
	const history = imageStore.register({
		name: IMAGE_REFERRERS.history,
		listRefs: () => listHistoryImageRefs(dataRoot),
	});
	const repush = imageStore.register({
		name: IMAGE_REFERRERS.repush,
		listRefs: () => listRepushImageRefs(dataRoot),
	});
	// register 回的是同一个共用的 writer,四家用哪一个存都一样;登记只为让 holders 里有各家的名字。
	const chat = imageStore.register({
		name: IMAGE_REFERRERS.chat,
		listRefs: () => conversationStore.listImageRefs(),
	});
	const profiles = imageStore.register({
		name: IMAGE_REFERRERS.profiles,
		listRefs: async () => profileRefs,
	});

	const repushStore = createRepushStore({ dataRoot, logger, images: repush, imageStore });
	const historyStore = createHistoryStore({
		dataRoot,
		bus,
		logger,
		images: history,
		repush: repushStore,
	});
	const statsStore = createStatsStore({ dataRoot, logger });
	const fansStore = createFollowersStore({ dataRoot, logger });
	const subscriptionStateStore = createSubscriptionStateStore({ dataRoot, logger });
	await subscriptionStateStore.load();
	const recorder = createStatsRecorderCore({
		store: statsStore,
		followers: fansStore,
		logger,
		now: () => new Date(NOW),
		isEnabled: () => true,
	});

	const pollerReset = vi.fn(async () => {});
	const invalidate = vi.fn();
	const generations: GenerationInfo[] = [];
	const tracked: Promise<unknown>[] = [];

	const options: StorageClearOptions = {
		dataRoot,
		hostRoot: host,
		imageStore,
		listGenerations: async () => generations,
		statsRecorder: recorder,
		profileRefresh: () => ({ reset: pollerReset }),
		invalidateStatsOverview: invalidate,
		historyStore,
		conversationStore,
		logger,
		now: () => new Date(NOW),
		track: (task) => {
			tracked.push(task);
		},
	};
	const storage = createStorageUsage(options);

	const world: StorageWorld = {
		host,
		dataRoot,
		imageStore,
		writers: { history, repush, chat, profiles },
		profileRefs,
		statsStore,
		fansStore,
		historyStore,
		conversationStore,
		subscriptionStateStore,
		recorder,
		pollerReset,
		invalidate,
		generations,
		storage,
		options,
		async file(root, rel, size) {
			const path = join(root === "data" ? dataRoot : host, rel);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, Buffer.alloc(size, 0x61));
			return path;
		},
		async write(root, rel, body) {
			const path = join(root === "data" ? dataRoot : host, rel);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, body);
			return Buffer.byteLength(body);
		},
		tracked,
		async image(writer, n, mtime = OLD_MTIME) {
			const bytes = distinctPng(n);
			const stored = await writer.put(bytes);
			if (!stored.ok) throw new Error(`夹具图存不进图库:${stored.message}`);
			await utimes(join(dataRoot, "images", stored.ref), new Date(mtime), new Date(mtime));
			return { ref: stored.ref, size: bytes.byteLength };
		},
		bytesIn,
		namesIn,
		async dispose() {
			await Promise.allSettled(tracked);
			await rm(host, { recursive: true, force: true });
		},
	};
	return world;
}

async function bytesIn(path: string): Promise<number> {
	let total = 0;
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const full = join(path, entry.name);
		total += entry.isDirectory() ? await bytesIn(full) : (await stat(full)).size;
	}
	return total;
}

async function namesIn(path: string, prefix = ""): Promise<string[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...(await namesIn(join(path, entry.name), rel)));
		else out.push(rel);
	}
	return out.sort();
}
