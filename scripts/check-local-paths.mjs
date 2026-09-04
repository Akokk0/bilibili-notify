/**
 * pre-commit 守卫:拦下混进仓库的本机绝对路径。
 *
 * 2026-08-27 blive 的探针脚本把当时那份 checkout 的绝对路径写死进了源码,仓库搬家后
 * 它静默去读旧目录的登录态,一周多才被巡查照出来。凭据之外,这类路径也没有任何理由
 * 进入公开仓库。
 *
 * lefthook 的 pre-commit 把暂存文件名喂进来;内容从暂存区(`git show :path`)读,
 * 不读工作树 —— 提交进历史的是暂存的那份。判定在 findLocalPaths,纯函数,可单测。
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 用户名那一段:不含分隔符、引号、空白,也不含中文标点(注释里「/Users/、/home/ 两种」这种列举)。
const SEG = `[^/\\\\\\s"'\`、,，。]+`;
// 裸的家目录(用户名后面没有下一层)也拦:root 只写到用户名、后半段再 join() 拼上,正是那条
// 探针泄漏被重构一次之后的形状。`/users/:id` 这类路由串是小写、`/home` 后面没有用户名,天然不撞。
// Windows 路径大小写不敏感,盘符与 users 都按不敏感匹配。
const HOME_PATH = new RegExp(`/Users/${SEG}|/home/${SEG}|[A-Za-z]:\\\\[Uu]sers\\\\${SEG}`); // local-path-ok

/**
 * 行内(或紧挨着的上一行)写上它就放行 —— 给清洗函数的测试夹具这类刻意含家目录路径的行用。
 * 认上一行是因为 rustfmt 会把超宽行尾的注释挪到上一行去。
 */
export const ALLOW_MARKER = "local-path-ok";

export function findLocalPaths(files) {
	const problems = [];
	for (const { path, content } of files) {
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			const text = lines[i];
			if (text.includes(ALLOW_MARKER) || lines[i - 1]?.includes(ALLOW_MARKER)) continue;
			if (HOME_PATH.test(text)) problems.push({ path, line: i + 1, text });
		}
	}
	return problems;
}

export function formatReport(problems) {
	if (problems.length === 0) return "";
	const lines = problems.map((p) => `  ${p.path}:${p.line}: ${p.text.trim()}`);
	return [
		"本机绝对路径不许进仓库(macOS / Linux / Windows 家目录):",
		...lines,
		`改成按脚本自身位置解析或走环境变量;刻意为之的行(如测试夹具)在行内或上一行写上 ${ALLOW_MARKER} 放行。`,
	].join("\n");
}

function gitShow(path) {
	// maxBuffer 不设上限:默认 1 MiB,超过就 ENOBUFS —— 大文件不能因此从扫描集里掉出去。
	return execFileSync("git", ["show", `:${path}`], {
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: Infinity,
	});
}

/** `git show :path` 对「不在暂存区」的两种说法;别的失败都不是这一类。 */
const NOT_IN_INDEX = /not in the index|does not exist/;

/**
 * 暂存区里那份内容。不在暂存区(已删除)或是二进制 → null,跳过;其它读取失败一律抛 ——
 * 守卫读不到就放行,等于没有守卫。`run` 可注入,单测不真跑 git。
 */
export function readStaged(path, run = gitShow) {
	let buf;
	try {
		buf = run(path);
	} catch (err) {
		if (NOT_IN_INDEX.test(err?.stderr?.toString() ?? "")) return null;
		throw err;
	}
	if (buf.includes(0)) return null;
	return buf.toString("utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const files = [];
	for (const path of process.argv.slice(2)) {
		const content = readStaged(path);
		if (content !== null) files.push({ path, content });
	}
	const report = formatReport(findLocalPaths(files));
	if (report) {
		console.error(report);
		process.exit(1);
	}
}
