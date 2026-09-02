// 桌面产物的布局**只声明一次**:`apps/desktop/layout.json`。
//
// 生产端(apps/desktop/scripts/prepare-resources.mjs)按它摆文件,两个发版闸
// (.github/scripts/assert-*-desktop-artifact.*)按它查文件 —— 都是运行时读同一份 JSON,
// 不会飘。**外壳(apps/desktop/src-tauri/src/main.rs)是唯一读不到它的那个**:为一份
// 三行的路径声明引一个 build.rs 不值当,所以那边留字面量,由这里核对两者说的是同一套。
//
// 这份守卫存在的理由,是 2026-09-02 那次真事:外壳改跑 boot.mjs、dashboard 挪进
// lib/web-dist,而两个闸脚本一行没动 —— 本地门禁全绿,macOS 那条只查文件存在照样绿,
// 只有打 tag 那天 Windows 那条才红。
//
// 只导出纯函数,由 desktop-release-gates.test.mjs 先用合成文本红绿跑透,再对真实仓库跑一发。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT_FILE, readDesktopLayoutFile, repoRoot } from "./desktop-layout.mjs";

export { repoRoot };

export const DESKTOP_GATE_FILES = {
	mainRs: "apps/desktop/src-tauri/src/main.rs",
	windows: ".github/scripts/assert-windows-desktop-artifact.ps1",
	macos: ".github/scripts/assert-macos-desktop-artifact.sh",
	/** 真正**摆文件**的那一个。以前它一次都没被审过 —— 它挪一下,闸和外壳全绿,产物是坏的。 */
	producer: "apps/desktop/scripts/prepare-resources.mjs",
};

/**
 * 外壳自己说的布局:`server_dir.join("lib").join("<entry>")` 与同级的 web-dist 目录。
 * 读不出来就抛 —— 那说明 main.rs 换了写法,这份守卫也得跟着改,不该静默放过。
 */
export function readShellLayout(mainRs) {
	const entry = mainRs.match(/server_dir\s*\.join\("([^"]+)"\)\s*\.join\("([^"]+\.mjs)"\)/);
	if (!entry) throw new Error('main.rs 里找不到 server_dir.join("lib").join("<entry>.mjs")');
	const webDist = mainRs.match(
		/server_dir\s*\.join\("[^"]+"\)\s*\.join\("([^"]+)"\)\s*;\s*\n[^\n]*is_file\(\)/,
	);
	return {
		libDir: entry[1],
		entry: entry[2],
		webDistDir: webDist ? webDist[1] : null,
		passesWebDistFlag: /"--web-dist"/.test(mainRs),
	};
}

/** ps1 与 sh 的行注释都是 `#`。只看代码 —— 注释里解释「为什么不传 --web-dist」不该算传了。 */
function stripLineComments(script) {
	return script
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
}

/**
 * 核对一份闸脚本:它必须**读那份声明**,而不是自己抄一份路径。
 *
 * 抄一份的问题不是难看,是它可以静静地落后 —— 而两个闸脚本一个只在 Windows 跑、
 * 一个只查文件存在,落后了都不会在日常门禁里露面。
 */
function auditGateScript(label, raw, layout) {
	const script = stripLineComments(raw);
	const problems = [];
	if (!script.includes(LAYOUT_FILE)) {
		problems.push(`${label}: 没有读 ${LAYOUT_FILE} —— 布局只能有一份声明,别在闸里自己抄`);
	}
	// 抄回来的样子:硬编码的 `app/apps/server/lib/…`。声明里那几条路径长这样,
	// 所以脚本里再出现同样的前缀,就说明有人把清单又抄回去了。
	const hardcoded = `${layout.serverDir}/${layout.libDir}/`;
	if (script.includes(hardcoded)) {
		problems.push(`${label}: 又把 ${hardcoded}… 硬编码回去了,应该从 ${LAYOUT_FILE} 读`);
	}
	if (!layout.passesWebDistFlag && script.includes("--web-dist")) {
		problems.push(`${label}: 外壳已不再传 --web-dist,冒烟也不能传(否则测的是用户跑不到的路径)`);
	}
	return problems;
}

/** 外壳(留字面量的那一个)与声明说的是不是同一套。 */
function auditShell(mainRs, layout) {
	const shell = readShellLayout(mainRs);
	const problems = [];
	if (shell.entry !== layout.entry) {
		problems.push(`main.rs: 外壳起 ${shell.entry},声明写的是 ${layout.entry}`);
	}
	if (shell.libDir !== layout.libDir) {
		problems.push(`main.rs: 外壳的 lib 目录是 ${shell.libDir},声明写的是 ${layout.libDir}`);
	}
	if (shell.webDistDir !== layout.webDistDir) {
		problems.push(
			`main.rs: 外壳找 dashboard 于 ${shell.webDistDir},声明写的是 ${layout.webDistDir}`,
		);
	}
	if (shell.passesWebDistFlag !== layout.passesWebDistFlag) {
		problems.push(
			`main.rs: 传不传 --web-dist 与声明不一致(外壳 ${shell.passesWebDistFlag} / 声明 ${layout.passesWebDistFlag})`,
		);
	}
	return problems;
}

/**
 * 生产端(JS)照规矩办 = **import 那份声明**,而不是自己写 `"web-dist"` / `"boot.mjs"`。
 * 它和闸脚本的区别只在怎么读:shell 里是路径字面量,JS 里是一个 import。
 */
function auditProducer(raw, layout) {
	const script = raw
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n");
	const problems = [];
	if (!script.includes("desktop-layout.mjs")) {
		problems.push(`producer: 没有读那份布局声明 —— 摆文件的和找文件的必须同源`);
	}
	for (const literal of [layout.entry, layout.webDistDir]) {
		if (script.includes(`"${literal}"`)) {
			problems.push(`producer: 又把 "${literal}" 写死了,应该从 ${LAYOUT_FILE} 读`);
		}
	}
	return problems;
}

export function auditDesktopGates({ mainRs, windows, macos, producer, layout }) {
	return [
		...auditShell(mainRs, layout),
		...auditGateScript("windows", windows, layout),
		...auditGateScript("macos", macos, layout),
		...auditProducer(producer, layout),
	];
}

export function auditRepoDesktopGates(root = repoRoot) {
	const read = (rel) => readFileSync(join(root, rel), "utf8");
	return auditDesktopGates({
		mainRs: read(DESKTOP_GATE_FILES.mainRs),
		windows: read(DESKTOP_GATE_FILES.windows),
		macos: read(DESKTOP_GATE_FILES.macos),
		producer: read(DESKTOP_GATE_FILES.producer),
		layout: readDesktopLayoutFile(root),
	});
}
