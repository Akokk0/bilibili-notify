/**
 * 第 0 代 → 新的一代(ADR-0022 决策 4、7)。第 0 代就是 0.x 留在宿主根上的那些文件,它只读、一个字节不动;
 * 新的一代由调用方(`runtime/generations.ts` 的 `createGeneration`)在 `.partial` 里交给这里填。
 *
 * ⑥b 这一版**只搬位置,格式一律不动**:0.x 的布局(`ZERO_GENERATION_LAYOUT`)照 `ZERO_GENERATION_MOVES`
 * 搬进代的布局(`runtime/roots.ts` 的 `DATA_ROOT_LAYOUT`),读到的旧格式仍由各个 store 自己认。格式的变换随改盘上形状的那一片加进来,
 * 旧格式的知识最后只住在这个模块里(⑥c 起)。
 *
 * 怎么搬:追加写的 jsonl 一律复制(硬链接的话,新代往里追加会改到旧代的文件),其余硬链接、链接不了
 * 回落成复制;软链(开发版 devtools 链进来的拓展,指向仓里构建好的 dist)在新代里重建同样的一条、
 * 不拷内容。上个进程的残留、0.x 的备份与迁移中间件、卡片皮肤(不迁,决策 12)不带过来,都记进报告。
 */

import { access, lstat, mkdir, readdir, readlink, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	copyFileAtomic,
	isLeftoverName,
	type KeyMaterialRead,
	linkOrCopyFile,
	readKeyMaterial,
	syncDirectory,
} from "@bilibili-notify/storage";
import { CONVERSATIONS_DIR } from "../ai/conversation-store.js";
import { CONFIG_DIR } from "../config/store.js";
import { FOLLOWERS_DIR } from "../fans/store.js";
import { CARD_BG_CURSORS_FILE, CARD_BG_DIR } from "../runtime/card-assets.js";
import { CHAT_ASSETS_DIR } from "../runtime/chat-assets.js";
import { FONT_DIR } from "../runtime/font-assets.js";
import { ROAST_DRAFTS_FILE } from "../runtime/roast-draft-store.js";
import { type DataRootKey, dataPath, HOST_ROOT_LAYOUT } from "../runtime/roots.js";
import { SUB_RUNTIME_FILE } from "../runtime/sub-runtime-store.js";
import { DASHBOARD_SKINS_DIR } from "../skins/store.js";

/**
 * 迁移修订号(见 `runtime/generations.ts`):开发期每改一次迁移的产出(搬什么、搬到哪、怎么搬、丢下什么、
 * 格式怎么变)就加 1,开发期迁出来的那一代据此重迁。只比一样不一样。alpha.1 起冻住。
 * `__tests__/zero-generation.test.ts` 的最后一条钉着「产出变了必须抬它」。
 */
export const MIGRATION_REVISION = 3;

/**
 * 0.x 的布局(第 0 代):宿主根上的一级项。只作迁移的输入 —— 1.0 的代码只认代的布局。
 */
export const ZERO_GENERATION_LAYOUT = {
	state: "设置、两份订阅、连接、目标,和程序自己记的小状态(订阅运行态、锐评草稿)",
	secrets: "主密钥、口令派生盐、AI 的 apiKey、B 站 cookie",
	history: "推送历史 <日>.jsonl、历史图 img/、重推原件 repush/<日>/",
	stats: "作品 dyn/、直播 live/、seen/(按订阅一个 jsonl)与水位线 since",
	fans: "粉丝时序,按订阅一个 jsonl",
	assets: "卡片背景 card-bg/、聊天附件 chat/、字体 font/",
	avatars: "拓展订阅的头像,按订阅 id",
	skins: "界面皮肤 <id>/ 与 active.json",
	"card-skins": "卡片皮肤 <id>/",
	"maid-skills": "主人的女仆技能 <name>/SKILL.md",
	ai: "女仆对话 chat/",
	extensions: "已装的拓展包、失败记账 load-state.json、市场来源 .marketplace.json",
	"card-bg-cursors.json": "直播封面的轮换游标",
} as const;

export type ZeroGenerationKey = keyof typeof ZERO_GENERATION_LAYOUT;

/** 第 0 代里的路径。第一段只能是 `ZERO_GENERATION_LAYOUT` 里的键。 */
export function zeroPath(zeroRoot: string, key: ZeroGenerationKey, ...rest: string[]): string {
	return join(zeroRoot, key, ...rest);
}

/** 代布局里的一个位置:第一段是代的一级项。 */
type Destination = readonly [DataRootKey, ...string[]];

type ZeroMove =
	/** 整个搬到一处。 */
	| { kind: "move"; to: Destination; label: string }
	/** 一级项底下的东西各去各处(`state/` 里的文件分进 config / runtime)。 */
	| { kind: "split"; children: Readonly<Record<string, Destination>>; label: string }
	/** 不迁。 */
	| { kind: "drop"; reason: string };

/**
 * 0.x 的每个一级项去哪。`satisfies` 钉住 0.x 布局里的每一项都有去向:布局多一项,这里不写就编译不过。
 * 去向一律引用各个仓自己导出的位置(`CONFIG_DIR`、`FOLLOWERS_DIR`……),迁移写到哪、仓就从哪读,
 * 两边只有一个真源。
 */
