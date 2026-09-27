import { randomBytes } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { syncDirectory, tempPathFor } from "./atomic-file";

/** 整目录替换时被换下来的旧目录名里的标记;开机清扫据它决定挪回还是删掉。 */
export const OLD_MARKER = ".bn-old.";

/**
 * 持久化底层:整目录替换(皮肤包、拓展安装)。在同级的暂存目录里搭好新内容,再两步改名换上:
 * 旧的先挪成 `<目标>.bn-old.*`,暂存改名成目标,最后删旧的。搭建失败原目录不动、暂存删掉。
 *
 * 两次改名之间进程被杀,会留下「目标不在、旧的在」:开机清扫把旧的挪回去(见 sweep)。
 */
export async function replaceDirectory(
	target: string,
	build: (stagingDir: string) => Promise<void>,
): Promise<void> {
	const staging = tempPathFor(target);
	await mkdir(staging, { recursive: true });
	try {
		await build(staging);
	} catch (err) {
		await rm(staging, { recursive: true, force: true });
		throw err;
	}

	const old = `${target}${OLD_MARKER}${process.pid}.${randomBytes(6).toString("hex")}`;
	let hadOld = true;
	try {
		await rename(target, old);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			await rm(staging, { recursive: true, force: true });
			throw err;
		}
		hadOld = false;
	}
	try {
		await rename(staging, target);
	} catch (err) {
		if (hadOld) await rename(old, target).catch(() => {});
		await rm(staging, { recursive: true, force: true });
		throw err;
	}
	await syncDirectory(dirname(target));
	if (hadOld) await rm(old, { recursive: true, force: true });
}
