import { t as serverText } from "../i18n/index.js";
/**
 * 系统页「存储占用」的服务端(㉙d,ADR-0027 决策 10 / 17;路由见 `routes/system.ts`):一张用量表、
 * 四类的整类清空、手动清一次图库。**清空不可恢复**,所以每一类删什么、经哪条写队都在这里写死。
 *
 * 量大小的成本:全树 `lstat`(不跟符号链接),图库逐张 `stat` 加每家引用方 `listRefs` 一次、旧代量全树。
 * 数量级:统计与对话是几百个小文件,历史日文件一年约 365 个、重推原件重度用户 90 天可到数万个,图库约万张,
 * 旧代可到几 GB、几十万个文件(秒到几十秒)。各类**并行**量,**不缓存**(只有打开「存储占用」才调)。
 *
 * 图的分类只看引用它的人({@link classifyImage}):用量与清理共用同一个函数,一张图算进某一类的条件是
 * 引用它的全都属于那一类。
 */

import type {
	ClearableStorageCategory,
	GenerationInfo,
	ImageSweepResponse,
	StorageCategory,
	StorageClearResponse,
	StorageUsageResponse,
	StorageUsageRow,
} from "@bilibili-notify/contract";
import type { Logger } from "@bilibili-notify/internal";
import { CONVERSATIONS_DIR, type ConversationStore } from "../ai/conversation-store.js";
import { FOLLOWERS_DIR } from "../followers/store.js";
import { sweepHistoryRetention } from "../history/retention.js";
import { type HistoryStore, listDayFiles } from "../history/store.js";
import { IMAGE_REFERRERS } from "../images/image-referrers.js";
import type { ImageStore, ImageUsage } from "../images/image-store.js";
import type { StatsRecorderHandle } from "../stats/recorder.js";
import { STATS_LIVE_DIR, STATS_POSTS_DIR, STATS_RECORDING_DIR } from "../stats/store.js";
import { measureTree } from "./generation-usage.js";
import type { ProfileRefreshHandle } from "./profile-refresh.js";
import { type DataRootKey, dataPath, hostPath } from "./roots.js";

/** 能整类清空的四类,也是 `DELETE /api/system/storage/:category` 认的全部键(别的一律 400)。 */
export const CLEARABLE_STORAGE_CATEGORIES = [
	"stats",
	"historyText",
	"historyImages",
	"ai",
] as const satisfies readonly ClearableStorageCategory[];

export function isClearableCategory(value: string): value is ClearableStorageCategory {
	return (CLEARABLE_STORAGE_CATEGORIES as readonly string[]).includes(value);
}

/** 图库里一张图可能属于的三个类(历史图的字节之外,「历史图」那一行还要加上重推原件文件)。 */
export type ImageClass = Extract<StorageCategory, "historyImages" | "ai" | "otherImages">;

const HISTORY_HOLDERS: ReadonlySet<string> = new Set([
	IMAGE_REFERRERS.history,
	IMAGE_REFERRERS.repush,
]);

/**
 * 一张图属于哪一类:引用它的**全都**属于「推送历史 / 重推原件」→ 历史图;只有「女仆对话」→ 女仆 AI;其余
 * (没人引用、被订阅资料 / 作品 / 拓展直播 / 来源声明的图 / 账号头像引用、同时被两类引用)→ 其它图片。纯函数,引用方名字只从
 * {@link IMAGE_REFERRERS} 取。
 */
export function classifyImage(holders: readonly string[]): ImageClass {
	if (holders.length === 0) return "otherImages";
	if (holders.every((name) => HISTORY_HOLDERS.has(name))) return "historyImages";
	if (holders.every((name) => name === IMAGE_REFERRERS.chat)) return "ai";
	return "otherImages";
}

/** 三个图类各占图库多少字节。三者之和就是 `images/` 里全部图的字节数。 */
export function sumImageBytes(images: readonly ImageUsage[]): Record<ImageClass, number> {
	const sums: Record<ImageClass, number> = { historyImages: 0, ai: 0, otherImages: 0 };
	for (const image of images) sums[classifyImage(image.holders)] += image.sizeBytes;
	return sums;
}

