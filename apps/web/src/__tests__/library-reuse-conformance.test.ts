/// <reference types="node" />
/**
 * 「组件库里有的不许重写」的静态守卫。
 *
 * `packages/ui/README.md` 开头就写着「写任何 UI 之前先扫一遍清单」,但清单是**给人看的**
 * —— 没有任何东西拦下一次手搓。而手搓件在默认装下和库件长得几乎一样,构建绿、类型绿、
 * 渲染测试也绿:它只在**换肤**或**改库件**的时候露馅 —— 库里改了一版圆角/字号/间距,
 * 手搓的那几份原地不动,同一个意思散成四五种长相。
 *
 * `EmptyNote` 的注释里记着这件事已经发生过一次:收编前站内手写了九份,在四种圆角三种
 * 字号之间漂。收编之后没有护栏,于是又漂出了第二波。这个文件就是那道护栏。
 *
 * 每条规则都带**写明理由**的豁免表:表里写了却已经改完的文件也要报,否则豁免条目会
 * 一直挂着骗人。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(TEST_DIR, "..");
const UI_SRC_DIR = join(SRC_DIR, "../../../packages/ui/src");

function listTsxRecursive(dir: string): string[] {
	const acc: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) acc.push(...listTsxRecursive(full));
		else if (full.endsWith(".tsx") && !full.includes("__tests__")) acc.push(full);
	}
	return acc;
}

/** 注释行不算数 —— 讲的往往正是「以前手搓成什么样」。 */
function codeOf(line: string): string {
	return line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
}

function rel(file: string): string {
	return file.replace(/^.*?((apps|packages)\/)/, "$1");
}

/** 扫 web + ui 全部产品 .tsx,逐行套 `hit`,命中的报 `文件:行`。 */
function scan(hit: (code: string) => boolean, skipFiles: string[] = []): string[] {
	const found: string[] = [];
	for (const root of [join(SRC_DIR, "pages"), join(SRC_DIR, "components"), UI_SRC_DIR]) {
		for (const file of listTsxRecursive(root)) {
			if (skipFiles.some((s) => file.endsWith(s))) continue;
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (hit(codeOf(line))) found.push(`${rel(file)}:${i + 1}`);
				});
		}
	}
	return found;
}

describe("转圈只有库里那一份", () => {
	it("没有哪个页面自己拿 animate-spin 画转圈", () => {
		// `Spinner`(atoms.tsx)是唯一的实现,`LoadingBlock` 是唯一的「转圈 + 文案」组合。
		// 手搓一个的代价:Stats 的 AI 锐评卡曾自己画了个 8px 环并把顶弧涂成固定的 AI 紫
		// —— 那抹紫**刻意不跟皮肤**(config/colors.ts),于是整站换装后只有它原地不动。
		expect(scan((c) => /\banimate-spin\b/.test(c), ["atoms.tsx"]).join("\n")).toBe("");
	});
});
