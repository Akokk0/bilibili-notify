import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * 版本目录的保留策略:**只留当前 + 上一版**。
 *
 * 一份载荷 ~25MB。不清的话装十次就是 250MB,而这套东西的目标用户里有相当一批跑在
 * 小机器 / NAS 上,`/data` 常常是最不该被这么用的那块盘。
 *
 * 两条纪律:
 *
 * - **只碰长得像版本号的目录**。`/data` 是用户挂出来的,他真的会往里丢东西 ——
 *   手动备份、笔记、装到一半留下的 `.staging-*`。清理越是「顺手」,越容易把别人的
 *   数据顺手清掉,而这种错没有撤销键。
 * - **失败一律吞掉**。清理是省磁盘的,不是升级成功的条件。为它抛异常等于把「装好
 *   了但没打扫干净」报成「升级失败」,用户会去重试一件已经成功了的事。
 */

const VERSION_DIR_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface PruneOldVersionsInput {
	versionsRoot: string;
	/** 留下来的版本号。不在这里面、又长得像版本号的目录会被删掉。 */
	keep: readonly string[];
}

/** @returns 真的删掉了哪几个 —— 给日志用。 */
export function pruneOldVersions({ versionsRoot, keep }: PruneOldVersionsInput): string[] {
	const kept = new Set(keep);
	const removed: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(versionsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => VERSION_DIR_RE.test(name));
	} catch {
		return removed;
	}

	for (const name of entries) {
		if (kept.has(name)) continue;
		try {
			rmSync(join(versionsRoot, name), { recursive: true, force: true });
			removed.push(name);
		} catch {
			// 一个删不掉不影响其他的:权限 / 占用是局部问题,不该让整轮清理停下。
		}
	}
	return removed;
}
