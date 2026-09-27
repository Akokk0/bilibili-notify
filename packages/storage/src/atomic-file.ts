import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 持久化底层:原子写。先写同目录下的临时文件并 fsync,再改名盖到目标上,最后 fsync 目录
 * —— 任何时刻读到的目标要么是旧内容、要么是新内容,不会是半截。写失败删掉临时文件;
 * 进程被杀留下的临时文件由开机清扫收掉(见 sweep)。
 *
 * 临时文件统一叫 `<目标>.bn-tmp.<pid>.<随机>`:带 pid 与随机后缀,同一个目标的并发写
 * 各用各的,不会互相覆盖临时文件。
 */

/** 临时文件与暂存目录名里的统一标记。开机清扫只认这个标记。 */
export const TEMP_MARKER = ".bn-tmp.";

export interface AtomicWriteOptions {
	/** 新文件的权限位(如密钥用 `0o600`)。Windows 上忽略。 */
	mode?: number;
}

/** 给一个目标路径起一个同目录的临时名。 */
export function tempPathFor(path: string): string {
	return `${path}${TEMP_MARKER}${process.pid}.${randomBytes(6).toString("hex")}`;
}

/** 原子写一个文件(字符串按 UTF-8)。 */
export async function atomicWriteFile(
	path: string,
	data: string | Uint8Array,
	opts: AtomicWriteOptions = {},
): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tmp = tempPathFor(path);
	try {
		const handle = await open(tmp, "wx", opts.mode);
		try {
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
	await syncDirectory(dir);
}

/** 原子写 JSON:2 空格缩进、末尾换行(全仓落盘 JSON 的统一格式)。 */
export async function atomicWriteJson(
	path: string,
	value: unknown,
	opts: AtomicWriteOptions = {},
): Promise<void> {
	await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, opts);
}

/**
 * fsync 目录,让刚做的改名 / 新建本身落盘。Windows 打不开目录句柄,NTFS 也不需要这一步,直接跳过。
 */
export async function syncDirectory(dir: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(dir, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
