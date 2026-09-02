// 桌面发版闸(.github/scripts/assert-*-desktop-artifact.*)必须跟着外壳真正启动的
// 那套布局走 —— 外壳(apps/desktop/src-tauri/src/main.rs)决定起哪个入口、去哪儿找
// dashboard,而闸脚本是**手写**的一份复制品,布局一挪它就落后,而且 CI 上没有任何
// 东西会提醒:macOS 那条只查文件存在,照样绿;Windows 那条要到打 tag 那天才红。
//
// 这里把「闸脚本与外壳说的是同一套布局」写成可以在任何机器上跑的判定:从 main.rs
// 读出布局,再核对两个闸脚本有没有照着它写。
//
// 只导出纯函数,由 desktop-release-gates.test.mjs 先用合成文本红绿跑透,再对真实仓库跑一发。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DESKTOP_GATE_FILES = {
	mainRs: "apps/desktop/src-tauri/src/main.rs",
	windows: ".github/scripts/assert-windows-desktop-artifact.ps1",
	macos: ".github/scripts/assert-macos-desktop-artifact.sh",
};

/**
 * 外壳的布局:`server_dir.join("lib").join("<entry>")` 与 `server_dir.join("lib").join("web-dist")`。
 * 读不出来就抛 —— 那说明 main.rs 换了写法,这份守卫也得跟着改,不该静默放过。
 */
export function readDesktopLayout(mainRs) {
	const entry = mainRs.match(/server_dir\s*\.join\("lib"\)\s*\.join\("([^"]+\.mjs)"\)/);
	if (!entry) throw new Error('main.rs 里找不到 server_dir.join("lib").join("<entry>.mjs")');
	const webDist = mainRs.match(
		/server_dir\s*\.join\("lib"\)\s*\.join\("([^"]+)"\)\s*;\s*\n[^\n]*is_file\(\)/,
	);
	const passesWebDistFlag = /"--web-dist"/.test(mainRs);
	return {
		entry: entry[1],
		/** dashboard 相对 server 包根的位置(外壳做存在性检查的那个目录)。 */
		webDist: webDist ? `lib/${webDist[1]}` : null,
		passesWebDistFlag,
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
 * 核对一份闸脚本。返回问题列表,空 = 一致。
 *
 * - `entry`:脚本必须把外壳起的那个入口列进必需文件(它不在,产物就是坏的)。
 * - `webDist`:外壳只做存在性检查的目录,脚本同样得要求它在;它不在的话外壳会拒绝启动。
 * - `--web-dist`:外壳不传这个参数,冒烟也不能传 —— 传了就是在测一条**用户跑不到**的路径,
 *   而真正跑的那条(入口旁边就近找 dashboard)一次都没被验过。
 * - `smokeEntry`(仅 Windows,它真的会把服务端拉起来):冒烟起的入口必须就是外壳起的那个。
 */
export function auditDesktopGate({ label, script: raw, layout, smokes }) {
	const script = stripLineComments(raw);
	const problems = [];
	const serverLib = "app/apps/server/lib";
	const entryPath = `${serverLib}/${layout.entry}`;
	if (!script.includes(entryPath)) {
		problems.push(`${label}: 必需文件里没有外壳启动的入口 ${entryPath}`);
	}
	if (layout.webDist) {
		const webDistIndex = `app/apps/server/${layout.webDist}/index.html`;
		if (!script.includes(webDistIndex)) {
			problems.push(`${label}: 必需文件里没有外壳要求存在的 ${webDistIndex}`);
		}
	}
	if (!layout.passesWebDistFlag && script.includes("--web-dist")) {
		problems.push(`${label}: 外壳已不再传 --web-dist,冒烟也不能传(否则测的是用户跑不到的路径)`);
	}
	if (smokes) {
		const launched = script.match(/Join-Path \$serverDir "lib\/([^"]+\.mjs)"/);
		if (!launched) {
			problems.push(`${label}: 找不到冒烟启动的入口(Join-Path $serverDir "lib/<entry>")`);
		} else if (launched[1] !== layout.entry) {
			problems.push(`${label}: 冒烟起的是 lib/${launched[1]},外壳起的是 lib/${layout.entry}`);
		}
	}
	return problems;
}

export function auditDesktopGates({ mainRs, windows, macos }) {
	const layout = readDesktopLayout(mainRs);
	return [
		...auditDesktopGate({ label: "windows", script: windows, layout, smokes: true }),
		...auditDesktopGate({ label: "macos", script: macos, layout, smokes: false }),
	];
}

export function auditRepoDesktopGates(root = repoRoot) {
	const read = (rel) => readFileSync(join(root, rel), "utf8");
	return auditDesktopGates({
		mainRs: read(DESKTOP_GATE_FILES.mainRs),
		windows: read(DESKTOP_GATE_FILES.windows),
		macos: read(DESKTOP_GATE_FILES.macos),
	});
}
