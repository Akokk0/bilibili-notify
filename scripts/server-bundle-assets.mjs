import { access, readdir, readFile, writeFile } from "node:fs/promises";
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
 * 清单之外,dist 还有带 hash 的 JS 分块(它不是一个文件:入口 + 分块 + 资产),分块名每次
 * 构建都变,进不了手写清单 —— 由装配那一刻写出的 bundle-manifest.json 兜底,见
 * writeServerBundleManifest。
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
	// 装配那一刻 dist 里全部文件的清单,下游按它核对搬运有没有丢(分块也在里面)。
	"bundle-manifest.json",
];

export const BUNDLE_MANIFEST_FILE = "bundle-manifest.json";

/**
 * 给定 dist 目录里实际存在的相对路径(posix 分隔),返回清单里缺的那些。纯函数。
 *
 * @param {Iterable<string>} present
 * @returns {string[]}
 */
export function missingServerBundleFiles(present) {
	const set = new Set(present);
	return SERVER_BUNDLE_FILES.filter((file) => !set.has(file));
}

/**
 * 递归列出 `dir` 下全部文件,返回相对路径(posix 分隔)、排好序。
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listBundleFiles(dir) {
	const out = [];
	const walk = async (sub) => {
		for (const entry of await readdir(join(dir, ...sub), { withFileTypes: true })) {
			const rel = [...sub, entry.name];
			if (entry.isDirectory()) await walk(rel);
			else if (entry.isFile()) out.push(posix.join(...rel));
		}
	};
	await walk([]);
	return out.sort();
}

/**
 * 装配收尾时写出 dist 的全量文件清单。
 *
 * 分块少一块是「装上去第一行就 ERR_MODULE_NOT_FOUND」,比清单里的资产炸得还早;而分块名
 * 每次构建都变。所以由**生产者**在装配那一刻把盘上的一切记下来,下游(升级载荷 / 桌面资源)
 * 只做「清单里每个文件都还在」的核对 —— 不必去解析打包产物猜它引用了什么。
 *
 * @param {string} distDir
 * @returns {Promise<string[]>} 写进清单的相对路径
 */
export async function writeServerBundleManifest(distDir) {
	const files = (await listBundleFiles(distDir)).filter((file) => file !== BUNDLE_MANIFEST_FILE);
	await writeFile(
		join(distDir, BUNDLE_MANIFEST_FILE),
		`${JSON.stringify({ files }, null, "\t")}\n`,
	);
	return files;
}

/**
 * 读盘版:检查 `distDir` 下清单里的每一个文件,再按 bundle-manifest.json 核对装配时
 * 记下的全部文件,返回缺失的相对路径。清单本身不在 → 只报它(没得核对)。
 *
 * @param {string} distDir
 * @returns {Promise<string[]>}
 */
export async function missingServerBundleFilesIn(distDir) {
	const present = [];
	for (const file of SERVER_BUNDLE_FILES) {
		if (await exists(join(distDir, ...file.split("/")))) present.push(file);
	}
	const missing = new Set(missingServerBundleFiles(present));
	if (missing.has(BUNDLE_MANIFEST_FILE)) return [...missing];
	const { files } = JSON.parse(await readFile(join(distDir, BUNDLE_MANIFEST_FILE), "utf8"));
	if (!Array.isArray(files))
		throw new Error(`${BUNDLE_MANIFEST_FILE} 里没有 files 数组:${distDir}`);
	for (const file of files) {
		if (!(await exists(join(distDir, ...file.split("/"))))) missing.add(file);
	}
	return [...missing];
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
