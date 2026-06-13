import { spawn } from "node:child_process";
import { copyFile, cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceDir = resolve(repoRoot, "astrbot/sidecar/dist");
const targetDir = resolve(repoRoot, "astrbot/core/sidecar/app");
const jsdomXhrSyncWorker = require.resolve("jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js");
const jiebaWasm = resolve(dirname(require.resolve("jieba-wasm/node")), "jieba_rs_wasm_bg.wasm");
// bundle 内联了 @bilibili-notify/image,词云模板运行时 readFileSync(resolve(__dirname,
// "static/*.js")) —— 装外 __dirname 指向 app/,故把 image 的 static 脚本随 bundle 搬进 app/static/。
// 用 monorepo 源路径(始终存在、与 lib/static 内容一致):require.resolve 对 workspace 包是 CJS
// 解析,CI 全新环境(无残留 lib/index.cjs)会 "Cannot find module" 致 build 失败。
const imageStaticDir = resolve(repoRoot, "packages/image/src/static");

await runCommand("vp", ["run", "-F", "@bilibili-notify/astrbot-sidecar", "build"], repoRoot);
await rm(targetDir, { recursive: true, force: true });
await cp(sourceDir, targetDir, { recursive: true });
await cp(imageStaticDir, resolve(targetDir, "static"), { recursive: true });
await copyFile(jsdomXhrSyncWorker, resolve(targetDir, "xhr-sync-worker.js"));
await copyFile(jiebaWasm, resolve(targetDir, "jieba_rs_wasm_bg.wasm"));

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
