/**
 * 数据代:开机选哪一代、怎么开新的一代(ADR-0022 决策 1–3 与它们下面的 🔗)。
 *
 * 代按递增序号放在宿主根的 `generations/<序号>/` 里,写到一半的叫 `<序号>.partial/`。开新代(首次迁移、
 * 主人手动从旧代重迁、全新开始)一律拿下一个号,旧代原地不动、永不改名 —— 只有「开新代」一种动作,崩溃恢复
 * 只写一套。每一代根上有一份 `generation.json`:格式版本、迁移修订号、从哪来、最后活跃时间。
 *
 * 两个号别混:
 * - **格式版本**:只在发出去的版本改了盘上格式时加 1。选代只选「格式版本 ≤ 我」的,回退旧版就不用还原。
 * - **迁移修订号**:开发期每改一次迁移的产出就加 1,只比一样不一样。当前代的修订号对不上,就照它当初的
 *   来源重开一代(第 0 代迁来的从第 0 代重迁)—— 开发期迁出来的代会跟着代码变旧。alpha.1 起冻住。
 *
 * 主人要求开新代(全新开始 / 从旧代重新迁移,ADR-0022 决策 3 下 10-01 的 🔗)走同一条路:面板写下一次性的标记
 * `generations/pending.json`({@link writePendingGeneration})再重启,开机取出({@link takePendingGeneration})
 * 交给选代。标记不是一代,选代本来就不理 `generations/` 里认不得的名字。
 *
 * 选代只读盘;开代的写全在 {@link createGeneration} 里,经 storage 的原语。
 */

import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, copyFileAtomic, replaceDirectory } from "@bilibili-notify/storage";
import { z } from "zod";
import { dataPath, hostPath } from "./roots.js";

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

/** 主人要求开的下一代:放在 `generations/` 里、开机取一次就删。 */
const PendingGenerationSchema = z.object({
	source: GenerationSourceSchema,
	requestedAt: z.string(),
});

const PENDING_FILE = "pending.json";

export type GenerationSource = z.infer<typeof GenerationSourceSchema>;
export type PendingGeneration = z.infer<typeof PendingGenerationSchema>;
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
			/**
			 * 主人要求开新代时正在用的那一代:开新代失败就退回去接着用它,不让整个开机失败。
			 * 不是主人要求的(首次迁移、开发期重迁),或者当时一代都没有,就没有这一格。
			 */
			current?: { seq: number; dir: string };
	  };

export interface SelectGenerationOptions {
	hostRoot: string;
	formatVersion: number;
	migrationRevision: number;
	/** 宿主根上有没有 0.x 的数据(第 0 代)。怎么认是迁移模块的事。 */
	zeroGenerationExists: boolean;
	/**
	 * 主人要求开的下一代({@link takePendingGeneration} 取出来的)。要求从第 0 代迁而第 0 代已经不在了,
	 * 就当没要求。
	 */
	pending?: GenerationSource;
}

const COMPLETE_NAME = /^(\d+)$/;
const PARTIAL_NAME = /^(\d+)\.partial$/;

/**
 * 选这次开机用哪一代。只读盘:没有合用的就交回「开新的一代」,由调用方在 listen 之后去开。
 *
 * 序号只往后排:读不懂的、格式比我新的,占着的号都不重用;半截的(`.partial`)还在盘上时也占着号,
 * 被开机清扫收走以后那个号可以再用(它从没成为过一代,没有东西指着它)。
 */
export async function selectGeneration(
	opts: SelectGenerationOptions,
): Promise<GenerationSelection> {
	const names = await listGenerationNames(opts.hostRoot);
	let highestSeq = 0;
	let current: { seq: number; file: GenerationFile } | undefined;
	for (const name of names) {
		const partial = PARTIAL_NAME.exec(name);
		const complete = COMPLETE_NAME.exec(name);
		const seq = Number((partial ?? complete)?.[1] ?? Number.NaN);
		if (Number.isNaN(seq)) continue;
		highestSeq = Math.max(highestSeq, seq);
		// 写到一半的不算一代(开机清扫会收走,见 `sweepGenerationLeftovers`),只占号。
		if (partial) continue;
		const file = await readGenerationFile(hostPath(opts.hostRoot, "generations", name));
		if (!file || file.formatVersion > opts.formatVersion) continue;
		if (!current || seq > current.seq) current = { seq, file };
	}

	if (current && current.file.formatVersion < opts.formatVersion) {
		throw new Error(
			`第 ${current.seq} 代的数据格式版本是 ${current.file.formatVersion},比这一版的 ${opts.formatVersion} 旧;代与代之间的迁移还没有写`,
		);
	}
	const pending =
		opts.pending?.kind === "zero" && !opts.zeroGenerationExists ? undefined : opts.pending;
	const currentDir = current && hostPath(opts.hostRoot, "generations", String(current.seq));
	if (
		current &&
		currentDir &&
		!pending &&
		current.file.migrationRevision === opts.migrationRevision
	) {
		return { kind: "use", seq: current.seq, dir: currentDir };
	}

	// 主人要求的照要求开。不然就是没有合用的,或者当前代的迁移修订号对不上(开发期):照它当初的来源开下一代;
	// 第 0 代要是已经不在了(被清掉),就只能开空的。
	const wantsZero = (current?.file.source.kind ?? "zero") === "zero";
	const seq = highestSeq + 1;
	return {
		kind: "create",
		seq,
		dir: hostPath(opts.hostRoot, "generations", String(seq)),
		partialDir: hostPath(opts.hostRoot, "generations", `${seq}.partial`),
		source:
			pending ?? (wantsZero && opts.zeroGenerationExists ? { kind: "zero" } : { kind: "empty" }),
		...(pending && current && currentDir ? { current: { seq: current.seq, dir: currentDir } } : {}),
	};
}

