import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { platform } from "node:os";

/**
 * 浏览器进程子树的常驻内存(RSS)—— 概览页资源卡上「浏览器」那一行。
 *
 * chromium 是一棵树:一个 browser 进程 + 每个页面 / GPU / 网络各一个子进程,吃内存的
 * 大头在子进程上,只报父进程等于把最要紧的那部分漏掉。
 *
 * **为什么不用 `pidusage`**:它在 Windows 上走 `wmic`,而 Win11 24H2 已经默认移除了
 * wmic —— 桌面版会在那儿静默断掉。这里三平台各取各的:Linux 读 `/proc`(零子进程),
 * macOS 一次 `ps` 拿整表,Windows 一次 PowerShell 拿整表,然后共用同一个求和。
 */

export interface ProcRow {
	ppid: number;
	rss: number;
}

export type ProcTable = Map<number, ProcRow>;

/** `ps -axo pid=,ppid=,rss=` 的输出。rss 单位是 KB。 */
export function parsePsTable(text: string): ProcTable {
	const out: ProcTable = new Map();
	for (const line of text.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
		if (!m?.[1] || !m[2] || !m[3]) continue;
		out.set(Number(m[1]), { ppid: Number(m[2]), rss: Number(m[3]) * 1024 });
	}
	return out;
}

/** `Get-CimInstance Win32_Process | ConvertTo-Csv` 的输出。WorkingSetSize 本来就是字节。 */
export function parseWindowsProcessTable(text: string): ProcTable {
	const out: ProcTable = new Map();
	for (const line of text.split(/\r?\n/)) {
		const m = /^"?(\d+)"?\s*,\s*"?(\d+)"?\s*,\s*"?(\d+)"?\s*$/.exec(line.trim());
		if (!m?.[1] || !m[2] || !m[3]) continue;
		out.set(Number(m[1]), { ppid: Number(m[2]), rss: Number(m[3]) });
	}
	return out;
}

/**
 * `/proc/<pid>/status`:`PPid` 与 `VmRSS` 都在这一份里,一次读完。
 *
 * 刻意不用 `statm` / `stat` 里那个 rss —— 它报的是**页数**,换字节要知道页大小,而
 * ARM64 Linux 的页可以是 64K:按 4K 硬算会把 RSS 说大 16 倍。`status` 的单位写在行里。
 */
export function parseProcStatus(text: string): ProcRow | null {
	const ppid = /^PPid:\s+(\d+)$/m.exec(text)?.[1];
	const rssKb = /^VmRSS:\s+(\d+)\s*kB$/m.exec(text)?.[1];
	if (ppid === undefined || rssKb === undefined) return null;
	return { ppid: Number(ppid), rss: Number(rssKb) * 1024 };
}

/**
 * 根进程连同所有层级的子孙的 RSS 之和;根不在表里回 `null`。
 *
 * `null` 而不是 0 —— 0 在面板上会画成「浏览器占 0MB」,那是句假话;null 画成「—」。
 */
export function subtreeRss(table: ProcTable, rootPid: number): number | null {
	const root = table.get(rootPid);
	if (!root) return null;
	// 先按 ppid 建索引:逐个 pid 扫全表是 O(n²),几百个进程的机器上白烧 CPU。
	const children = new Map<number, number[]>();
	for (const [pid, row] of table) {
		const list = children.get(row.ppid);
		if (list) list.push(pid);
		else children.set(row.ppid, [pid]);
	}
	// 见过的 pid 不再展开 —— 父子关系成环(pid 回卷复用时会出现)也转得出来。
	const seen = new Set<number>([rootPid]);
	const stack = [rootPid];
	let total = 0;
	while (stack.length > 0) {
		const pid = stack.pop();
		if (pid === undefined) break;
		total += table.get(pid)?.rss ?? 0;
		for (const child of children.get(pid) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			stack.push(child);
		}
	}
	return total;
}

function run(cmd: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
			resolve(err ? null : stdout);
		});
	});
}

const POWERSHELL_QUERY =
	"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Csv -NoTypeInformation";

/** 取一次全表。取不到(命令缺失 / 超时 / 权限)回 null,由调用方显示「—」。 */
export async function readProcessTable(): Promise<ProcTable | null> {
	if (platform() === "win32") {
		const out = await run("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			POWERSHELL_QUERY,
		]);
		return out === null ? null : parseWindowsProcessTable(out);
	}
	const out = await run("ps", ["-axo", "pid=,ppid=,rss="]);
	return out === null ? null : parsePsTable(out);
}

/**
 * Linux 专用的零子进程路径:直接读 `/proc`。容器里 `ps` 常常压根没装,而每 10 秒起一次
 * 子进程本身也是笔开销。
 */
export async function readProcTableFromProcfs(deps: {
	listPids: () => Promise<string[]>;
	readStatus: (pid: number) => Promise<string | null>;
}): Promise<ProcTable> {
	const pids: number[] = [];
	for (const entry of await deps.listPids()) {
		if (/^\d+$/.test(entry)) pids.push(Number(entry));
	}
	// 几百个进程各读一份小文件:串行等于几百次往返,并发读一遍就完了。
	const rows = await Promise.all(
		pids.map(async (pid) => [pid, parseProcStatus((await deps.readStatus(pid)) ?? "")] as const),
	);
	const out: ProcTable = new Map();
	for (const [pid, row] of rows) {
		// 读的中途进程退掉是常态(尤其 chromium 的渲染进程),跳过就好。
		if (row !== null) out.set(pid, row);
	}
	return out;
}

export const procfsDeps = {
	listPids: (): Promise<string[]> => readdir("/proc"),
	readStatus: (pid: number) => readTextOrNull(`/proc/${pid}/status`),
};

async function readTextOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * 量一次「以 `rootPid` 为根的进程子树」的 RSS 合计。
 *
 * Linux 走 `/proc`(零子进程,容器里也常常没装 `ps`);macOS / Windows 各起一次进程拿全表。
 * 量不到(命令缺失、超时、权限、进程刚退)一律 null —— 面板画「—」,不画 0。
 */
export async function browserSubtreeRss(rootPid: number): Promise<number | null> {
	try {
		const table =
			platform() === "linux" ? await readProcTableFromProcfs(procfsDeps) : await readProcessTable();
		return table === null ? null : subtreeRss(table, rootPid);
	} catch {
		return null;
	}
}
