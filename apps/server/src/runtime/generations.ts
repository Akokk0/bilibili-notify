/**
 * 数据代:开机选哪一代、怎么开新的一代(ADR-0022 决策 1–3 与它们下面的 🔗)。
 *
 * 代按递增序号放在宿主根的 `generations/<序号>/` 里,写到一半的叫 `<序号>.partial/`。开新代(首次迁移、
 * 回退后重迁、全新开始)一律拿下一个号,旧代原地不动、永不改名 —— 只有「开新代」一种动作,崩溃恢复
 * 只写一套。每一代根上有一份 `generation.json`:格式版本、迁移修订号、从哪来、最后活跃时间。
 *
 * 两个号别混:
 * - **格式版本**:只在发出去的版本改了盘上格式时加 1。选代只选「格式版本 ≤ 我」的,回退旧版就不用还原。
 * - **迁移修订号**:开发期每改一次迁移的产出就加 1,只比一样不一样。当前代的修订号对不上,就照它当初的
 *   来源重开一代(第 0 代迁来的从第 0 代重迁)—— 开发期迁出来的代会跟着代码变旧。alpha.1 起冻住。
 *
 * 选代只读盘;开代的写全在 {@link createGeneration} 里,经 storage 的原语。
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, removeDirectory, replaceDirectory } from "@bilibili-notify/storage";
import { z } from "zod";
import { hostPath } from "./roots.js";

/** 1.0 的数据格式版本。只在发出去的版本改了盘上格式时加 1;1.0 整个开发期都是 1。 */
export const FORMAT_VERSION = 1;

/** 每一代根上的那份说明。 */
export const GENERATION_FILE = "generation.json";

const GenerationSourceSchema = z.discriminatedUnion("kind", [
	/** 从第 0 代(0.x 留在宿主根上的数据)迁来。 */
	z.object({ kind: z.literal("zero") }),
	/** 空的一代:新装,或以后的「全新开始」。 */
	z.object({ kind: z.literal("empty") }),
]);

const GenerationFileSchema = z.object({
	formatVersion: z.number().int().positive(),
	migrationRevision: z.number().int().nonnegative(),
	createdAt: z.string(),
	/** 开出这一代的载荷版本。 */
	createdBy: z.string(),
	lastActiveAt: z.string(),
	source: GenerationSourceSchema,
});

export type GenerationSource = z.infer<typeof GenerationSourceSchema>;
export type GenerationFile = z.infer<typeof GenerationFileSchema>;

export type GenerationSelection =
	| { kind: "use"; seq: number; dir: string }
	| {
			kind: "create";
			seq: number;
			dir: string;
			/** 在这里搭,搭好再原子改名成 `dir`。 */
			partialDir: string;
			source: GenerationSource;
			/** 上次写到一半留下的 `.partial`,开新代之前清掉。 */
			leftovers: string[];
	  };

export interface SelectGenerationOptions {
	hostRoot: string;
	formatVersion: number;
	migrationRevision: number;
	/** 宿主根上有没有 0.x 的数据(第 0 代)。怎么认是迁移模块的事。 */
	zeroGenerationExists: boolean;
}

const COMPLETE_NAME = /^(\d+)$/;
const PARTIAL_NAME = /^(\d+)\.partial$/;

/**
 * 选这次开机用哪一代。只读盘:没有合用的就交回「开新的一代」,由调用方在 listen 之后去开。
 *
 * 序号只往后排:半截的、读不懂的、格式比我新的,占着的号都不重用。
 */
