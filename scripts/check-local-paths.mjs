/**
 * pre-commit 守卫:拦下混进仓库的本机绝对路径。
 *
 * 2026-08-27 blive 的探针脚本把当时那份 checkout 的绝对路径写死进了源码,仓库搬家后
 * 它静默去读旧目录的登录态,一周多才被巡查照出来。凭据之外,这类路径也没有任何理由
 * 进入公开仓库。
 *
 * lefthook 的 pre-commit 把暂存文件名喂进来;内容从暂存区读,不读工作树 —— 提交进
 * 历史的是暂存的那份。判定在 findLocalPaths,纯函数,可单测。
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

/**
 * 一次 `git cat-file --batch` 读完全部暂存内容:N 个文件一个进程,而不是 N 次 `git show`
 * (单次 ≈ 9 ms,百来个文件的提交就是秒级)。maxBuffer 不设上限 —— 大文件不能因此掉出扫描集。
 * git 自己报错(索引损坏等)时进程非零退出,execFileSync 直接抛:守卫读不到就放行等于没有守卫。
 */
function gitCatFileBatch(specs) {
	return execFileSync("git", ["cat-file", "--batch"], {
		input: `${specs.join("\n")}\n`,
		stdio: ["pipe", "pipe", "inherit"],
		maxBuffer: Infinity,
	});
}

/**
 * 暂存区里每个文件的内容,按 `--batch` 的输出格式切:`<oid> blob <size>\n<内容>\n`,
 * 不在暂存区(已删除)的是 `<spec> missing\n`。二进制(含 NUL)与不在暂存区的跳过。
 * `run` 可注入,单测不真跑 git。
 */
export function readStagedAll(paths, run = gitCatFileBatch) {
	if (paths.length === 0) return [];
	const out = run(paths.map((path) => `:${path}`));
	const files = [];
	let offset = 0;
	for (const path of paths) {
		const nl = out.indexOf(0x0a, offset);
		if (nl === -1) throw new Error(`git cat-file 的输出在 ${path} 处截断`);
		const header = out.subarray(offset, nl).toString("utf8");
		offset = nl + 1;
		if (header.endsWith(" missing")) continue;
		const size = Number(header.slice(header.lastIndexOf(" ") + 1));
		if (!Number.isInteger(size)) throw new Error(`git cat-file 的头看不懂:${header}`);
		if (out.length < offset + size) throw new Error(`git cat-file 的输出在 ${path} 处截断`);
		const body = out.subarray(offset, offset + size);
		offset += size + 1; // 内容后面跟一个换行
		if (body.includes(0)) continue;
		files.push({ path, content: body.toString("utf8") });
	}
	return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const report = formatReport(findLocalPaths(readStagedAll(process.argv.slice(2))));
	if (report) {
		console.error(report);
		process.exit(1);
	}
}
