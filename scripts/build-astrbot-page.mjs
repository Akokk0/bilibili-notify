import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
// 默认产物目录是仓库内 checkin 路径；测试经 BN_ASTRBOT_PAGE_OUT_DIR 改写到临时目录，
// 通过 vite 的 --outDir 覆盖默认 outDir，避免 emptyOutDir 清空真实产物时与
// 其它并行测试撞车。统一解析成绝对路径，vite 与本脚本 strip 用同一目标。
const outDir = process.env.BN_ASTRBOT_PAGE_OUT_DIR
	? resolve(process.env.BN_ASTRBOT_PAGE_OUT_DIR)
	: resolve(repoRoot, "astrbot/core/pages/dashboard");
const targetIndex = resolve(outDir, "index.html");

await runCommand(
	"vp",
	["run", "-F", "@bilibili-notify/astrbot-page", "build", "--outDir", outDir],
	repoRoot,
);
await access(targetIndex);
await stripCrossoriginAttributes(targetIndex);
console.log(`built AstrBot dashboard page -> ${targetIndex}`);

async function stripCrossoriginAttributes(htmlPath) {
	const html = await readFile(htmlPath, "utf8");
	// AstrBot 把 Plugin Page 放进无 allow-same-origin 的沙箱 iframe（Origin: null），
	// Vite 注入的 crossorigin 会强制走 CORS 被浏览器拦成 blocked:origin，构建后剥掉。
	// 仅处理 index.html 的静态 crossorigin。当前页面是单 JS chunk、无 code-split，运行时
	// 不会注入 <link rel=modulepreload crossorigin>；一旦引入 React.lazy / 动态 import 产生
	// lazy chunk，需另行关闭运行时注入的 crossorigin（如 vite build.modulePreload）。
	const stripped = html.replace(/\s+crossorigin(?:="[^"]*")?/g, "");
	if (stripped !== html) {
		await writeFile(htmlPath, stripped, "utf8");
	}
}

async function runCommand(command, args, cwd) {
	await new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			cwd,
			stdio: "inherit",
			env: process.env,
		});
		child.on("error", rejectPromise);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolvePromise(undefined);
				return;
			}
			rejectPromise(
				new Error(
					`${command} ${args.join(" ")} failed with code ${code ?? "null"} signal ${signal ?? "null"}`,
				),
			);
		});
	});
}
