import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 桌面产物的布局**只声明一次** —— `apps/desktop/layout.json`。
 *
 * 以前它被手写了四份:生产端(prepare-resources.mjs 摆文件)、外壳(main.rs 决定起哪个
 * 入口、去哪找 dashboard)、和两个发版闸(assert-*-desktop-artifact)。四份里改动一份
 * 的症状是**本地全绿、只有打 tag 那天才炸**,而 macOS 那条闸只查文件存在、连炸都不炸。
 *
 * 现在生产端和两个闸都读这份 JSON;外壳那边 Rust 读不到它(不想为此引一个 build.rs),
 * 所以留字面量,由 `desktop-release-gates.mjs` 核对它和这份声明说的是同一套 ——
 * 那是唯一一对没法共用同一份运行时的消费者。
 */

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LAYOUT_FILE = "apps/desktop/layout.json";

/**
 * 读出布局并校验它**自洽**:`requiredUnderResources` 里那几条路径必须真的是
 * serverDir / libDir / entry / webDistDir 拼出来的。
 *
 * 校验这一步是必要的 —— 那份清单是给闸脚本逐条 `Test-Path` 用的字面量(bash 和
 * PowerShell 里现拼路径太难读),所以声明内部有冗余,而冗余就得有人盯着。
 */
export function parseDesktopLayout(text) {
	const layout = JSON.parse(text);
	for (const key of ["serverDir", "libDir", "entry", "webDistDir"]) {
		if (typeof layout[key] !== "string" || layout[key] === "") {
			throw new Error(`${LAYOUT_FILE}: 缺少字段 ${key}`);
		}
	}
	const libPath = `${layout.serverDir}/${layout.libDir}`;
	const must = [`${libPath}/${layout.entry}`, `${libPath}/${layout.webDistDir}/index.html`];
	for (const rel of must) {
		if (!layout.requiredUnderResources.includes(rel)) {
			throw new Error(`${LAYOUT_FILE}: requiredUnderResources 少了 ${rel}`);
		}
	}
	return layout;
}

export function readDesktopLayoutFile(root = repoRoot) {
	return parseDesktopLayout(readFileSync(join(root, LAYOUT_FILE), "utf8"));
}
