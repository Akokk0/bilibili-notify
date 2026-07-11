// 发版闸门:这次 push 有没有改动 koishi 插件的版本号?
//
// 发版触发是「push dev 且 koishi/package.json 的 version 变了」。判据必须是 **version
// 字段本身**,不能是「koishi/package.json 这个文件变了」—— 那个文件被 `vp pack`
// (exports: true)自动回写,每次构建都可能刷新 `inlinedDependencies` / `exports`。
// 拿文件变动当信号,等于每次构建都发一版。
//
// 本脚本只是**省 CI 的快速门**,不是安全闸:workflow 重跑时 `github.event.before` 没变,
// 这里照样会判 changed。真正兜底的是 `scripts/publish.mjs` 的 registry 幂等(发布前问
// 一次 npm,版本已存在就跳过)。所以这里拿不准时一律放行,让第二道去把关 —— 漏发能人工
// 补,误发撤不回来,而误发那条路已经被第二道堵死。

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { argv, env } from "node:process";
import { pathToFileURL } from "node:url";

const PKG_PATH = "koishi/package.json";
const PKG_JSON = new URL("../koishi/package.json", import.meta.url);

/** git 的空树 sha:首次 push 分支 / force push 后 `github.event.before` 就是它。 */
const ZERO_SHA = "0000000000000000000000000000000000000000";

/**
 * 从 package.json 文本里取 version。
 *
 * @param {string} jsonText
 * @returns {string | null} 解析失败或没有 version 时 null —— 读不出来就不是一次可信的比较。
 */
export function versionOf(jsonText) {
	try {
		const v = JSON.parse(jsonText)?.version;
		return typeof v === "string" && v.length > 0 ? v : null;
	} catch {
		return null;
	}
}

/**
 * 发不发?
 *
 * @param {{ before: string | null; after: string | null }} versions
 * @returns {{ changed: boolean; reason: string }}
 */
export function decide({ before, after }) {
	if (after === null) {
		return { changed: false, reason: `读不出当前 ${PKG_PATH} 的 version —— 异常状态,不发。` };
	}
	if (before === null) {
		return {
			changed: true,
			reason: `拿不到基线版本(首次 push / force push?)—— 放行,交给 registry 幂等把关。`,
		};
	}
	if (before === after) {
		return { changed: false, reason: `版本号未变(${after})—— 不发。` };
	}
	return { changed: true, reason: `版本号 ${before} → ${after} —— 发。` };
}

/** 取某个 commit 上的 koishi 版本号;该 commit 取不到(空 sha / 浅克隆)时返回 null。 */
function versionAt(sha) {
	if (!sha || sha === ZERO_SHA) return null;
	try {
		const out = execFileSync("git", ["show", `${sha}:${PKG_PATH}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return versionOf(out);
	} catch {
		return null;
	}
}

function main() {
	const before = versionAt(argv[2] ?? env.GITHUB_EVENT_BEFORE);
	const after = versionOf(readFileSync(PKG_JSON, "utf8"));
	const { changed, reason } = decide({ before, after });

	console.log(`[version-gate] ${reason}`);
	if (env.GITHUB_OUTPUT) {
		appendFileSync(env.GITHUB_OUTPUT, `changed=${changed}\nversion=${after ?? ""}\n`);
	}
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
	main();
}