/**
 * 数据根目录表(`DATA_ROOT_LAYOUT`)里每个键归哪一类、或为什么不进表。**守卫**:往数据根加了一级目录而忘了想它
 * 归哪一类,这里的 `satisfies` 编译不过、`storage-usage.test.ts` 也会红。
 */
export const DATA_ROOT_STORAGE_COVERAGE = {
	config: {
		get excluded() {
			return serverText("service.runtime.storage-usage.text.1");
		},
	},
	secrets: {
		get excluded() {
			return serverText("service.runtime.storage-usage.text.2");
		},
	},
	runtime: {
		get excluded() {
			return serverText("service.runtime.storage-usage.text.3");
		},
	},
	history: ["historyText", "historyImages"],
	images: ["historyImages", "ai", "otherImages"],
	stats: "stats",
	uptime: {
		get excluded() {
			return serverText("service.runtime.storage-usage.text.4");
		},
	},
	ai: "ai",
	skins: {
		get excluded() {
			return serverText("service.runtime.storage-usage.text.5");
		},
	},
	library: {
		get excluded() {
			return serverText("service.runtime.storage-usage.text.6");
		},
	},
	"maid-skills": {
		get excluded() {
			return serverText("service.runtime.storage-usage.text.7");
		},
	},
	extensions: {
		get excluded() {
			return serverText("service.runtime.storage-usage.text.8");
		},
	},
} as const satisfies Record<
	DataRootKey,
	StorageCategory | readonly StorageCategory[] | { excluded: string }
>;

export interface StorageUsageOptions {
	dataRoot: string;
	hostRoot: string;
	imageStore: Pick<ImageStore, "usage" | "sweep">;
	/** 旧代列表(`listGenerationUsage` 绑好参数)。 */
	listGenerations: () => Promise<GenerationInfo[]>;
}

export interface StorageUsage {
	/** 用量表。 */
	list(): Promise<StorageUsageResponse>;
	/** 整类清空;回实际腾出的字节数。 */
	clear(category: ClearableStorageCategory): Promise<StorageClearResponse>;
	/** 手动清一次图库(不绕宽限期)。 */
	sweepImages(): Promise<ImageSweepResponse>;
}

/** 清理需要的全部写口。 */
export interface StorageClearOptions extends StorageUsageOptions {
	/** 统计记录器(整类清空经它各键的写队)。 */
	statsRecorder: Pick<StatsRecorderHandle, "clear">;
	/** 资料刷新(开机之后才有,所以是现取);清完让它手里的快照不再用旧数。 */
	profileRefresh: () => Pick<ProfileRefreshHandle, "reset"> | null;
	/** 作废统计总览的缓存。 */
	invalidateStatsOverview: () => void;
	historyStore: Pick<HistoryStore, "clear">;
	conversationStore: Pick<ConversationStore, "clear">;
	logger: Logger;
	now: () => Date;
	/** 关停要等的后台活:每一趟清理 / 清扫登记进去。 */
	track: (task: Promise<unknown>) => void;
}

