import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `versionsRoot` 下那几份**启发式状态**(`boot-state.json`、`manifest-freshness.json`)
 * 共用的读写纪律。它们形状各不相同,共用的只有下面这两条策略 —— 而策略正是最该只写
 * 一处的东西:
 *
 * - **写走 tmp + rename。** 就地写的话一次断电就是半个 JSON,读的一侧只能当作「没有
 *   任何记录」—— 回退的钉子没了、自愈的黑名单没了、防回放的记忆清零了。
 * - **两头都吞掉失败。** 读不出来当没记过(退化成第一次,不是错误);写不进去(只读
 *   挂载、磁盘满)也不拦着启动或检查更新。这份状态坏了不该让进程起不来。
 *
 * 形状与字段校验留在各自的调用方:它们对「读回来的东西算不算数」有各自的要求,
 * 混进来只会让这里长出一堆谁也说不清的可选项。
 */

/** 读一份 JSON。文件不在、读不动、被写坏了 —— 一律 `undefined`,由调用方决定默认值。 */
export function readJsonFile(dir: string, file: string): unknown {
	try {
		return JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

/** 原子写一份 JSON。写不进去不抛 —— 见文件头那条纪律。 */
export function writeJsonAtomic(dir: string, file: string, value: unknown): void {
	try {
		mkdirSync(dir, { recursive: true });
		const tmp = join(dir, `.${file}.${process.pid}.tmp`);
		writeFileSync(tmp, JSON.stringify(value));
		renameSync(tmp, join(dir, file));
	} catch {
		// 见文件头:写不进去的代价是这次没记上账,而那远好过因为记不上账就不启动。
	}
}
