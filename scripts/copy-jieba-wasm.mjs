// 把 jieba-wasm 的 wasm 二进制拷到 koishi 插件的产物目录旁边。koishi 的 `build`
// 在 `vp pack` 之后调用本脚本。
//
// 为什么需要这一步:koishi 插件是**单文件 CJS bundle**,jieba-wasm 的 JS 胶水被
// 内联了进去,但胶水在运行时仍然会
//
//     require("path").join(__dirname, "jieba_rs_wasm_bg.wasm")
//
// 去磁盘上读 wasm 二进制。打包后 `__dirname` 就是 `koishi/lib/`,所以那个 .wasm
// 必须躺在 lib/ 里,否则用户一 require 插件就 ENOENT(而构建是全绿的 —— 这类雷只
// 在运行期炸)。
//
// 为什么不干脆把 jieba-wasm 整个 external 掉:它的 npm 包里塞了**四份**一模一样
// 大小的 wasm(deno / nodejs / web / bundler,合计 16MB),而我们只需要 nodejs 那
// 一份(3.8MB)。内联胶水 + 只拷这一份,省掉 12MB,且用户无需做任何选择。

import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

/**
 * 定位要随包发布的那一份 wasm。
 *
 * 锚定「Node 解析 `jieba-wasm` 主入口之后的兄弟文件」,而不是硬编码
 * `pkg/nodejs/...` —— 主入口正是被内联进 bundle 的那份胶水,它的兄弟 wasm 必然是
 * 与之配套的那份。包升级换了目录布局也不会悄悄拷错一份进去。
 *
 * 从 `packages/live` 解析:jieba-wasm 是它的依赖(弹幕分词 → 词云),不是 koishi
 * 包的直接依赖。
 *
 * @returns {string} wasm 二进制的绝对路径。
 */
export function resolveJiebaWasm() {
	const requireFromLive = createRequire(join(repoRoot, "packages", "live", "package.json"));
	const glue = requireFromLive.resolve("jieba-wasm");
	return join(dirname(glue), "jieba_rs_wasm_bg.wasm");
}

function main() {
	const src = resolveJiebaWasm();
	const dest = join(repoRoot, "koishi", "lib", "jieba_rs_wasm_bg.wasm");
	copyFileSync(src, dest);
	console.log(`[koishi] jieba wasm → ${dest}`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
	main();
}
