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

/**
 * 名字里含 {@link TEMP_MARKER} 或 {@link OLD_MARKER} → 是原子写 / 整目录替换留下的暂存 / 旧目录。
 * 给「开机扫一遍子目录建索引」的地方(皮肤库这类)跳过它们用,不必各自手写 `endsWith(".tmp")`。
 *
 * 判据比清扫宽:清扫要连 pid 与十六进制后缀都对上才动手删(删错了没法救),这里只是跳过,
 * 宁可多跳一个。
 */
export function isLeftoverName(name: string): boolean {
	return name.includes(TEMP_MARKER) || name.includes(OLD_MARKER);
}

export interface SweepReport {
	/** 删掉的临时文件、暂存目录与多余的旧目录。 */
	removed: string[];
	/** 换到一半、挪回原位的旧目录(挪回后的路径)。 */
	restored: string[];
	/** 读不动或清不掉、只好跳过的地方(路径与原因);那里的残留下次开机再试。 */
	skipped: { path: string; message: string }[];
}

/**
 * 开机清扫:从 root 往下,删掉上个进程被杀时留下的临时文件与暂存目录;整目录替换换到一半
 * 留下的旧目录,目标不在就挪回去、在就删掉。别的文件一概不碰,不跟进符号链接。
 *
 * 必须在任何写入开始之前跑:它认不出哪些临时文件是这个进程正在写的
 * (Docker 里每次开机 pid 常常一样,不能靠 pid 区分)。
 *
 * 读不动的目录、删不掉 / 挪不回的残留只跳过那一处、记进报告,别处照清,整个清扫不抛:数据目录里
 * 常有主人自己丢进来、权限不对的东西,不能因为它就一处都不清。
 */
export async function sweepTempFiles(
	root: string,
	options: SweepOptions = {},
): Promise<SweepReport> {
	const report: SweepReport = { removed: [], restored: [], skipped: [] };
	await sweepDir(root, report, options);
	return report;
}

export interface SweepOptions {
	/** 往子目录里钻吗。默认钻;给 `false` 就只看 root 这一层(旧代的内部不该被碰时用)。 */
	recurse?: boolean;
	/**
	 * 只收基名(去掉临时后缀的那段,即被写 / 被换的那个名字)过得了它的残留;缺省全收。
	 * 给「宿主根这种一层里还住着别人东西」的地方用:只认自己改名规则产生的那几个名字。
	 */
	only?: (baseName: string) => boolean;
}

async function sweepDir(dir: string, report: SweepReport, options: SweepOptions): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") skip(report, dir, err);
		return;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		try {
			if (TEMP_NAME.test(entry.name)) {
				if (options.only && !options.only(entry.name.replace(TEMP_NAME, ""))) continue;
				await rm(path, { recursive: true, force: true });
				report.removed.push(path);
				continue;
			}
			const old = OLD_NAME.exec(entry.name);
			if (old) {
				if (options.only && !options.only(old[1] as string)) continue;
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
		} catch (err) {
			skip(report, path, err);
			continue;
		}
		if (options.recurse !== false && entry.isDirectory()) await sweepDir(path, report, options);
	}
}

function skip(report: SweepReport, path: string, err: unknown): void {
	report.skipped.push({ path, message: err instanceof Error ? err.message : String(err) });
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
