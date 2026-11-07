/**
 * 旧版本数据(代)的列表、大小、删除(㉙c,ADR-0022 决策 7 与它下面 2026-10-06 的 🔗,路由见 `routes/system.ts`)。
 *
 * 能不能删由**这里**判,不靠面板藏按钮(`DELETE` 走同一套判断):
 * - 当前代永远不许删;写到一半的(`.partial`)、格式版本比我新的、`generation.json` 读不懂的也不许删;
 * - 当前代的**来源代**(来源是 `zero` 的认作第 0 代)与**上一代**(序号紧挨着的前一个),要等当前代满 30 天:
 *   从**当前代**的 `generation.json.createdAt` 算,到期时刻 = `createdAt` + 30 天(不用 `lastActiveAt`,它每次
 *   开机都刷新);当前代自己的 `createdAt` 读不到就一律当作没满、全部锁住;
 * - 其余可以删。
 *
 * 「读不懂」不许删的代价:真损坏的代在面板里删不掉,要手动清盘 —— 它也可能是更新版本的程序写的,
 * 删除不可恢复,拿不准就不删。
 *
 * 第 0 代不在 `generations/` 里,是宿主根上 `ZERO_GENERATION_LAYOUT` 列的那些键;`versions/`、`logs/`、
 * `generations/` 与 `bn.config.yaml` 永远不算、不碰。**删除不可恢复**。
 */

import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GenerationLockReason, GenerationView } from "@bilibili-notify/contract";
import { removeDirectory, type SweepReport, sweepTempFiles } from "@bilibili-notify/storage";
import {
	ZERO_GENERATION_LAYOUT,
	type ZeroGenerationKey,
	zeroPath,
} from "../migration/zero-generation.js";
import { type GenerationEntry, listGenerationEntries } from "./generations.js";
import { hostPath } from "./roots.js";

/** 来源代与上一代的保护期:从当前代的创建时刻起算。 */
const GENERATION_PROTECTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface GenerationUsageOptions {
	hostRoot: string;
	/** 正在用的那一代的序号。 */
	currentSeq: number;
	/** 这一版程序认得的数据格式版本。 */
	formatVersion: number;
	/** 注入的时钟(毫秒)。 */
	now: () => number;
}

const ZERO_KEYS = Object.keys(ZERO_GENERATION_LAYOUT) as ZeroGenerationKey[];

interface Decision {
	lockReason: GenerationLockReason | null;
	deletableAt: string | null;
}

/** 规则本身:纯函数,不碰盘。`entries` 含第 0 代(序号 0、`file` 不适用)。 */
function decide(
	entry: { seq: number; partial: boolean; zero: boolean; file: GenerationEntry["file"] },
	all: readonly { seq: number; partial: boolean }[],
	opts: GenerationUsageOptions,
	current: GenerationEntry | undefined,
): Decision {
	const lock = (lockReason: GenerationLockReason, deletableAt: string | null = null): Decision => ({
		lockReason,
		deletableAt,
	});
	if (entry.seq === opts.currentSeq && !entry.partial) return lock("current");
	if (entry.partial) return lock("partial");
	if (!entry.zero) {
		if (!entry.file) return lock("unreadable");
		if (entry.file.formatVersion > opts.formatVersion) return lock("newer-format");
	}
	// 当前代的创建时刻是算 30 天的起点,读不到就没法判:全部锁住,不猜。
	const createdAt = current?.file ? Date.parse(current.file.createdAt) : Number.NaN;
	if (!current?.file || Number.isNaN(createdAt)) return lock("current-age-unknown");
	// 来源代:当前代从哪一代迁来。今天只记来源种类,`zero` 就是第 0 代;`empty` 没有来源代。
	const isSource = current.file.source.kind === "zero" && entry.seq === 0;
	// 上一代:序号比当前代小的、最靠近它的那一代(写到一半的占着号但不算代)。
	const previousSeq = Math.max(
		-1,
		...all.filter((e) => !e.partial && e.seq < opts.currentSeq).map((e) => e.seq),
	);
	const isPrevious = entry.seq === previousSeq;
	if (!isSource && !isPrevious) return { lockReason: null, deletableAt: null };
	const until = createdAt + GENERATION_PROTECTION_MS;
	if (opts.now() >= until) return { lockReason: null, deletableAt: null };
	return lock(isSource ? "protected-source" : "protected-previous", new Date(until).toISOString());
}

/**
 * 列出所有代:第 0 代(宿主根上有 0.x 的数据才列)与 `generations/` 下的每一代,每项带能不能删与两个大小。
 *
 * 量大小是全树 `lstat`:一代可能几个 GB、几万到几十万个文件,几秒到几十秒;按目录一层层异步读、分批并发,
 * 不阻塞事件循环。**不加缓存**(只有面板打开「旧版本数据」才调,且每一代各量一次)。
 */
