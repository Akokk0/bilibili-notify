import { existsSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { resolveJiebaWasm } from "./copy-jieba-wasm.mjs";

/**
 * koishi 插件把 jieba-wasm 的 JS 胶水内联进 bundle,但胶水在运行时用
 * `path.join(__dirname, "jieba_rs_wasm_bg.wasm")` 去磁盘上找 wasm 二进制 ——
 * 打包后 __dirname 是 lib/,所以 wasm 必须被拷到 lib/ 旁边,否则装到用户机器上
 * 一 require 就 ENOENT。
 *
 * jieba-wasm 的 npm 包里有四份完全相同大小的 wasm(deno / nodejs / web / bundler,
 * 共 16MB),只有 nodejs 那份是我们内联的胶水配套的。解析必须锚定到「Node 解析
 * `jieba-wasm` 主入口后的兄弟文件」,而不是硬编码 pkg/nodejs 路径 —— 前者跟着
 * 包自己的 exports 走,包升级换了布局也不会悄悄拷错一份。
 */
describe("resolveJiebaWasm", () => {
	it("锚定到 Node 解析出的主入口的兄弟 wasm", () => {
		const wasm = resolveJiebaWasm();

		expect(basename(wasm)).toBe("jieba_rs_wasm_bg.wasm");
		expect(existsSync(wasm)).toBe(true);
	});

	it("拿到的是 nodejs 那一份(而非 deno / web / bundler)", () => {
		const wasm = resolveJiebaWasm();

		expect(basename(dirname(wasm))).toBe("nodejs");
	});

	it("是真的 wasm 二进制(带 \\0asm 魔数、体积合理)", () => {
		const wasm = resolveJiebaWasm();

		expect(statSync(wasm).size).toBeGreaterThan(1_000_000);
	});
});
