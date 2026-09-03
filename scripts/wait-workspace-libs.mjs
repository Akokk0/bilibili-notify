/**
 * 等所有 workspace 内部包的 lib 产物**存在且稳定**后才退出 —— 给 `apps/server`
 * 的 dev 脚本当启动闸用。
 *
 * 为什么需要:根 `dev` 脚本虽然先跑了一轮预构建,但随后 `--parallel` 拉起的每个
 * `vp pack --watch` 在启动时会**删掉 lib 重建**(实测 index.mjs 有 ~0.7-1s 不存在,
 * 且首轮会闪两次)。tsx 冷启动恰好落在任何一个包的窗口里,就会
 * ERR_MODULE_NOT_FOUND(用户实际撞到的是 @bilibili-notify/contract)。十几个
 * watcher 同时首建,撞窗口概率很高 —— 所以 server 必须等产物全部落盘并静置后再起。
 *
 * 行为:
 *   - 扫 <root>/packages/* 与 <root>/apps/*,凡 package.json 的 exports["."]
 *     解析到 ./lib/ 下的 ESM 入口即纳入等待集(web/desktop 无 lib 出口,自动跳过)。
 *   - 轮询直到每个入口文件存在且 mtime 已静置 STABLE_MS(躲开删除→重写的抖动)。
 *   - 超时(TIMEOUT_MS)不阻死:打警告放行,让 tsx 报出真实的解析错误。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const STABLE_MS = 600;
const INTERVAL_MS = 150;
const TIMEOUT_MS = 30_000;

/** exports["."] 的 import 条件 → 相对包根的 ESM 入口路径;解析不到返回 null。 */
function esmEntryOf(manifest) {
	const dot = manifest?.exports?.["."];
	let entry = null;
	if (typeof dot === "string") entry = dot;
	else if (dot && typeof dot === "object") {
		const imp = dot.import;
		entry = typeof imp === "string" ? imp : (imp?.default ?? null);
	}
	return typeof entry === "string" && entry.startsWith("./lib/") ? entry : null;
}

function collectWaitSet() {
	const targets = [];
	for (const baseDir of [join(root, "packages"), join(root, "apps")]) {
		let entries;
		try {
			entries = readdirSync(baseDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const dirent of entries) {
			if (!dirent.isDirectory()) continue;
			const dir = join(baseDir, dirent.name);
			let manifest;
			try {
				manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			} catch {
				continue;
			}
			if (!manifest?.name?.startsWith("@bilibili-notify/")) continue;
			const entry = esmEntryOf(manifest);
			if (entry) targets.push({ name: manifest.name, file: join(dir, entry) });
		}
	}
	return targets;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = collectWaitSet();
const deadline = Date.now() + TIMEOUT_MS;
let waited = false;

for (;;) {
	const pending = targets.filter(({ file }) => {
		try {
			return Date.now() - statSync(file).mtimeMs < STABLE_MS;
		} catch {
			return true; // 不存在 → 未就绪
		}
	});
	if (pending.length === 0) break;
	if (Date.now() >= deadline) {
		console.warn(
			`[wait-libs] ${TIMEOUT_MS}ms 内以下产物仍未就绪,放行(后续解析错误即真实原因): ${pending
				.map((p) => p.name)
				.join(", ")}`,
		);
		break;
	}
	if (!waited) {
		waited = true;
		console.error(`[wait-libs] 等待 ${targets.length} 个 workspace lib 产物就位…`);
	}
	await sleep(INTERVAL_MS);
}

if (waited) console.error("[wait-libs] 产物已稳定,启动 server。");