export async function selectGeneration(
	opts: SelectGenerationOptions,
): Promise<GenerationSelection> {
	const names = await listGenerationNames(opts.hostRoot);
	let highestSeq = 0;
	const leftovers: string[] = [];
	let current: { seq: number; file: GenerationFile } | undefined;
	for (const name of names) {
		const partial = PARTIAL_NAME.exec(name);
		const complete = COMPLETE_NAME.exec(name);
		const seq = Number((partial ?? complete)?.[1] ?? Number.NaN);
		if (Number.isNaN(seq)) continue;
		highestSeq = Math.max(highestSeq, seq);
		if (partial) {
			leftovers.push(hostPath(opts.hostRoot, "generations", name));
			continue;
		}
		const file = await readGenerationFile(hostPath(opts.hostRoot, "generations", name));
		if (!file || file.formatVersion > opts.formatVersion) continue;
		if (!current || seq > current.seq) current = { seq, file };
	}

	if (current && current.file.formatVersion < opts.formatVersion) {
		throw new Error(
			`第 ${current.seq} 代的数据格式版本是 ${current.file.formatVersion},比这一版的 ${opts.formatVersion} 旧;代与代之间的迁移还没有写`,
		);
	}
	if (current && current.file.migrationRevision === opts.migrationRevision) {
		return {
			kind: "use",
			seq: current.seq,
			dir: hostPath(opts.hostRoot, "generations", String(current.seq)),
		};
	}

	// 没有合用的,或者当前代的迁移修订号对不上(开发期):照它当初的来源开下一代。第 0 代要是已经
	// 不在了(被清掉),就只能开空的。
	const wantsZero = (current?.file.source.kind ?? "zero") === "zero";
	const seq = highestSeq + 1;
	return {
		kind: "create",
		seq,
		dir: hostPath(opts.hostRoot, "generations", String(seq)),
		partialDir: hostPath(opts.hostRoot, "generations", `${seq}.partial`),
		source: wantsZero && opts.zeroGenerationExists ? { kind: "zero" } : { kind: "empty" },
		leftovers,
	};
}

export interface CreateGenerationOptions {
	formatVersion: number;
	migrationRevision: number;
	/** 开出这一代的载荷版本。 */
	createdBy: string;
	/** 往 `.partial` 里填内容(迁移器,或者什么都不写的空代)。 */
	fill: (partialDir: string) => Promise<void>;
}

/**
 * 开新的一代:清掉上次的半截,在 `.partial` 里填好内容、写上 generation.json,再原子改名成正式的一代。
 * 填的时候抛了,`.partial` 删掉、错误照抛,不会留下半截的一代。
 */
export async function createGeneration(
	selection: Extract<GenerationSelection, { kind: "create" }>,
	opts: CreateGenerationOptions,
): Promise<void> {
	// 序号只往后排,正式的一代不该已经在;真在的话,下面的整目录替换会把它挪开删掉。
	if (existsSync(selection.dir)) {
		throw new Error(`第 ${selection.seq} 代已经存在,不能再开一次:${selection.dir}`);
	}
	for (const leftover of selection.leftovers) await removeDirectory(leftover);
	await replaceDirectory(
		selection.dir,
		async (partialDir) => {
			await opts.fill(partialDir);
			const now = new Date().toISOString();
			const file: GenerationFile = {
				formatVersion: opts.formatVersion,
				migrationRevision: opts.migrationRevision,
				createdAt: now,
				createdBy: opts.createdBy,
				lastActiveAt: now,
				source: selection.source,
			};
			await atomicWriteJson(join(partialDir, GENERATION_FILE), file);
		},
		{ stagingPath: selection.partialDir },
	);
}

async function listGenerationNames(hostRoot: string): Promise<string[]> {
	try {
		return await readdir(hostPath(hostRoot, "generations"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/**
 * 读一代的 generation.json。缺了或读不懂就当它不是一代(返回 undefined)。只读:读不懂的也不隔离改名,
 * 旧代原地不动。缺失以外的读错(权限、IO)照抛 —— 当成「不是一代」的话会悄悄开出一代新的,
 * 看上去像数据全丢了。
 */
async function readGenerationFile(dir: string): Promise<GenerationFile | undefined> {
	let text: string;
	try {
		text = await readFile(join(dir, GENERATION_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const parsed = GenerationFileSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}