/** 记下主人要求开的下一代,等重启后开机取走。已经有一个没取走的就换成这一个。 */
export async function writePendingGeneration(
	hostRoot: string,
	source: GenerationSource,
): Promise<void> {
	const pending: PendingGeneration = { source, requestedAt: new Date().toISOString() };
	await atomicWriteJson(hostPath(hostRoot, "generations", PENDING_FILE), pending);
}

/**
 * 取走主人要求开的下一代:读出来就删,一次性 —— 开代半路被杀,下次开机不会再试一遍,失败了也不会每次开机
 * 都撞上它。读不懂的标记同样删掉,当没要求。
 */
export async function takePendingGeneration(
	hostRoot: string,
): Promise<GenerationSource | undefined> {
	const path = hostPath(hostRoot, "generations", PENDING_FILE);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	await rm(path, { force: true });
	try {
		const parsed = PendingGenerationSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data.source : undefined;
	} catch {
		return undefined;
	}
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
 * 开新的一代:在 `.partial` 里填好内容、写上 generation.json,再原子改名成正式的一代。
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

/**
 * 开机用到这一代:把它的 `lastActiveAt` 记成此刻。只给系统页显示「最后使用时间」,不拿来判断(各代互不干涉,
 * ADR-0022 决策 3 下 10-01 的 🔗)。在原文上改这一格再写回,不经 schema:以后的版本往 generation.json 里加的格,
 * 这一版认不得也不剥掉 —— 那一代以后还要给那个版本用。
 */
export async function markGenerationActive(dir: string): Promise<void> {
	const path = join(dir, GENERATION_FILE);
	const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	await atomicWriteJson(path, { ...raw, lastActiveAt: new Date().toISOString() });
}

/**
 * 把主密钥从一代带进另一代(全新开始,10-02 主人定):主密钥(`master.key`,配了口令时是 `kdf.salt`)只给盘上的东西
 * 加密、本身不装数据,带过去主人不会被登出 —— 面板会话的签名密钥由它派生。密钥袋 `secrets.enc` 不带,里面的
 * 凭据照样清空。哪一个不在就不拷。
 */
export async function copyKeyMaterial(fromDir: string, toDir: string): Promise<void> {
	for (const name of ["master.key", "kdf.salt"]) {
		const from = dataPath(fromDir, "secrets", name);
		if (existsSync(from)) await copyFileAtomic(from, dataPath(toDir, "secrets", name));
	}
}

/** 盘上的一代(只读)。`file` 缺了或读不懂是 `undefined`,写到一半的不读。 */
export interface GenerationEntry {
	seq: number;
	partial: boolean;
	dir: string;
	file: GenerationFile | undefined;
}

/**
 * 列出 `generations/` 里的每一代(完整的与 `.partial`),序号小的在前;认不得的名字(`pending.json`、
 * 删到一半的 `.bn-tmp` 残骸)不算。只读盘,给系统页的「旧版本数据」用。
 */
export async function listGenerationEntries(hostRoot: string): Promise<GenerationEntry[]> {
	const entries: GenerationEntry[] = [];
	for (const name of await listGenerationNames(hostRoot)) {
		const partial = PARTIAL_NAME.exec(name);
		const complete = COMPLETE_NAME.exec(name);
		const match = partial ?? complete;
		if (!match) continue;
		const dir = hostPath(hostRoot, "generations", name);
		entries.push({
			seq: Number(match[1]),
			partial: partial !== null,
			dir,
			file: partial ? undefined : await readGenerationFile(dir),
		});
	}
	return entries.sort((a, b) => a.seq - b.seq || Number(a.partial) - Number(b.partial));
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
