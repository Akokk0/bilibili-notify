import { access } from "node:fs/promises";
import { join } from "node:path";

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

/**
 * 读盘版:检查 `distDir` 下清单里的每一个文件,返回缺失的相对路径。
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
	return missingServerBundleFiles(present);
}
