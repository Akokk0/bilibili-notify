import { rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { syncDirectory, tempPathFor } from "./atomic-file";

/**
 * 持久化底层:删目录(皮肤包)。先把目标改名成同目录的临时名 `<目标>.bn-tmp.*`、
 * fsync 父目录,再 `rm -rf` 改名后的那份。
 *
 * 为什么不原地 `rm -rf`:删到一半被杀会留下半个目录,开机扫描会把它当成一套坏皮肤。先改名,
 * 目标名字瞬间就没了;删到一半的残骸带 `.bn-tmp.` 标记,由开机清扫(见 sweep)收掉。
 *
 * 目标不在回 `false`,删掉了回 `true`。
 */
export async function removeDirectory(target: string): Promise<boolean> {
	const doomed = tempPathFor(target);
	try {
		await rename(target, doomed);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
	await syncDirectory(dirname(target));
	await rm(doomed, { recursive: true, force: true });
	return true;
}
