import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isBiliSubscription, type Logger } from "@bilibili-notify/internal";
import { FANS_DIR } from "../fans/store.js";
import type { KeyedSubscription } from "./file-key.js";
import { STATS_DYN_DIR, STATS_LIVE_DIR } from "./store.js";

/**
 * **开机迁移**:B 站的统计与粉丝文件从 `<uid>.jsonl` 并进 `<订阅 id>.jsonl`(ADR-0020 决策 2 的 🔗)。
 *
 * **每次开机都跑**,而且必须跑在任何写这三处的人之前(index.ts 在读完配置之后、建引擎与粉丝轮询
 * 之前 await 它)。只跑一次不够:这个项目的回退是正经路径(面板的回退钮、服务端撤回坏版本),
 * 回退到老版本期间它只认 uid 文件,还会重新写出 uid 文件 —— 重新升级时要把那段并回来,一行不丢。
 *
 * 对每一条 B 站订阅(启用与否都算),三个目录各看一眼:
 *   - 没有 `<uid>.jsonl`:什么都不做(第二次开机起的常态);
 *   - 只有 uid 那份:改名(同目录内的 rename,原子);
 *   - 两份都在(回退过):id 那份在前、uid 那份接在后面 —— 回退期间写的一定更晚,接在后面时间
 *     仍然只增不减;粉丝仓按「时间只增不减」扫文件,见 FansStore.findNearestBefore。
 *
 * **崩在半路**:并好的内容先写临时文件、落盘、再原子换上,换上之后才删 uid 那份。所以 uid 那份
 * 在任何时刻都没丢;换上了、还没删的时候崩了,下次开机看到 id 那份已经以 uid 那份的内容结尾,
 * 只删不再接 —— 不会多出一遍。万一还是多出了重复的行(比如别的原因中断在更怪的地方),读的人
 * 也扛得住:作品按 id 去重,直播帧按开播时刻认场次、重放一遍同样的帧结果不变,粉丝样本整段重复
 * 只是同样的值再出现一次(见 migrate-file-keys.test.ts「就算多出了重复的行」)。
 *
 * 找不到 B 站订阅的 uid 文件不碰(可能是删订阅时没删干净的,也可能是别的什么 —— 不是我们的就别动)。
 * 同一个 uid 两条 B 站订阅(服务端不判重,只有面板挡着):两条都拿到一份,与改之前两行共读一个
 * uid 文件同一个结果。单个文件出错只打 warn、接着迁别的,不挡开机 —— 下次开机再试。
 */

export interface StatsFileKeyMigrationResult {
	/** 只有 uid 那份,改名。 */
	renamed: number;
	/** 两份都在,并起来(含「并好了只差删 uid 那份」)。 */
	merged: number;
	/** 同一个 uid 的第二条及以后的订阅,复制一份。 */
	copied: number;
}

export interface MigrateStatsFileKeysOptions {
	dataDir: string;
	/** 全部订阅(拓展的会被跳过)。 */
	subscriptions: readonly KeyedSubscription[];
	logger: Logger;
}

/** 这三处按文件键分文件。 */
const KEYED_DIRS = [STATS_DYN_DIR, STATS_LIVE_DIR, FANS_DIR] as const;

const TEMP_SUFFIX = ".migrating";

export async function migrateStatsFileKeys(
	opts: MigrateStatsFileKeysOptions,
): Promise<StatsFileKeyMigrationResult> {
	const result: StatsFileKeyMigrationResult = { renamed: 0, merged: 0, copied: 0 };
	const idsByUid = new Map<string, string[]>();
	for (const sub of opts.subscriptions) {
		if (!isBiliSubscription(sub)) continue;
		const ids = idsByUid.get(sub.uid) ?? [];
		ids.push(sub.id);
		idsByUid.set(sub.uid, ids);
	}

	for (const dir of KEYED_DIRS) {
		const root = join(opts.dataDir, dir);
		for (const [uid, ids] of idsByUid) {
			try {
				await migrateOne(root, uid, ids, result);
			} catch (err) {
				opts.logger.warn(`[stats-migrate] ${dir}/${uid}.jsonl 没迁成,下次开机再试: ${String(err)}`);
			}
		}
	}

	if (result.renamed + result.merged + result.copied > 0) {
		opts.logger.info(
			`[stats-migrate] 统计 / 粉丝文件改按订阅 id 命名:改名 ${result.renamed}、并入 ${result.merged}、复制 ${result.copied}`,
		);
	}
	return result;
}

async function migrateOne(
	root: string,
	uid: string,
	ids: readonly string[],
	result: StatsFileKeyMigrationResult,
): Promise<void> {
	const uidFile = join(root, `${uid}.jsonl`);
	const uidContent = await readIfExists(uidFile);
	if (uidContent === undefined) return;

	for (const [i, id] of ids.entries()) {
		const idFile = join(root, `${id}.jsonl`);
		const isLast = i === ids.length - 1;
		// 上次崩在「临时文件写了、还没换上」留下的半截。只有 uid 那份还在时才可能有它。
		await unlinkIfExists(`${idFile}${TEMP_SUFFIX}`);
		const idContent = await readIfExists(idFile);
		if (idContent === undefined) {
			if (isLast) {
				// 最常见的一条路:第一次开机、一个 uid 一条订阅。同目录 rename 是原子的,uid 那份
				// 随之消失,不用再删。
				await rename(uidFile, idFile);
				await syncDir(root);
				result.renamed++;
				return;
			}
			await writeDurably(idFile, uidContent);
			result.copied++;
			continue;
		}
		const head = withTrailingNewline(idContent);
		const tail = withTrailingNewline(uidContent);
		// 已经以 uid 那份的内容结尾 = 上次并好了、只差删 uid 那份(或者这就是上次复制出来的那份)。
		if (!head.endsWith(tail)) await writeDurably(idFile, head + tail);
		result.merged++;
	}
	// 每一份都已经落好了,这时才删 uid 那份。
	await unlink(uidFile);
	await syncDir(root);
}

/** 读整份;不存在返回 undefined。目录不存在(全新安装)同样当不存在。 */
async function readIfExists(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

function withTrailingNewline(text: string): string {
	return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * 写临时文件 → fsync → 原子 rename 换上 → fsync 目录。崩在任何一步,`file` 要么是原来那份,
 * 要么是完整的新内容;留下的半截临时文件下次开机会被整个覆盖掉(读的人只认 `.jsonl`)。
 */
async function writeDurably(file: string, content: string): Promise<void> {
	const temp = `${file}${TEMP_SUFFIX}`;
	const handle = await open(temp, "w");
	try {
		await handle.writeFile(content, "utf-8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temp, file);
	await syncDir(dirname(file));
}

async function unlinkIfExists(file: string): Promise<void> {
	try {
		await unlink(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}

/** 让目录项的改动(rename / unlink)落盘。有的平台(Windows)打不开目录来 fsync,尽力而为。 */
async function syncDir(dir: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(dir, "r");
		await handle.sync();
	} catch {
		/* best effort */
	} finally {
		await handle?.close().catch(() => {});
	}
}
