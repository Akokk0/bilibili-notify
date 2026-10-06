import { constants } from "node:fs";
import { copyFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { syncDirectory, tempPathFor } from "./atomic-file";

/**
 * 持久化底层:原子复制。和原子写同一个套路 —— 先复制到同目录的临时文件并 fsync,再改名成目标,
 * 最后 fsync 目录。复制出来的是独立的一份:往里追加不会改到来源。
 *
 * 目标已经在了会被盖掉(和原子写一样)。
 */
export async function copyFileAtomic(source: string, target: string): Promise<void> {
	const dir = dirname(target);
	await mkdir(dir, { recursive: true });
	const tmp = tempPathFor(target);
	try {
		await copyFile(source, tmp, constants.COPYFILE_EXCL);
		const handle = await open(tmp, "r+");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, target);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
	await syncDirectory(dir);
}
