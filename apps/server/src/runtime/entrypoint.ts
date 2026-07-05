import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 判断当前模块是否为 node 直接启动的主入口(`node <entry>`)。
 * index.ts 用它守卫 startStandaloneServer —— 被 import(测试 / 组合)时不自启。
 */
export function isEntrypoint(
	metaUrl: string,
	entry: string | undefined = process.argv[1],
): boolean {
	if (!entry) return false;
	const resolved = resolve(entry);
	if (metaUrl === pathToFileURL(resolved).href) return true;
	// node 的 ESM loader 以 **realpath** 后的 URL 记 import.meta.url,而 argv[1]
	// 保留用户敲的 symlink 路径(macOS /var→/private/var、~/bin 软链等)。只比
	// 字符串会静默判假 —— 进程什么都不干、退出码 0。realpath 对齐后再比一次。
	try {
		return metaUrl === pathToFileURL(realpathSync(resolved)).href;
	} catch {
		// entry 不在磁盘上(异常调用形态)—— 保守判非入口。
		return false;
	}
}
