import { randomBytes } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { syncDirectory, tempPathFor } from "./atomic-file";

/** 整目录替换时被换下来的旧目录名里的标记;开机清扫据它决定挪回还是删掉。 */
export const OLD_MARKER = ".bn-old.";

export interface ReplaceDirectoryOptions {
	/**
	 * 暂存目录的绝对路径,代替默认的 `<目标>.bn-tmp.*`。必须与目标在同一个父目录里。
	 *
	 * ⚠️ 给了自定义名字,开机清扫(sweep)就认不出这些残留 —— 进程被杀时留下的暂存 / 旧目录
	 * 由调用方自己清。用例:载荷目录 `versions/` 的暂存名 `.staging-<版本>-<uuid>` 与旧目录名
	 * `.old-<版本>-<uuid>` 已经被发出去的代码认着,不能换成默认的。
	 */
	stagingPath?: string;
	/** 被换下来的旧目录的绝对路径,代替默认的 `<目标>.bn-old.*`。约束与清扫的注意事项同 `stagingPath`。 */
	oldPath?: string;
}

/**
 * 持久化底层:整目录替换(皮肤包、拓展安装)。在同级的暂存目录里搭好新内容,再两步改名换上:
 * 旧的先挪成 `<目标>.bn-old.*`,暂存改名成目标,最后删旧的。搭建失败原目录不动、暂存删掉。
 *
 * 两次改名之间进程被杀,会留下「目标不在、旧的在」:开机清扫把旧的挪回去(见 sweep)。
 *
 * 暂存与旧目录的名字可以经 `opts` 指定(见 {@link ReplaceDirectoryOptions})。两个名字都得与目标
 * 同一个父目录 —— 改名要在同一个文件系统、同一个目录里才是原子的 —— 不是就抛 TypeError,
 * 而且在碰盘之前(`build` 不跑、什么都不建)。
 */
export async function replaceDirectory(
	target: string,
	build: (stagingDir: string) => Promise<void>,
	opts: ReplaceDirectoryOptions = {},
): Promise<void> {
	assertNamesUsable(target, opts);
	const staging = opts.stagingPath ?? tempPathFor(target);
	await mkdir(staging, { recursive: true });
	try {
		await build(staging);
	} catch (err) {
		await rm(staging, { recursive: true, force: true });
		throw err;
	}

	const old =
		opts.oldPath ?? `${target}${OLD_MARKER}${process.pid}.${randomBytes(6).toString("hex")}`;
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

/**
 * 自定义名字的闸。除了「同一个父目录」,还挡两种会毁数据的写法:暂存 = 目标
 * (搭建失败或第二次改名失败时 `rm(staging)` 会把原目录连根删掉)、暂存 = 旧目录(两次改名互相顶掉)。
 */
function assertNamesUsable(target: string, opts: ReplaceDirectoryOptions): void {
	const parent = dirname(resolve(target));
	const named: [string, string | undefined][] = [
		["stagingPath", opts.stagingPath],
		["oldPath", opts.oldPath],
	];
	for (const [field, path] of named) {
		if (path === undefined) continue;
		if (dirname(resolve(path)) !== parent) {
			throw new TypeError(`replaceDirectory: ${field} 必须与目标在同一个父目录里(${path})`);
		}
		if (resolve(path) === resolve(target)) {
			throw new TypeError(`replaceDirectory: ${field} 不能就是目标本身(${path})`);
		}
	}
	if (
		opts.stagingPath !== undefined &&
		opts.oldPath !== undefined &&
		resolve(opts.stagingPath) === resolve(opts.oldPath)
	) {
		throw new TypeError("replaceDirectory: stagingPath 与 oldPath 不能是同一个路径");
	}
}
