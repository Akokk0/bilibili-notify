import { access, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

/**
 * 自包含 server bundle(`apps/server/dist`)必须带齐的文件 —— **只声明一次**。
 *
 * 三个消费者:
 *   - scripts/assemble-server-bundle.mjs 把资产搬进 dist/ 之后按这份清单自检;
 *   - scripts/build-update-payload.mjs 打升级载荷前按它把关;
 *   - apps/desktop/scripts/prepare-resources.mjs 把 dist 摆进桌面资源后再验一遍。
 *
 * 为什么不各写各的:这些文件全是**运行时按路径读盘**的(词云 static、jieba 的 wasm、
 * jsdom 的 worker 与默认样式表),少一个不会在构建期报错,只会在用户点到那个功能时炸。
 * 三处各抄一份清单,就是三处可以各自落后。
 *
 * 清单之外还有带 hash 的 JS 分块(dist 不是一个文件,见 serverBundleChunksIn):hash 每次
 * 构建都变,进不了手写清单,由 missingServerBundleFilesIn 沿入口的 import 图现算。
 */
export const SERVER_BUNDLE_FILES = [
	// 容器 CMD、桌面壳、升级载荷起的都是它:先选版再加载载荷。
	"boot.mjs",
	// 载荷本体。
	"index.mjs",
	// resolveAppVersion 从入口往上找最近的这一份,报的是载荷自己的版本。
	"package.json",
	// 词云模板:image 包运行时 readFileSync(resolve(__dirname, "static/*.js"))。
	"static/render.js",
	"static/wordcloud2.min.js",
	// jieba-wasm 的 wasm 本体,胶水按 __dirname 读它。
	"jieba_rs_wasm_bg.wasm",
	// jsdom 同步 XHR worker,运行时按文件路径加载。
	"xhr-sync-worker.js",
	// jsdom 30 起模块加载即读默认样式表;patches/jsdom.patch 的 fallback 指向这份拷贝。
	"default-stylesheet.css",
	// 首启动配置样例,与 bundle 平级。
	"bn.config.example.yaml",
];

/**
 * 给定 dist 目录里实际存在的相对路径(posix 分隔),返回清单里缺的那些。纯函数。
 *
 * @param {Iterable<string>} present
 * @returns {string[]}
 */
export function missingServerBundleFiles(present) {
	const set = present instanceof Set ? present : new Set(present);
	return SERVER_BUNDLE_FILES.filter((file) => !set.has(file));
}

/** 两个入口:选版器与载荷本体。分块图从它们出发。 */
const ENTRY_FILES = ["boot.mjs", "index.mjs"];

// 相对说明符:静态 `import x from "./a.mjs"` / `import "./a.mjs"` / `export * from "./a.mjs"`,以及动态
// `import("./a.mjs")`。只认 `./` `../` 打头、以分块后缀结尾的 —— `node:` 内置与裸包名不是分块;被内联进
// 来的第三方源码里也躺着 `import('./client.js')` 这类字符串(它们在 dist 里不存在),后缀把它们排除掉。
// 后缀与 ENTRY_FILES 同一种:分块和入口出自同一次构建。动态 import 的括号里允许夹块注释 ——
// puppeteer 懒加载 bidi 那一块写的是 `import(/* webpackIgnore: true */ "./bidi-*.mjs")`,还跨行。
const RELATIVE_IMPORT =
	/(?:\bfrom\s*|\bimport\s*(?:\(\s*(?:\/\*[\s\S]*?\*\/\s*)*)?)['"](\.{1,2}\/[^'"\n]+\.mjs)['"]/g;

/**
 * dist 不是一个文件:boot.mjs / index.mjs 静态 import 若干带 hash 的分块,分块之间再互相
 * import,动态 import(openai 这类)也在其中。少一块是「装上去第一行就 ERR_MODULE_NOT_FOUND」,
 * 比清单里的资产炸得还早 —— 沿两个入口的 import 图走到底,盘上没有的点名。
 *
 * 入口本身不在盘上不算这里的事(手写清单会报),直接跳过。
 *
 * @param {string} distDir
 * @returns {Promise<{ chunks: string[], missing: string[] }>} dist 相对路径(posix 分隔),排好序
 */
export async function serverBundleChunksIn(distDir) {
	const seen = new Set();
	const missing = new Set();
	const queue = [...ENTRY_FILES];
	while (queue.length > 0) {
		const rel = queue.shift();
		if (seen.has(rel)) continue;
		seen.add(rel);
		let source;
		try {
			source = await readFile(join(distDir, ...rel.split("/")), "utf8");
		} catch {
			if (!ENTRY_FILES.includes(rel)) missing.add(rel);
			continue;
		}
		for (const [, spec] of source.matchAll(RELATIVE_IMPORT)) {
			const next = posix.normalize(posix.join(posix.dirname(rel), spec));
			if (next.startsWith("../")) continue; // 指到 dist 外面去的不归这里管。
			queue.push(next);
		}
	}
	const chunks = [...seen].filter((rel) => !ENTRY_FILES.includes(rel)).sort();
	return { chunks, missing: [...missing].sort() };
}

/**
 * 读盘版:检查 `distDir` 下清单里的每一个文件,再沿入口的 import 图核对分块,返回缺失的相对路径。
 *
 * @param {string} distDir
 * @returns {Promise<string[]>}
 */
export async function missingServerBundleFilesIn(distDir) {
	const present = [];
	for (const file of SERVER_BUNDLE_FILES) {
		try {
			await access(join(distDir, ...file.split("/")));
			present.push(file);
		} catch {
			// 不存在 → 不进 present。
		}
	}
	const { missing } = await serverBundleChunksIn(distDir);
	return [...missingServerBundleFiles(present), ...missing];
}
