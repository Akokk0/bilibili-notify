import { randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 持久化底层:原子写。先写同目录下的临时文件并 fsync,再改名盖到目标上,最后 fsync 目录
 * —— 任何时刻读到的目标要么是旧内容、要么是新内容,不会是半截。写失败删掉临时文件;
 * 进程被杀留下的临时文件由开机清扫收掉(见 sweep)。
 *
 * 临时文件统一叫 `<目标>.bn-tmp.<pid>.<随机>`:带 pid 与随机后缀,同一个目标的并发写
 * 各用各的,不会互相覆盖临时文件。
 *
 * 每个函数都有同步版(`…Sync`),语义逐条一致:开机早期的小状态(选版状态、拓展装载账本)
 * 今天是同步读写,改成异步会一路传染给所有调用方,所以补一份同步的,而不是改调用方。
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

/** 原子写一个文件的同步版:语义与 {@link atomicWriteFile} 逐条一致。 */
export function atomicWriteFileSync(
	path: string,
	data: string | Uint8Array,
	opts: AtomicWriteOptions = {},
): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = tempPathFor(path);
	try {
		const fd = openSync(tmp, "wx", opts.mode);
		try {
			writeFileSync(fd, data);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// 临时文件本来就没建出来(open 就失败了),没有东西要删
		}
		throw err;
	}
	syncDirectorySync(dir);
}

/** 原子写 JSON 的同步版:格式与 {@link atomicWriteJson} 相同(2 空格缩进、末尾换行)。 */
export function atomicWriteJsonSync(
	path: string,
	value: unknown,
	opts: AtomicWriteOptions = {},
): void {
	atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`, opts);
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

/** {@link syncDirectory} 的同步版。 */
export function syncDirectorySync(dir: string): void {
	if (process.platform === "win32") return;
	const fd = openSync(dir, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
