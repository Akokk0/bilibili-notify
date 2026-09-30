/**
 * 第 0 代 → 新的一代(ADR-0022 决策 4、7)。第 0 代就是 0.x 留在宿主根上的那些文件,它只读、一个字节不动;
 * 新的一代由调用方(`runtime/generations.ts` 的 `createGeneration`)在 `.partial` 里交给这里填。
 *
 * ⑥b 这一版**只搬位置,格式一律不动**:0.x 的布局照 `ZERO_GENERATION_MOVES` 搬进代的布局
 * (`GENERATION_LAYOUT`),读到的旧格式仍由各个 store 自己认。格式的变换随改盘上形状的那一片加进来,
 * 旧格式的知识最后只住在这个模块里(⑥c 起)。
 *
 * 怎么搬:追加写的 jsonl 一律复制(硬链接的话,新代往里追加会改到旧代的文件),其余硬链接、链接不了
 * 回落成复制。上个进程的残留、0.x 的备份与迁移中间件、卡片皮肤(不迁,决策 12)、软链(开发版 devtools
 * 链进来的拓展,它会在新代里重建)不带过来,都记进报告。
 */

import { access, lstat, mkdir, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
	copyFileAtomic,
	isLeftoverName,
	linkOrCopyFile,
	syncDirectory,
} from "@bilibili-notify/storage";
import {
	DATA_ROOT_LAYOUT,
	type DataRootKey,
	dataPath,
	type GenerationKey,
	generationPath,
	HOST_ROOT_LAYOUT,
} from "../runtime/roots.js";

/**
 * 迁移修订号(见 `runtime/generations.ts`):开发期每改一次迁移的产出(搬什么、搬到哪、怎么搬、丢下什么、
 * 格式怎么变)就加 1,开发期迁出来的那一代据此重迁。只比一样不一样。alpha.1 起冻住。
 * `__tests__/zero-generation.test.ts` 的最后一条钉着「产出变了必须抬它」。
 */
export const MIGRATION_REVISION = 1;

/** 代布局里的一个位置:第一段是代的一级项。 */
type Destination = readonly [GenerationKey, ...string[]];

type ZeroMove =
	/** 整个搬到一处。 */
	| { kind: "move"; to: Destination; label: string }
	/** 一级项底下的东西各去各处(`state/` 里的文件分进 config / runtime)。 */
	| { kind: "split"; children: Readonly<Record<string, Destination>>; label: string }
	/** 不迁。 */
	| { kind: "drop"; reason: string };

/**
 * 0.x 的每个一级项去哪。`satisfies` 钉住 0.x 目录表里的每一项都有去向:目录表多一项,这里不写就编译不过。
 */
const ZERO_GENERATION_MOVES = {
	state: {
		kind: "split",
		label: "设置与订阅",
		children: {
			"globals.json": ["config", "globals.json"],
			"subscriptions.json": ["config", "subscriptions.json"],
			"extension-subscriptions.json": ["config", "extension-subscriptions.json"],
			"connections.json": ["config", "connections.json"],
			"targets.json": ["config", "targets.json"],
			// 最老的推送目标格式,只作输入:没有 connections.json 时由配置仓读它迁一次。
			"adapters.json": ["config", "adapters.json"],
			"sub-runtime.json": ["runtime", "sub-runtime.json"],
			"roast-drafts.json": ["runtime", "roast-drafts.json"],
		},
	},
	secrets: { kind: "move", to: ["secrets"], label: "密钥" },
	history: { kind: "move", to: ["history"], label: "推送历史" },
	stats: { kind: "move", to: ["stats"], label: "统计" },
	fans: { kind: "move", to: ["stats", "followers"], label: "粉丝时序" },
	assets: {
		kind: "split",
		label: "素材与聊天附件",
		children: {
			"card-bg": ["library", "images"],
			font: ["library", "fonts"],
			chat: ["assets", "chat"],
		},
	},
	avatars: { kind: "move", to: ["avatars"], label: "头像" },
	skins: { kind: "move", to: ["skins", "panel"], label: "界面皮肤" },
	"card-skins": { kind: "drop", reason: "卡片皮肤不迁(ADR-0022 决策 12)" },
	"maid-skills": { kind: "move", to: ["maid-skills"], label: "女仆技能" },
	ai: { kind: "split", label: "女仆对话", children: { chat: ["ai", "conversations"] } },
	extensions: { kind: "move", to: ["extensions"], label: "拓展" },
	"card-bg-cursors.json": {
		kind: "move",
		to: ["runtime", "card-bg-cursors.json"],
		label: "直播封面的轮换游标",
	},
} as const satisfies Record<DataRootKey, ZeroMove>;

/** 0.x 根上认得、但不属于任何一代的一级项:宿主件,和装各代的那一层。 */
const HOST_NAMES: ReadonlySet<string> = new Set(Object.keys(HOST_ROOT_LAYOUT));

/** 0.x 根上认得的残留目录:storage 旧的缺省布局(三条密钥路径由宿主给全以后就没人写了)。 */
const ZERO_LEFTOVER_DIRS: ReadonlySet<string> = new Set(["bilibili-notify"]);

