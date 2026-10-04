/**
 * 0.x 的聊天附件 `assets/chat/<id>` → 图库 `images/<sha256>.<ext>`(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗,⑳b)。
 *
 * 不整目录搬:会话里引用到哪个旧 id,才去读哪个文件 —— 读字节、按嗅探认格式,是图库收的图就**复制**到新代的
 * 图库(不硬链接:图库靠刷新修改时间做宽限期,硬链接会改到第 0 代那份,而第 0 代一个字节不动)。对不上的
 * (文件不在、嗅探不过、超 8MB、不是普通文件、旧 id 不是个干净的文件名)回 `null`,调用方把它从消息里拿掉。
 * 没有任何会话引用的附件(孤儿)不搬。
 *
 * 不联网、不走 `ImageWriter`:新代的图库此刻没在跑,这里直接落文件。文件名只此一份规矩 —— 来自 `imageRefOf`。
 */

import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ImageRef } from "@bilibili-notify/internal";
import { atomicWriteFile } from "@bilibili-notify/storage";
import { IMAGE_MAX_BYTES, imageRefOf, isValidImageRef } from "../images/image-store.js";
import { leftoverReason, listFiles } from "./files.js";

export interface ChatAttachmentResult {
	/** 复制进图库的附件(旧 id → 引用),按第一次被引用的先后。内容一样的几个旧 id 指到同一个引用。 */
	copied: { id: string; ref: ImageRef }[];
	/** 被会话引用、却带不过来的旧 id 有几个。 */
	dropped: number;
	/** 没有任何会话引用的附件有几张(临时文件之类的残留不算)。 */
	orphans: number;
}

export interface ChatAttachmentMigrator {
	/**
	 * 会话消息里的一个旧附件 id → 图库引用;对不上回 `null`(调用方把它从消息里拿掉)。同一个 id 只读一次。
	 * 已经是图库引用的原样还给(对新代再迁一次不能把新引用当旧 id 去第 0 代找)。
	 */
	ref(id: string): Promise<ImageRef | null>;
	/** 迁完以后的账。要在所有会话都问过之后调:孤儿是「没人问过」的那些。 */
	result(): Promise<ChatAttachmentResult>;
}

export function createChatAttachmentMigrator(options: {
	/** 第 0 代的附件目录 `assets/chat`。 */
	zeroDir: string;
	/** 新代的图库目录 `images/`。 */
	imagesDir: string;
}): ChatAttachmentMigrator {
	const { zeroDir, imagesDir } = options;
	/** 旧 id → 引用或 `null`;问过的都在这里,键的集合就是「被引用过的」。 */
	const resolved = new Map<string, ImageRef | null>();
	/** 已经写进图库的引用:内容一样的第二个旧 id 不再重写。 */
	const written = new Set<ImageRef>();

	/** 一个旧 id 对应的文件字节;文件不在、不是普通文件、太大、id 不是干净的文件名都是 `undefined`。 */
	async function readAttachment(id: string): Promise<Buffer | undefined> {
		// id 来自会话文件,是不可信输入:只认一个干净的文件名,绝不让它带着路径跑出附件目录。
		if (id === "" || id.startsWith(".") || basename(id) !== id || id.includes("\0"))
			return undefined;
		const path = join(zeroDir, id);
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(path);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return undefined;
			throw err;
		}
		// lstat:软链不跟 —— 0.x 从不会往这里放软链,放了就不是它放的。
		if (!info.isFile() || info.size > IMAGE_MAX_BYTES) return undefined;
		return readFile(path);
	}

	async function resolve(id: string): Promise<ImageRef | null> {
		if (isValidImageRef(id)) return id;
		const bytes = await readAttachment(id);
		const ref = bytes === undefined ? undefined : imageRefOf(bytes);
		if (bytes === undefined || ref === undefined) return null;
		if (!written.has(ref)) {
			await atomicWriteFile(join(imagesDir, ref), bytes);
			written.add(ref);
		}
		return ref;
	}

	return {
		async ref(id) {
			if (isValidImageRef(id)) return id;
			if (!resolved.has(id)) resolved.set(id, await resolve(id));
			return resolved.get(id) ?? null;
		},

		async result() {
			const copied = [...resolved].flatMap(([id, ref]) => (ref === null ? [] : [{ id, ref }]));
			const dropped = [...resolved.values()].filter((ref) => ref === null).length;
			const present = (await listFiles(zeroDir, "")).filter((name) => !leftoverReason(name));
			return { copied, dropped, orphans: present.filter((name) => !resolved.has(name)).length };
		},
	};
}
