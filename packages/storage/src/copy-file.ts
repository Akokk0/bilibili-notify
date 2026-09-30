import { constants } from "node:fs";
import { copyFile, link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { syncDirectory, tempPathFor } from "./atomic-file";

/**
 * 持久化底层:原子复制。和原子写同一个套路 —— 先复制到同目录的临时文件并 fsync,再改名成目标,
 * 最后 fsync 目录。复制出来的是独立的一份:往里追加不会改到来源。
 *
 * 目标已经在了会被盖掉(和原子写一样);要「不许盖」用 {@link linkOrCopyFile}。
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

/** 这些码说明「这里链接不了」(跨分区、文件系统不支持、链接数到顶),回落成复制;别的照抛。 */
const LINK_UNSUPPORTED = new Set(["EXDEV", "EPERM", "ENOTSUP", "EMLINK", "ENOSYS", "EOPNOTSUPP"]);

/**
 * 持久化底层:能硬链接就硬链接,链接不了回落成复制(迁移开新代用,ADR-0022 决策 7)。
 *
 * 只给**整份原子替换**的文件用:新代往这里写,写的是临时文件再改名,换掉的是新代那一条目录项,旧代
 * 那份原封不动。**追加写的文件(jsonl)不许用**,一律 {@link copyFileAtomic},否则新代往里追加会改到
 * 旧代的文件。目标已经在了就抛 `EEXIST`,不悄悄盖掉。返回这一份是链接还是复制出来的。
 */
export async function linkOrCopyFile(source: string, target: string): Promise<"linked" | "copied"> {
	await mkdir(dirname(target), { recursive: true });
	try {
		await link(source, target);
		return "linked";
	} catch (err) {
		if (!LINK_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
	}
	await copyFileAtomic(source, target);
	return "copied";
}