export async function listGenerationUsage(opts: GenerationUsageOptions): Promise<GenerationView[]> {
	const entries = await listGenerationEntries(opts.hostRoot);
	const zeroExists = (await existingZeroKeys(opts.hostRoot)).length > 0;
	const all = [...(zeroExists ? [{ seq: 0, partial: false }] : []), ...entries];
	const current = entries.find((e) => e.seq === opts.currentSeq && !e.partial);
	const out: GenerationView[] = [];

	if (zeroExists) {
		const decision = decide(
			{ seq: 0, partial: false, zero: true, file: undefined },
			all,
			opts,
			current,
		);
		const size = await measureZero(opts.hostRoot);
		out.push({
			seq: 0,
			current: false,
			partial: false,
			formatVersion: null,
			createdBy: "0.x",
			lastActiveAt: null,
			deletable: decision.lockReason === null,
			lockReason: decision.lockReason,
			deletableAt: decision.deletableAt,
			sizeBytes: size.size,
			reclaimableBytes: size.reclaimable,
		});
	}
	for (const entry of entries) {
		const decision = decide({ ...entry, zero: false }, all, opts, current);
		const size = await measureTree(entry.dir);
		out.push({
			seq: entry.seq,
			current: entry.seq === opts.currentSeq && !entry.partial,
			partial: entry.partial,
			formatVersion: entry.file?.formatVersion ?? null,
			createdBy: entry.file?.createdBy ?? null,
			lastActiveAt: entry.file?.lastActiveAt ?? null,
			deletable: decision.lockReason === null,
			lockReason: decision.lockReason,
			deletableAt: decision.deletableAt,
			sizeBytes: size.size,
			reclaimableBytes: size.reclaimable,
		});
	}
	// 同一个号上完整的在前、写到一半的在后(listGenerationEntries 已排好),第 0 代最前。
	return out;
}

export type GenerationRemoval =
	| { kind: "removed"; freedBytes: number }
	| { kind: "locked"; reason: GenerationLockReason }
	| { kind: "not_found" };

export interface RemoveGenerationOptions extends GenerationUsageOptions {
	/** 关停要等的后台活:删目录的那一趟登记进去。 */
	track: (task: Promise<unknown>) => void;
}

/**
 * 删一代(**不可恢复**)。先按列表同一套规则判:不许删就原样拒绝、什么都不动。路径只经 `hostPath` /
 * `zeroPath` 拼,不拼接调用方给的字符串(`seq` 是数字)。删用 storage 的「先改名再删」,所以删到一半
 * 被杀留下的是带 `.bn-tmp.` 标记的残骸,由开机清扫({@link sweepGenerationLeftovers})收走。
 * 回的 `freedBytes` 是删之前量的 `reclaimableBytes`(下界)。
 *
 * 响应等整个删完才回(登记进 `track`,请求断了关停也会等它)。
 *
 * 不用防「删代撞上迁移」:迁移(`createGeneration` 读第 0 代、写 `<序号>.partial`)只在开机里做,而开机里
 * 完整的 app(含这个口)要等它做完才接请求 —— `index.ts` 先 listen、由 `createStartupApp` 对一切 `/api/*` 回
 * 503(`app.ts` 的 `createStartupApp`),`await createGeneration(…)` 之后才 `currentApp = app`;
 * 系统页的「重新迁移」只是写标记再重启(`routes/system.ts` 的 `POST /generations`),到下次开机才迁。
 * 所以请求能打到这里时,没有正在进行的迁移。
 */
export async function removeGeneration(
	opts: RemoveGenerationOptions,
	seq: number,
): Promise<GenerationRemoval> {
	const list = await listGenerationUsage(opts);
	const complete = list.find((g) => g.seq === seq && !g.partial);
	const target = complete ?? list.find((g) => g.seq === seq);
	if (!target) return { kind: "not_found" };
	if (target.lockReason !== null) return { kind: "locked", reason: target.lockReason };
	const freedBytes = target.reclaimableBytes;
	const task = removeOnDisk(opts.hostRoot, seq);
	opts.track(task);
	await task;
	return { kind: "removed", freedBytes };
}

async function removeOnDisk(hostRoot: string, seq: number): Promise<void> {
	if (seq === 0) {
		// 第 0 代是散在宿主根里的若干键,逐键删:删到一半被杀,剩下的键下次仍列为第 0 代,再删一次就干净。
		for (const key of await existingZeroKeys(hostRoot)) {
			await removeDirectory(zeroPath(hostRoot, key));
		}
		return;
	}
	await removeDirectory(hostPath(hostRoot, "generations", String(seq)));
}