const ZERO_GENERATION_MOVES = {
	state: {
		kind: "split",
		label: "设置与订阅",
		children: {
			"globals.json": [...CONFIG_DIR, "globals.json"],
			"subscriptions.json": [...CONFIG_DIR, "subscriptions.json"],
			"extension-subscriptions.json": [...CONFIG_DIR, "extension-subscriptions.json"],
			"connections.json": [...CONFIG_DIR, "connections.json"],
			"targets.json": [...CONFIG_DIR, "targets.json"],
			// 最老的推送目标格式,只作输入:没有 connections.json 时由配置仓读它迁一次。
			"adapters.json": [...CONFIG_DIR, "adapters.json"],
			"sub-runtime.json": SUB_RUNTIME_FILE,
			"roast-drafts.json": ROAST_DRAFTS_FILE,
		},
	},
	secrets: { kind: "move", to: ["secrets"], label: "密钥" },
	history: { kind: "move", to: ["history"], label: "推送历史" },
	stats: { kind: "move", to: ["stats"], label: "统计" },
	fans: { kind: "move", to: FOLLOWERS_DIR, label: "粉丝时序" },
	assets: {
		kind: "split",
		label: "素材与聊天附件",
		children: {
			"card-bg": CARD_BG_DIR,
			font: FONT_DIR,
			chat: CHAT_ASSETS_DIR,
		},
	},
	avatars: { kind: "move", to: ["avatars"], label: "头像" },
	skins: { kind: "move", to: DASHBOARD_SKINS_DIR, label: "界面皮肤" },
	"card-skins": { kind: "drop", reason: "卡片皮肤不迁(ADR-0022 决策 12)" },
	"maid-skills": { kind: "move", to: ["maid-skills"], label: "女仆技能" },
	ai: { kind: "split", label: "女仆对话", children: { chat: CONVERSATIONS_DIR } },
	extensions: { kind: "move", to: ["extensions"], label: "拓展" },
	"card-bg-cursors.json": { kind: "move", to: CARD_BG_CURSORS_FILE, label: "直播封面的轮换游标" },
} as const satisfies Record<ZeroGenerationKey, ZeroMove>;

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

export interface ZeroMigrationResult {
	/**
	 * 搬过去的每个文件(相对第 0 代根 / 新代根,`/` 分隔)与搬法:`copy` 复制、`link` 硬链接(链接不了会
	 * 回落成复制)、`symlink` 重建同样的一条软链。
	 */
	transfers: { from: string; to: string; method: "copy" | "link" | "symlink" }[];
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

/**
 * 只读地取第 0 代的密钥(迁移还没做完时给会话签名用):和新代的 provider 选同一种、拿到同一把
 * (迁移逐字节搬过去);缺了回 missing,绝不往第 0 代写。
 */
export function readZeroGenerationKey(
	zeroRoot: string,
	passphrase: string | undefined,
): Promise<KeyMaterialRead> {
	return readKeyMaterial({
		passphrase,
		keyPath: zeroPath(zeroRoot, "secrets", "master.key"),
		saltPath: zeroPath(zeroRoot, "secrets", "kdf.salt"),
	});
}

/** 宿主根上有没有 0.x 的数据:0.x 布局里任何一项在就算有。 */
export async function zeroGenerationExists(zeroRoot: string): Promise<boolean> {
	for (const key of Object.keys(ZERO_GENERATION_LAYOUT) as ZeroGenerationKey[]) {
		if (await exists(zeroPath(zeroRoot, key))) return true;
	}
	return false;
}

export async function migrateZeroGeneration(
	opts: MigrateZeroGenerationOptions,
): Promise<ZeroMigrationResult> {
	const report: ZeroMigrationResult = { transfers: [], skipped: [] };
	const context = { zeroRoot: opts.zeroRoot, targetDir: opts.targetDir, report };
	const moves = Object.entries(ZERO_GENERATION_MOVES) as [ZeroGenerationKey, ZeroMove][];
	const total = moves.length;

	await mkdir(opts.targetDir, { recursive: true });
	for (const [index, [key, move]] of moves.entries()) {
		const from = zeroPath(opts.zeroRoot, key);
		if (move.kind === "drop") {
			if (await exists(from)) report.skipped.push({ path: key, reason: move.reason });
			continue;
		}
		opts.onProgress?.({ done: index, total, label: move.label });
		if (!(await exists(from))) continue;
		if (move.kind === "move") {
			await transfer(context, from, dataPath(opts.targetDir, ...move.to));
			continue;
		}
		for (const name of (await readdir(from)).sort()) {
			const destination = move.children[name];
			if (destination) {
				await transfer(context, join(from, name), dataPath(opts.targetDir, ...destination));
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
	report: ZeroMigrationResult;
}

/** 搬一个文件或一整棵目录。目录搬完 fsync 一次,新代改名之前它的每一层都落了盘。 */
async function transfer(context: MigrationContext, from: string, to: string): Promise<void> {
	const info = await lstat(from);
	if (info.isSymbolicLink()) {
		// 开发版 devtools 链进来的拓展:重建同样的一条,指向同一个地方。相对的目标按原来的位置解开,
		// 挪到新代里不会指歪。Windows 上目录要用 junction(和 devtools 建的时候一样)。
		const target = await readlink(from);
		const absolute = isAbsolute(target) ? target : resolve(dirname(from), target);
		const isDir = (await stat(from).catch(() => undefined))?.isDirectory() ?? false;
		await mkdir(dirname(to), { recursive: true });
		await symlink(
			absolute,
			to,
			isDir ? (process.platform === "win32" ? "junction" : "dir") : "file",
		);
		context.report.transfers.push({
			from: portable(relative(context.zeroRoot, from)),
			to: portable(relative(context.targetDir, to)),
			method: "symlink",
		});
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
