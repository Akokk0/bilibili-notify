import type { Dirent } from "node:fs";
import { access, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { TEMP_MARKER } from "./atomic-file";
import { OLD_MARKER } from "./replace-directory";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 原子写与整目录替换的临时名:`<名>.bn-tmp.<pid>.<十六进制>`(见 atomic-file 的 tempPathFor)。 */
const TEMP_NAME = new RegExp(`${escapeRegExp(TEMP_MARKER)}\\d+\\.[0-9a-f]+$`);
/** 整目录替换换下来的旧目录:`<名>.bn-old.<pid>.<十六进制>`(见 replace-directory)。 */
const OLD_NAME = new RegExp(`^(.+)${escapeRegExp(OLD_MARKER)}\\d+\\.[0-9a-f]+$`);

export interface SweepReport {
	/** 删掉的临时文件、暂存目录与多余的旧目录。 */
	removed: string[];
	/** 换到一半、挪回原位的旧目录(挪回后的路径)。 */
	restored: string[];
}

/**
 * 开机清扫:从 root 往下,删掉上个进程被杀时留下的临时文件与暂存目录;整目录替换换到一半
 * 留下的旧目录,目标不在就挪回去、在就删掉。别的文件一概不碰,不跟进符号链接。
 *
 * 必须在任何写入开始之前跑:它认不出哪些临时文件是这个进程正在写的
 * (Docker 里每次开机 pid 常常一样,不能靠 pid 区分)。
 */
export async function sweepTempFiles(root: string): Promise<SweepReport> {
	const report: SweepReport = { removed: [], restored: [] };
	await sweepDir(root, report);
	return report;
}

async function sweepDir(dir: string, report: SweepReport): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (TEMP_NAME.test(entry.name)) {
			await rm(path, { recursive: true, force: true });
			report.removed.push(path);
			continue;
		}
		const old = OLD_NAME.exec(entry.name);
		if (old) {
			const target = join(dir, old[1] as string);
			if (await exists(target)) {
				await rm(path, { recursive: true, force: true });
				report.removed.push(path);
			} else {
				await rename(path, target);
				report.restored.push(target);
			}
			continue;
		}
		if (entry.isDirectory()) await sweepDir(path, report);
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