export function createStorageUsage(opts: StorageClearOptions): StorageUsage {
	const sizeOf = async (path: string): Promise<number> => (await measureTree(path)).size;

	async function statsBytes(): Promise<number> {
		const dirs = [
			dataPath(opts.dataRoot, ...STATS_POSTS_DIR),
			dataPath(opts.dataRoot, ...STATS_LIVE_DIR),
			dataPath(opts.dataRoot, ...STATS_RECORDING_DIR),
			dataPath(opts.dataRoot, ...FOLLOWERS_DIR),
		];
		return sum(await Promise.all(dirs.map(sizeOf)));
	}
	/** 历史日文件(`history/<日>.jsonl`)的字节数;水位线与 `repush/` 不算。 */
	async function historyTextBytes(): Promise<number> {
		const files = await listDayFiles(opts.dataRoot);
		return sum(
			await Promise.all(files.map((name) => sizeOf(dataPath(opts.dataRoot, "history", name)))),
		);
	}
	const repushBytes = () => sizeOf(dataPath(opts.dataRoot, "history", "repush"));
	const conversationsBytes = () => sizeOf(dataPath(opts.dataRoot, ...CONVERSATIONS_DIR));
	const logsBytes = () => sizeOf(hostPath(opts.hostRoot, "logs"));

	return {
		async list() {
			const [stats, text, repush, conversations, logs, images, generations] = await Promise.all([
				statsBytes(),
				historyTextBytes(),
				repushBytes(),
				conversationsBytes(),
				logsBytes(),
				opts.imageStore.usage(),
				opts.listGenerations(),
			]);
			const image = sumImageBytes(images);
			const deletable = generations.filter((g) => g.deletable);
			const rows: StorageUsageRow[] = [
				{ category: "stats", sizeBytes: stats, clearable: true },
				{ category: "historyText", sizeBytes: text, clearable: true },
				{ category: "historyImages", sizeBytes: image.historyImages + repush, clearable: true },
				{ category: "ai", sizeBytes: image.ai + conversations, clearable: true },
				{
					category: "generations",
					sizeBytes: sum(deletable.map((g) => g.reclaimableBytes)),
					clearable: false,
					deletableGenerations: deletable.length,
				},
				{ category: "otherImages", sizeBytes: image.otherImages, clearable: false },
				{ category: "logs", sizeBytes: logs, clearable: false },
			];
			return { rows };
		},
		async clear(category) {
			// 登记进 track:请求断了,关停也会等这一趟删完再让各写道关门。
			const task = clearOnDisk(category);
			opts.track(task);
			return { freedBytes: await task };
		},
		async sweepImages() {
			const task = opts.imageStore.sweep({ now: opts.now() });
			opts.track(task);
			const report = await task;
			return {
				removedCount: report.removed.length,
				removedBytes: report.removedBytes,
				referenced: report.referenced,
				inGrace: report.inGrace,
			};
		},
	};

	/**
	 * 清完文字 / 对话之后接一次图库清扫:它们引用的图不再有人引用。清扫只删没人引用**且存进来超过 24 小时**的图,
	 * 所以腾出的可能比用量表上那一行少。清扫失败(某一家引用方列不出名单)只记 warn、算 0 —— 前面已经清掉的是真的。
	 * 这一次清扫会顺带收走别的「没人引用且过了宽限期」的图(其它图片里的垃圾),那本来就是该收的。
	 */
	async function sweepAfterClear(): Promise<number> {
		try {
			return (await opts.imageStore.sweep({ now: opts.now() })).removedBytes;
		} catch (err) {
			opts.logger.warn(`[storage] 清理后的图库清扫失败,图留给下一轮: ${String(err)}`);
			return 0;
		}
	}

	/** 实际腾出的字节:文件按清理前后各量一次的差(不会为负),图按这一次清扫真删掉的。 */
	async function clearOnDisk(category: ClearableStorageCategory): Promise<number> {
		switch (category) {
			case "stats": {
				const before = await statsBytes();
				// 删文件经记录器各键的写队;最后通知两处缓存。
				await opts.statsRecorder.clear();
				await opts.profileRefresh()?.reset();
				opts.invalidateStatsOverview();
				return Math.max(0, before - (await statsBytes()));
			}
			case "historyText": {
				// 日文件与重推原件(`clear` 同一趟里一起删)两份都量前后差,再加清扫真删的图。
				const [textBefore, repushBefore] = [await historyTextBytes(), await repushBytes()];
				await opts.historyStore.clear();
				const images = await sweepAfterClear();
				const freed =
					Math.max(0, textBefore - (await historyTextBytes())) +
					Math.max(0, repushBefore - (await repushBytes()));
				return freed + images;
			}
			case "historyImages": {
				const before = await repushBytes();
				// 复用保留清理,保留天数当 0:水位线推到昨天、删掉到昨天为止的重推原件;今天的不清。
				await sweepHistoryRetention({
					dataRoot: opts.dataRoot,
					retentionDays: 0,
					now: opts.now(),
					logger: opts.logger,
				});
				const images = await sweepAfterClear();
				return Math.max(0, before - (await repushBytes())) + images;
			}
			case "ai": {
				const before = await conversationsBytes();
				await opts.conversationStore.clear();
				const images = await sweepAfterClear();
				return Math.max(0, before - (await conversationsBytes())) + images;
			}
		}
	}
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
