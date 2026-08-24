/**
 * 静态守卫共用的目录遍历。
 *
 * 收编前六道守卫各写一份递归 —— 逻辑一样,**跳过规则却各飘各的**:有的按目录名
 * 跳 `__tests__`,有的按路径子串跳,有的连 `node_modules` 一起跳,还有两道压根
 * 不跳、改在调用点逐条 `continue`。这才是真风险:守卫的价值全在「扫得全」,而
 * 少跳一个目录、多跳一个目录都不会红,只会让某道护栏的射程悄悄短一截。
 *
 * 所以这里**不替调用方拿主意**:跳过规则是显式选项,六处各自写明要哪种。
 * 那几处「不跳测试」是**承重**的 —— 比如字段字典那道,测试文件里也写 `code=`,
 * 引用了一个不存在的字段码同样该被拦下来。
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface WalkOptions {
	/** 收哪些后缀。默认只收 `.tsx`。 */
	exts?: readonly string[];
	/** 跳过 `__tests__` 目录。**没有默认值,必须写明**。 */
	skipTestDirs: boolean;
	/**
	 * 另外跳过任何位置的 `*.test.*` 文件。
	 *
	 * **和上一条是两件事**:站里有十个测试文件不住在 `__tests__` 里(挨着被测组件
	 * 放,如 `pages/backup/BackupExportDialog.test.tsx`),只跳目录的守卫照样在扫
	 * 它们。收编时逐个文件对过两边的扫描面,才发现这一层差别 —— 所以它是个独立
	 * 开关,而不是被并进 skipTestDirs 里悄悄改掉谁的射程。
	 */
	skipTestFiles?: boolean;
	/** 顺带跳过的目录名(如 `node_modules`)。 */
	skipDirs?: readonly string[];
}

/** 递归列出目录下的源码文件绝对路径。 */
export function listSources(dir: string, opts: WalkOptions): string[] {
	const exts = opts.exts ?? [".tsx"];
	const skipDirs = new Set(opts.skipDirs ?? []);
	const acc: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			if (skipDirs.has(name)) continue;
			if (opts.skipTestDirs && name === "__tests__") continue;
			acc.push(...listSources(full, opts));
			continue;
		}
		if (!exts.some((e) => name.endsWith(e))) continue;
		if (opts.skipTestFiles && /\.test\.[cm]?tsx?$/.test(name)) continue;
		acc.push(full);
	}
	return acc;
}
