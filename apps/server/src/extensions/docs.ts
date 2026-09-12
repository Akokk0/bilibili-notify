/**
 * 读一个**装着的**拓展自己带的 README / CHANGELOG。
 *
 * 🔴 这一层只认磁盘,不认活着的实例:拓展关着、甚至加载失败,说明照样该读得出来 ——
 * 那恰恰是人最想读它的时候(「这到底是干嘛的」「为什么起不来」)。所以它拿的是装载根
 * 加一个 id,而不是 loader 那张表。
 *
 * 两份都可能没有,**没有不是错**:第三方拓展不写 README 是它的自由,面板那头整块不画。
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	EXTENSION_CHANGELOG_FILE,
	EXTENSION_DOC_MAX_BYTES,
	EXTENSION_README_FILE,
} from "./discover.js";

export interface ExtensionDocs {
	readme?: string;
	changelog?: string;
}

/** 读一份。读不到、不是文件、超上限 —— 三种都当「没有」,面板不需要分。 */
async function readDoc(path: string): Promise<string | undefined> {
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > EXTENSION_DOC_MAX_BYTES) return undefined;
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * 回 `undefined` 表示**这个拓展压根没装**(装载根底下没有这个目录)—— 与「装了但没写文档」
 * 是两回事,路由据此分 404 和 200。
 */
export async function readExtensionDocs(opts: {
	root: string;
	id: string;
}): Promise<ExtensionDocs | undefined> {
	const dir = join(opts.root, opts.id);
	try {
		if (!(await stat(dir)).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	return {
		readme: await readDoc(join(dir, EXTENSION_README_FILE)),
		changelog: await readDoc(join(dir, EXTENSION_CHANGELOG_FILE)),
	};
}
