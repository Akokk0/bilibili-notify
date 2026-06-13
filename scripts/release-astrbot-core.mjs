import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// 把 astrbot/core 作为单个 squash 提交发布到独立插件仓。发布内容是**工作目录**的
// 完整插件(含 gitignored 的构建产物 sidecar/app + pages/dashboard),不是 git tree
// —— 插件运行依赖这些产物。复刻原 sync 的拷贝/排除语义,外面再套一层 git push:
// fetch 远程分支当父,叠加一个干净快照(非 force),首次为根提交。AstrBot 插件市场可
// 把独立仓当普通仓拉取与更新。

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const DEFAULT_REMOTE = "https://github.com/Akokk0/astrbot_plugin_bilibili_notify.git";
const DEFAULT_BRANCH = "main";
// gitignored 但插件运行必需的构建产物;缺则要求先 build。
const REQUIRED_ARTIFACTS = ["sidecar/app/index.mjs", "pages/dashboard/index.html"];

// vp run <script> -- <args> 会把分隔符 `--` 一起转发;parseArgs 见 `--` 会把其后的具名选项
// (如 --dry-run)误判为 positional 而失效 —— 曾导致一次本应 dry-run 的调用真的推送。剥掉
// `--` 再解析,并宽容其余意外 positional(脚本只读具名选项)。
const forwardedArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const parsed = parseArgs({
	args: forwardedArgs,
	options: {
		remote: { type: "string" },
		branch: { type: "string" },
		source: { type: "string" },
		message: { type: "string" },
		reset: { type: "boolean" },
		"dry-run": { type: "boolean" },
	},
	allowPositionals: true,
});
const remote = parsed.values.remote ?? process.env.ASTRBOT_RELEASE_REMOTE ?? DEFAULT_REMOTE;
const branch = parsed.values.branch ?? DEFAULT_BRANCH;
const sourceDir = parsed.values.source
	? resolve(parsed.values.source)
	: resolve(repoRoot, "astrbot/core");
const dryRun = parsed.values["dry-run"] ?? false;

for (const artifact of REQUIRED_ARTIFACTS) {
	if (!existsSync(join(sourceDir, artifact))) {
		console.error(`缺少构建产物 ${artifact}(在 ${sourceDir}),请先运行 vp run build:astrbot`);
		process.exit(1);
	}
}

// 运行态/缓存/git 元数据不进发布;其余(含 sidecar/app、pages/dashboard)全部发布。
function shouldSkip(path) {
	const rel = relative(sourceDir, path).split("\\").join("/");
	if (!rel) return false;
	const seg = rel.split("/");
	const base = seg[seg.length - 1];
	// 不发布任何 .gitignore —— monorepo 开发用的 ignore 规则(如 sidecar/app/)会让发布仓
	// 忽略自己已发布的构建产物,在临时 staging 仓里直接导致 git add 漏掉 sidecar bundle。
	if (base === ".gitignore") return true;
	// Python/日志缓存产物(任何层级):后续 git add -f 会无视 .gitignore,故须显式排除。
	if (/\.(py[cod]|log)$/.test(base)) return true;
	// 缓存/虚拟环境/git 目录(任何层级,不止顶层 —— 如 tests/__pycache__)。
	const CACHE_DIRS = [
		".git",
		"__pycache__",
		".pytest_cache",
		".ruff_cache",
		".mypy_cache",
		".venv",
	];
	if (seg.some((s) => CACHE_DIRS.includes(s))) return true;
	// sidecar 运行态(保留 app 产物)。
	if (seg[0] === "sidecar" && ["cache", "state", "logs"].includes(seg[1])) return true;
	return false;
}

function git(args, opts = {}) {
	const out = execFileSync("git", args, { encoding: "utf8", ...opts });
	return out == null ? "" : out.trim();
}

const reset = parsed.values.reset ?? false;

let sourceSha = "unknown";
try {
	sourceSha = git(["rev-parse", "--short", "HEAD"], { cwd: repoRoot });
} catch {
	sourceSha = "unknown";
}
const message = parsed.values.message ?? `release: astrbot/core from monorepo @ ${sourceSha}`;

// 用 monorepo 的 git 身份署名(即维护者本人);CI 等无 git 身份的环境回退到中性默认。
let authorName = "bilibili-notify release";
let authorEmail = "release@bilibili-notify.local";
try {
	authorName = git(["config", "user.name"], { cwd: repoRoot }) || authorName;
	authorEmail = git(["config", "user.email"], { cwd: repoRoot }) || authorEmail;
} catch {
	// 无 git 身份 → 保留中性默认
}

const staging = mkdtempSync(join(tmpdir(), "bn-astrbot-release-"));
const work = join(staging, "plugin");
try {
	cpSync(sourceDir, work, { recursive: true, filter: (p) => !shouldSkip(p) });

	const g = (args, opts = {}) => git(args, { cwd: work, ...opts });
	g(["init", "-q", "-b", branch]);
	g(["remote", "add", "origin", remote]);

	// 默认:远程已有该分支 → 以其 tip 为父,叠加干净快照(非 force);首次无远程 → 根提交。
	// --reset:跳过取父,造无父根提交并 force 覆盖远程(用于把首发历史重置成单个干净提交)。
	let parentRef = "";
	if (!reset) {
		try {
			g(["fetch", "-q", "--depth=1", "origin", branch], { stdio: "pipe" });
			parentRef = g(["rev-parse", "FETCH_HEAD"]);
		} catch {
			parentRef = "";
		}
	}

	// -f:强制无视任何残留 ignore 规则,确保 cp 进来的构建产物都进发布。
	g(["add", "-A", "-f"]);
	if (parentRef) g(["reset", "-q", "--soft", parentRef]);
	g([
		"-c",
		`user.name=${authorName}`,
		"-c",
		`user.email=${authorEmail}`,
		"commit",
		"-q",
		"-m",
		message,
		"--allow-empty",
	]);

	const head = g(["rev-parse", "HEAD"]);
	console.log(`source=${sourceSha} parent=${parentRef || "(none — root commit)"}`);
	console.log(`author=${authorName} <${authorEmail}>`);
	console.log(`commit=${head} message="${message}"`);
	console.log(`remote=${remote} branch=${branch}${reset ? " (reset/force)" : ""}`);

	const pushArgs = ["push"];
	if (reset) pushArgs.push("--force");
	pushArgs.push("origin", `HEAD:refs/heads/${branch}`);

	if (dryRun) {
		console.log(`[dry-run] skip push; would run: git ${pushArgs.join(" ")}`);
	} else {
		g(pushArgs, { stdio: "inherit" });
		console.log(`pushed astrbot/core snapshot -> ${remote} (${branch})`);
	}
} finally {
	rmSync(staging, { recursive: true, force: true });
}
