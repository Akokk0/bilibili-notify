/**
 * 构建后自检:devtools 不许进构建产物。
 *
 * devtools(server 的 `src/devtools/`、web 的 `src/devtools/`)只在开发版**源码**上跑。
 * 两边各有一层结构性的隔离(server:vite.config 把入口换成空桩;web:`import.meta.env.DEV`
 * 死枝 + 隔离守卫测试)—— 这个脚本是那层之外的兜底:直接 grep 产物,找几串只在 devtools
 * 源码里出现的字面量。隔离哪天被谁绕过了,构建当场红,而不是等镜像发出去。
 *
 * 标记挑的是 devtools **运行时用到的字符串**(场景 id、只有假观众才叫的名字),不是标识符:
 * 标识符会被压缩改名,未用的常量会被摇掉,都可能造成假绿。判定在 findDevtoolsLeaks,纯函数。
 *
 * 用法:node scripts/check-no-devtools.mjs <server|web> <产物目录>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 每一侧的标记与「它只该在哪儿出现」的说明。改 devtools 场景 id 时记得对着 grep 一遍,
 * 这里的每一串都得仍然只在 devtools 源码里出现 —— 否则要么漏检(串没了)、要么误报(串跑到
 * 正式代码里了)。
 */
export const MARKERS = {
	server: ['"update.state"', '"push.capture"', '"live.danmaku"', "假观众"],
	web: ["全部收摊", '"/api/dev"', "浏览器里跑"],
};

const SCANNED_EXTS = new Set([".js", ".mjs", ".cjs"]);

export function findDevtoolsLeaks(files, markers) {
	const leaks = [];
	for (const { path, content } of files) {
		for (const marker of markers) {
			if (content.includes(marker)) leaks.push({ path, marker });
		}
	}
	return leaks;
}

export function formatReport(leaks) {
	const lines = leaks.map((l) => `  ${l.path}: 含 ${l.marker}`);
	return [
		"构建产物里发现 devtools 的痕迹 —— devtools 只许在开发版源码上跑,不许进任何构建产物:",
		...lines,
		"server 侧看 apps/server/vite.config.ts 的 stubDevtools;web 侧看 App.tsx 的 DEV 三元与 devtools-isolation 测试。",
	].join("\n");
}

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			yield* walk(full);
		} else if (SCANNED_EXTS.has(full.slice(full.lastIndexOf(".")))) {
			yield full;
		}
	}
}

export function scanDir(dir) {
	// 报告里用相对路径:绝对路径既长,又会把本机目录名带进 CI 日志。
	return [...walk(dir)].map((path) => ({
		path: relative(process.cwd(), path),
		content: readFileSync(path, "utf8"),
	}));
}

function main(argv) {
	const [side, dirArg] = argv;
	const markers = MARKERS[side];
	if (!markers || !dirArg) {
		console.error("用法:node scripts/check-no-devtools.mjs <server|web> <产物目录>");
		return 2;
	}
	const dir = resolve(dirArg);
	const leaks = findDevtoolsLeaks(scanDir(dir), markers);
	if (leaks.length > 0) {
		console.error(formatReport(leaks));
		return 1;
	}
	console.log(`check-no-devtools: ${side} 产物 ${dirArg} 里没有 devtools 的痕迹`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main(process.argv.slice(2));
}