/**
 * 开机清扫补的两处:`generations/` 这一层、宿主根这一层,收**删代删到一半的残骸**与**开代开到一半的
 * `<序号>.partial`**。
 *
 * - 残骸只认「先改名再删」的改名规则产生的名字:`generations/` 里基名是 `<序号>` 或 `<序号>.partial` 的
 *   `.bn-tmp.` / `.bn-old.` 残留;宿主根上基名是第 0 代某个键的。
 * - `<序号>.partial` 是 `createGeneration` 的暂存目录,只在开机里、这趟清扫**之后**才会有人建;清扫时还在的
 *   一定是上个进程被杀留下的。在这里收而不是留给下一次开新代:用已有的一代开机时没人开新代,它会一直占着盘。
 *
 * 都只看这一层、不往里钻 —— 旧代内部是备份,宿主根上的 `versions/`(另有人扫)、`logs/` 与别的东西一概不碰。
 */
export async function sweepGenerationLeftovers(hostRoot: string): Promise<SweepReport> {
	const merged: SweepReport = { removed: [], restored: [], skipped: [] };
	const parts = [
		await sweepPartialGenerations(hostRoot),
		await sweepTempFiles(hostPath(hostRoot, "generations"), {
			recurse: false,
			only: (base) => /^\d+(\.partial)?$/.test(base),
		}),
		await sweepTempFiles(hostRoot, {
			recurse: false,
			only: (base) => (ZERO_KEYS as string[]).includes(base),
		}),
	];
	for (const part of parts) {
		merged.removed.push(...part.removed);
		merged.restored.push(...part.restored);
		merged.skipped.push(...part.skipped);
	}
	return merged;
}

const PARTIAL_GENERATION_NAME = /^\d+\.partial$/;

async function sweepPartialGenerations(hostRoot: string): Promise<SweepReport> {
	const report: SweepReport = { removed: [], restored: [], skipped: [] };
	const root = hostPath(hostRoot, "generations");
	let names: string[];
	try {
		names = await readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			report.skipped.push({ path: root, message: String(error) });
		}
		return report;
	}
	for (const name of names.filter((n) => PARTIAL_GENERATION_NAME.test(n)).sort()) {
		const path = join(root, name);
		try {
			await removeDirectory(path);
			report.removed.push(path);
		} catch (error) {
			report.skipped.push({
				path,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return report;
}

async function existingZeroKeys(hostRoot: string): Promise<ZeroGenerationKey[]> {
	const keys: ZeroGenerationKey[] = [];
	for (const key of ZERO_KEYS) {
		if (await lstatOrUndefined(zeroPath(hostRoot, key))) keys.push(key);
	}
	return keys;
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export interface Measured {
	size: number;
	reclaimable: number;
}

async function measureZero(hostRoot: string): Promise<Measured> {
	const total: Measured = { size: 0, reclaimable: 0 };
	for (const key of await existingZeroKeys(hostRoot)) {
		const part = await measureTree(zeroPath(hostRoot, key));
		total.size += part.size;
		total.reclaimable += part.reclaimable;
	}
	return total;
}

/** 每批并发 `lstat` 多少个文件。 */
const STAT_BATCH = 64;

/**
 * 量一棵树:全部文件(含符号链接本身)的 `lstat` 大小之和是 `size`;只数硬链接数为 1 的文件是 `reclaimable`
 * (硬链接的文件在别的代还活着,删这一代腾不出它)。不跟符号链接,目录自身的大小不算。
 * `path` 本身是文件也行(第 0 代有文件键)。路径不在量出 0。
 */
export async function measureTree(path: string): Promise<Measured> {
	const total: Measured = { size: 0, reclaimable: 0 };
	const first = await lstatOrUndefined(path);
	if (!first) return total;
	if (!first.isDirectory()) {
		add(total, first);
		return total;
	}
	const pending = [path];
	while (pending.length > 0) {
		const dir = pending.pop() as string;
		let names: Dirent[];
		try {
			names = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			// 量的当口被删了 / 读不动:这一层当 0,不让一个坏目录挡住整张列表。
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const files: string[] = [];
		for (const entry of names) {
			const child = join(dir, entry.name);
			if (entry.isDirectory()) pending.push(child);
			else files.push(child);
		}
		for (let i = 0; i < files.length; i += STAT_BATCH) {
			const stats = await Promise.all(files.slice(i, i + STAT_BATCH).map(lstatOrUndefined));
			for (const st of stats) if (st) add(total, st);
		}
	}
	return total;
}

function add(total: Measured, st: Stats): void {
	total.size += st.size;
	if (st.nlink === 1) total.reclaimable += st.size;
}
