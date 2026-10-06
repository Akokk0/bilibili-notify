import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试临时目录改道。根 vite.config.ts 在加载时调 `redirectTestTmpDir()`(只在跑测试时)。
//
// 为什么:测试里两百多处 `mkdtemp(join(tmpdir(), "bn-…"))`,有的不清理、有的清理了仍然漏;
// vitest 自己的转换缓存也建在 `tmpdir()` 下,运行被打断就留下几十 MB。两样加起来把系统临时目录
// 撑到过十几 GB。它们都经 `os.tmpdir()` 定位,而 `os.tmpdir()` 每次调用都现读环境变量 ——
// 所以不逐处去改,只在入口把这次运行的临时目录指到一个专属目录:
//
//   <系统临时目录>/bn-test/run-<主进程号>/
//
// - 正常跑完:主进程退出时整个删掉,系统临时目录零残留。
// - 被打断(超时、手动中断、被杀):留下的目录下次开跑时清掉。归属判据是**目录名里的进程号还在不在**,
//   不看年龄也不猜目录结构:并行跑着的另一次运行进程还活着,不会被误删;`bn-test/` 之外的东西一概不碰。
//   进程号被系统重用时,那个残留目录会多活到新进程结束,不会误删。
// - 工作进程继承环境变量,所以它们的 `tmpdir()` 也落在这里;环境里的归属标记防止任何一层再改一次道。

const RUN_DIR = /^run-(\d+)$/;

export const runDirName = (pid) => `run-${pid}`;

/** 这个进程号现在还有没有进程。没有权限发信号(EPERM)也说明它在。 */
export function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

/**
 * 清掉 `base` 下进程已经不在的运行目录,回被删的目录名。只认 `run-<数字>` 这种名字的**目录**;
 * 自己那个(`self`)不删。
 */
export function sweepStaleRuns(base, { isAlive = isProcessAlive, self } = {}) {
	let entries;
	try {
		entries = readdirSync(base, { withFileTypes: true });
	} catch {
		return [];
	}
	const removed = [];
	for (const entry of entries) {
		const match = RUN_DIR.exec(entry.name);
		if (!match || !entry.isDirectory()) continue;
		const pid = Number(match[1]);
		if (pid === self || isAlive(pid)) continue;
		try {
			rmSync(join(base, entry.name), { recursive: true, force: true });
			removed.push(entry.name);
		} catch {
			// 删不掉(别的进程正占着、权限)就留给下一次,不让它挡住这次运行。
		}
	}
	return removed;
}

/**
 * 把这次运行的临时目录指到 `<base>/run-<pid>/`,回那个目录;已经改过道(环境里有归属标记)就什么都不做、回 undefined。
 * 顺手清掉以前被打断的运行留下的目录,并登记主进程退出时删掉自己的。
 */
export function redirectTestTmpDir({
	base = join(tmpdir(), "bn-test"),
	pid = process.pid,
	env = process.env,
	proc = process,
	isAlive = isProcessAlive,
} = {}) {
	if (env.BN_TEST_TMP_OWNER) return undefined;
	sweepStaleRuns(base, { isAlive, self: pid });
	const dir = join(base, runDirName(pid));
	mkdirSync(dir, { recursive: true });
	// POSIX 认 TMPDIR,Windows 先认 TEMP 再认 TMP。
	env.TMPDIR = dir;
	env.TMP = dir;
	env.TEMP = dir;
	env.BN_TEST_TMP_OWNER = String(pid);
	proc.on("exit", () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// 退出时删不掉就留给下一次开跑的清扫。
		}
	});
	return dir;
}
