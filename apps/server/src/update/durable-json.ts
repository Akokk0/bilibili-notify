import { join } from "node:path";
import { atomicWriteJsonSync, readJsonFileSync } from "@bilibili-notify/storage";

/**
 * `versionsRoot` 下那几份**启发式状态**(`boot-state.json`、`manifest-freshness.json`,
 * 以及拓展的装载账本 / 市场来源账本)共用的读写**策略**。它们形状各不相同,共用的只有下面
 * 这两条策略 —— 而策略正是最该只写一处的东西。怎么把字节安全落盘、怎么隔离坏文件是
 * `@bilibili-notify/storage` 的事(临时文件命名、fsync、失败清理),这里只决定「失败了怎么办」:
 *
 * - **写走原子写。** 就地写的话一次断电就是半个 JSON,读的一侧只能当作「没有任何记录」——
 *   回退的钉子没了、自愈的黑名单没了、防回放的记忆清零了。
 * - **两头都吞掉失败。** 读不出来当没记过(退化成第一次,不是错误);写不进去(只读
 *   挂载、磁盘满)也不拦着启动或检查更新。这份状态坏了不该让进程起不来。
 *
 * 读到**内容坏了**的文件时,存储层把它改名成 `<原名>.corrupt-<时刻>` 隔离:内容一字不丢,
 * 之后的写入落到原位置也不会把它盖掉。读的一侧照旧当没记过。
 *
 * 落盘格式是 2 空格缩进、末尾换行的 JSON —— 字段与位置不变,读方一律 `JSON.parse`,
 * 空白无关(`boot-state.json` 与 `manifest-freshness.json` 是宿主根的冻结格式,冻结的是这两样)。
 *
 * 形状与字段校验留在各自的调用方:它们对「读回来的东西算不算数」有各自的要求,
 * 混进来只会让这里长出一堆谁也说不清的可选项。
 *
 * ⚠️ `boot.ts` 经 `select-version-for-boot` 用到这里,所以这个文件与它 import 的东西都会
 * 打进 `boot.mjs` 的模块图:别往这里加只有服务端运行时才用得上的依赖。
 */

/**
 * 读一份 JSON。文件不在、读不动、内容坏了 —— 一律 `undefined`,由调用方决定默认值。
 * 内容坏了的那份同时已被改名隔离(见文件头)。
 */
export function readBestEffortJson(dir: string, file: string): unknown {
	try {
		const read = readJsonFileSync(join(dir, file));
		// missing 与 corrupt 都是「当没记过」;corrupt 那份存储层已经挪开了。
		return read.kind === "ok" ? read.value : undefined;
	} catch {
		// 读不动(是个目录、没权限),或者坏文件想改名隔离却改不动(只读挂载)。
		return undefined;
	}
}

/**
 * 原子写一份 JSON。写不进去不抛 —— 见文件头那条纪律。
 *
 * 不抛不等于不说:给了 `onError` 就把原因交出去,由调用方决定要不要记一行(写不进去的那份
 * 状态要是在防什么,防线此刻就是失效的,该让人知道)。
 */
export function writeBestEffortJson(
	dir: string,
	file: string,
	value: unknown,
	onError?: (err: unknown) => void,
): void {
	try {
		atomicWriteJsonSync(join(dir, file), value);
	} catch (err) {
		// 见文件头:写不进去的代价是这次没记上账,而那远好过因为记不上账就不启动。
		onError?.(err);
	}
}