export interface MigrationProgress {
	done: number;
	total: number;
	/** 正在搬的那一项,给「正在搬家」那句话用。 */
	label: string;
}

export interface ZeroMigrationReport {
	/** 搬过去的每个文件(相对第 0 代根 / 新代根,`/` 分隔)与搬法:`copy` 复制、`link` 硬链接(链接不了会回落成复制)。 */
	transfers: { from: string; to: string; method: "copy" | "link" }[];
	/** 没带过来的,和为什么。 */
	skipped: { path: string; reason: string }[];
}

export interface MigrateZeroGenerationOptions {
	/** 第 0 代的根,也就是宿主根。只读。 */
	zeroRoot: string;
	/** 往这里填:新代的 `.partial`。 */
	targetDir: string;
	onProgress?: (progress: MigrationProgress) => void;
}

/** 宿主根上有没有 0.x 的数据:0.x 目录表里任何一项在就算有。 */
export async function zeroGenerationExists(zeroRoot: string): Promise<boolean> {
	for (const key of Object.keys(DATA_ROOT_LAYOUT) as DataRootKey[]) {
		if (await exists(dataPath(zeroRoot, key))) return true;
	}
	return false;
}

export async function migrateZeroGeneration(
	opts: MigrateZeroGenerationOptions,
): Promise<ZeroMigrationReport> {
	const report: ZeroMigrationReport = { transfers: [], skipped: [] };
	const context = { zeroRoot: opts.zeroRoot, targetDir: opts.targetDir, report };
	const moves = Object.entries(ZERO_GENERATION_MOVES) as [DataRootKey, ZeroMove][];
	const total = moves.length;

	await mkdir(opts.targetDir, { recursive: true });
	for (const [index, [key, move]] of moves.entries()) {
		const from = dataPath(opts.zeroRoot, key);
		if (move.kind === "drop") {
			if (await exists(from)) report.skipped.push({ path: key, reason: move.reason });
			continue;
		}
		opts.onProgress?.({ done: index, total, label: move.label });
		if (!(await exists(from))) continue;
		if (move.kind === "move") {
			await transfer(context, from, generationPath(opts.targetDir, ...move.to));
			continue;
		}
		for (const name of (await readdir(from)).sort()) {
			const destination = move.children[name];
			if (destination) {
				await transfer(context, join(from, name), generationPath(opts.targetDir, ...destination));
			} else {
				skip(context, join(from, name), leftoverReason(name) ?? "认不得,没带过来");
			}
		}
	}

	for (const name of (await readdir(opts.zeroRoot)).sort()) {
		if (name in ZERO_GENERATION_MOVES || HOST_NAMES.has(name)) continue;
		skip(
			context,
			join(opts.zeroRoot, name),
			ZERO_LEFTOVER_DIRS.has(name)
				? "storage 旧的缺省目录"
				: (leftoverReason(name) ?? "认不得,没带过来"),
		);
	}
	await syncDirectory(opts.targetDir);
	opts.onProgress?.({ done: total, total, label: "搬完了" });
	return report;
}

interface MigrationContext {
	zeroRoot: string;
	targetDir: string;
	report: ZeroMigrationReport;
}

/** 搬一个文件或一整棵目录。目录搬完 fsync 一次,新代改名之前它的每一层都落了盘。 */
async function transfer(context: MigrationContext, from: string, to: string): Promise<void> {
	const info = await lstat(from);
	if (info.isSymbolicLink()) {
		skip(context, from, "软链不搬:开发版 devtools 会在新代里重建");
		return;
	}
	if (info.isDirectory()) {
		await mkdir(to, { recursive: true });
		for (const name of (await readdir(from)).sort()) {
			const reason = leftoverReason(name);
			if (reason) skip(context, join(from, name), reason);
			else await transfer(context, join(from, name), join(to, name));
		}
		await syncDirectory(to);
		return;
	}
	if (!info.isFile()) {
		skip(context, from, "不是普通文件");
		return;
	}
	const method = from.endsWith(".jsonl") ? "copy" : "link";
	if (method === "copy") await copyFileAtomic(from, to);
	else await linkOrCopyFile(from, to);
	context.report.transfers.push({
		from: portable(relative(context.zeroRoot, from)),
		to: portable(relative(context.targetDir, to)),
		method,
	});
}

function skip(context: MigrationContext, path: string, reason: string): void {
	context.report.skipped.push({ path: portable(relative(context.zeroRoot, path)), reason });
}

/**
 * 这个名字是不是残留,是的话为什么不带:上个进程的临时文件与暂存目录(storage 的标记)、0.x 的备份
 * (`*.bak`、恢复备份留下的 `*.restore.bak`)、0.x 自己的临时件与迁移中间件、被隔离的坏文件。
 */
function leftoverReason(name: string): string | undefined {
	if (isLeftoverName(name)) return "上个进程留下的临时文件";
	if (name.endsWith(".bak")) return "0.x 的备份";
	if (/\.tmp(\.|$)/.test(name) || name.startsWith(".staging-") || name.endsWith(".migrating")) {
		return "0.x 的临时件";
	}
	if (name.includes(".corrupt-")) return "被隔离的坏文件";
	return undefined;
}

function portable(path: string): string {
	return path.split(sep).join("/");
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
