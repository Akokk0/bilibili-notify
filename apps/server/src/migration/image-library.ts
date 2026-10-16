/**
 * 迁移往新代图库落图、从 0.x 散落的图文件里读图的共用几件(拓展订阅头像 `profile-avatars.ts`、历史图
 * `history-images.ts`)。
 *
 * 不走 `ImageWriter`:新代的图库此刻没在跑,迁移直接往 `images/` 落文件 —— 文件名只认 `imageRefOf` 一份规矩。
 * 读的文件来自第 0 代,是不可信输入:只认干净的文件名、不跟软链、不读超过图库上限的。
 */

import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ImageRef } from "@bilibili-notify/internal";
import { atomicWriteFile } from "@bilibili-notify/storage";
import { IMAGE_MAX_BYTES, imageRefOf } from "../images/image-store.js";

/**
 * 这个名字是不是一个干净的文件名:从旧数据里读出来、要拼进路径的名字(历史行里的图名、资料缓存的键)先过这一道,
 * 绝不让它带着路径跑出那个目录。
 */
export function isCleanFileName(name: string): boolean {
	return name !== "" && !name.startsWith(".") && basename(name) === name && !name.includes("\0");
}

/**
 * 一个普通文件的信息;文件不在、不是普通文件(软链不跟)、超过图库上限都是 `undefined`。
 * 0.x 从不会往这些目录里放软链,放了就不是它放的。
 */
export async function statPlainImageFile(path: string): Promise<Stats | undefined> {
	let info: Stats;
	try {
		info = await lstat(path);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw err;
	}
	return info.isFile() && info.size <= IMAGE_MAX_BYTES ? info : undefined;
}

/** {@link statPlainImageFile} 过得去就读它的字节,否则 `undefined`。 */
export async function readPlainImageFile(path: string): Promise<Buffer | undefined> {
	return (await statPlainImageFile(path)) === undefined ? undefined : readFile(path);
}

export interface ImageCopier {
	/** 把一份字节**复制**进新代的图库,回它的引用;不是图库收的图(嗅探不过、超 8MB)回 `undefined`、什么也不写。 */
	copy(bytes: Uint8Array): Promise<ImageRef | undefined>;
	/**
	 * 读第 0 代的一个图文件({@link readPlainImageFile}:不是普通文件、软链、超 8MB、不在都是读不到)再 {@link copy} 进去,
	 * 回引用;读不到、嗅探不过回 `undefined`。**同一个路径只读一次**(读不到也记着):历史里同一张图被行和重推原件
	 * 各引用一回,几万张图再读一遍太贵。路径由调用方拼,拼之前自己核过文件名是干净的。
	 */
	copyFile(path: string): Promise<ImageRef | undefined>;
}

/**
 * 往新代的 `images/` 落图。复制而不是硬链接:图库靠刷新修改时间做宽限期,硬链接会改到第 0 代那份。
 * 内容一样的第二份不再重写(同一个引用)。
 *
 * 写法:`atomicWriteFile` 但**不逐张同步目录**(`syncDirectory: false`)—— 历史图在保留期内是几千到上万张,每张多出来的
 * 那一次目录 fsync 要多花近一倍时间(实测每张 7.8 毫秒对 4.4 毫秒)。文件各自照样 fsync;`images/` 目录由
 * `migrateZeroGeneration` 在新代改名之前同步一次。
 */
export function createImageCopier(imagesDir: string): ImageCopier {
	/** 已经写进图库的引用。 */
	const written = new Set<ImageRef>();
	/** 读过的图文件(路径 → 引用,读不到是 `undefined`)。 */
	const files = new Map<string, ImageRef | undefined>();
	const copier: ImageCopier = {
		async copy(bytes) {
			const ref = imageRefOf(bytes);
			if (ref === undefined) return undefined;
			if (!written.has(ref)) {
				await atomicWriteFile(join(imagesDir, ref), bytes, { syncDirectory: false });
				written.add(ref);
			}
			return ref;
		},
		async copyFile(path) {
			if (files.has(path)) return files.get(path);
			const bytes = await readPlainImageFile(path);
			const ref = bytes === undefined ? undefined : await copier.copy(bytes);
			files.set(path, ref);
			return ref;
		},
	};
	return copier;
}
