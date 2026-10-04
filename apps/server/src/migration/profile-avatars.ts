/**
 * 0.x 的拓展订阅头像 `avatars/<订阅 id>.<png|jpeg|webp>` → 图库 `images/<sha256>.<ext>`,资料缓存跟着改写
 * (ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗,⑳c)。
 *
 * 不整目录搬:资料缓存(新代里的 `runtime/sub-runtime.json`,搬位置那一步硬链接进来的)每条资料的 `avatar` 按值的形状分:
 *
 * - **同源相对地址**(开头是 `/`,0.x 的 `/api/subs/<id>/avatar?v=<摘要>`):拓展订阅才写得出来。顺着记录的键(订阅 id)
 *   找到 `avatars/` 里那一个文件,读字节、按嗅探认格式,是图库收的图就**复制**(不硬链接:图库靠刷新修改时间做宽限期,
 *   硬链接会改到第 0 代那份)进新代的图库,`avatar` 换成引用;对不上(文件不在、嗅探不过、超 8MB、软链、订阅 id 不是
 *   干净的文件名)就两格都缺。0.x 换图片类型时先写新的再删旧的,中间崩了会两个并存 —— 认地址里 `?v=` 的内容摘要
 *   对得上的那个,都对不上取最新写的(0.x 读头像也是取最新的)。
 * - **远端网址**(`http(s)://` 或 `//`,B 站的 CDN 图链):挪到 `avatarUrl`,不碰图库。
 * - **空串**:两格都缺。已经是图库引用的原样(对新代再迁不改字节)。
 *
 * 按值的形状认、不去读订阅文件认身份:资料缓存按订阅 id 存,订阅文件读不懂时(配置仓开机会拒收它)这一步照样做得了。
 * 没有任何资料引用的头像文件(孤儿)不搬。资料缓存文件不在 / 读不懂 / 不是对象就不动它。
 * 改写写的是新文件(原子换名):搬过来的文件是指向第 0 代的硬链接,原地写会改到第 0 代。什么都不用改就不写。
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ImageRef } from "@bilibili-notify/internal";
import { isValidImageRef } from "../images/image-store.js";
import {
	isPlainObject,
	leftoverReason,
	listFiles,
	readJsonFile,
	rewriteJsonFile,
} from "./files.js";
import {
	createImageCopier,
	isCleanFileName,
	readPlainImageFile,
	statPlainImageFile,
} from "./image-library.js";

/** 0.x 头像文件的后缀:它只收这三种位图。 */
const AVATAR_EXTS = ["png", "jpeg", "webp"] as const;

/** 0.x 地址里的 `?v=`:头像内容 sha256 的前 12 位。 */
const DIGEST_IN_ADDRESS = /[?&]v=([0-9a-f]+)/;

export interface ProfileAvatarResult {
	/** 改写过的文件(绝对路径);什么都不用改就是空的。 */
	rewritten: string[];
	/** 复制进图库的头像(旧文件名 → 引用),按资料缓存里的顺序。内容一样的几个订阅指到同一个引用。 */
	copied: { file: string; ref: ImageRef }[];
	/** 资料引用着、却带不过来的拓展订阅头像有几个。 */
	dropped: number;
	/** 没有任何资料引用的头像文件有几个(临时文件之类的残留不算)。 */
	orphans: number;
}

/** 一条资料的 `avatar` 迁成什么:不动、换成引用、挪成网址、两格都缺。 */
type Converted =
	| { kind: "keep" }
	| { kind: "ref"; ref: ImageRef }
	| { kind: "url"; url: string }
	| { kind: "none" };

const isRemoteUrl = (value: string): boolean => /^(?:https?:)?\/\//i.test(value);

export async function migrateProfileAvatars(options: {
	/** 第 0 代的头像目录 `avatars`。 */
	zeroDir: string;
	/** 新代的图库目录 `images/`。 */
	imagesDir: string;
	/** 新代里的资料缓存 `runtime/sub-runtime.json`。 */
	runtimeFile: string;
}): Promise<ProfileAvatarResult> {
	const { zeroDir, imagesDir, runtimeFile } = options;
	const copier = createImageCopier(imagesDir);
	/** 认下来读过的头像文件名:剩下的就是孤儿。 */
	const used = new Set<string>();
	const copied: ProfileAvatarResult["copied"] = [];
	let dropped = 0;

	/** 这条订阅在 `avatars/` 里的头像文件(并存时按地址里的摘要认,认不出取最新写的);没有回 `undefined`。 */
	async function pickFile(
		subId: string,
		address: string,
	): Promise<{ name: string; bytes: Buffer } | undefined> {
		if (!isCleanFileName(subId)) return undefined;
		const found: { name: string; mtimeMs: number }[] = [];
		for (const ext of AVATAR_EXTS) {
			const name = `${subId}.${ext}`;
			const info = await statPlainImageFile(join(zeroDir, name));
			if (info) found.push({ name, mtimeMs: info.mtimeMs });
		}
		const read = async (name: string) => {
			const bytes = await readPlainImageFile(join(zeroDir, name));
			return bytes === undefined ? undefined : { name, bytes };
		};
		if (found.length <= 1) return found[0] && read(found[0].name);
		const all = (await Promise.all(found.map(({ name }) => read(name)))).filter(
			(one) => one !== undefined,
		);
		const digest = DIGEST_IN_ADDRESS.exec(address)?.[1];
		const matching = digest
			? all.find((one) => createHash("sha256").update(one.bytes).digest("hex").startsWith(digest))
			: undefined;
		if (matching) return matching;
		const mtimeOf = (name: string) => found.find((one) => one.name === name)?.mtimeMs ?? 0;
		return [...all].sort((a, b) => mtimeOf(b.name) - mtimeOf(a.name))[0];
	}

	/** 拓展订阅的相对地址 → 复制进图库后的引用;对不上回 `undefined`。 */
	async function adopt(subId: string, address: string): Promise<ImageRef | undefined> {
		const file = await pickFile(subId, address);
		const ref = file === undefined ? undefined : await copier.copy(file.bytes);
		if (file === undefined || ref === undefined) return undefined;
		used.add(file.name);
		copied.push({ file: file.name, ref });
		return ref;
	}

	async function convert(subId: string, avatar: string): Promise<Converted> {
		if (isValidImageRef(avatar)) return { kind: "keep" };
		if (isRemoteUrl(avatar)) return { kind: "url", url: avatar };
		if (!avatar.startsWith("/")) return { kind: "none" }; // 空串,和认不得的值:都当没有。
		const ref = await adopt(subId, avatar);
		if (ref === undefined) {
			dropped += 1;
			return { kind: "none" };
		}
		return { kind: "ref", ref };
	}

	const file = await readJsonFile(runtimeFile);
	let rewritten: string[] = [];
	if (file.kind === "ok" && isPlainObject(file.value)) {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [subId, record] of Object.entries(file.value)) {
			const profile = isPlainObject(record) ? record.cachedProfile : undefined;
			if (!isPlainObject(record) || !isPlainObject(profile) || typeof profile.avatar !== "string") {
				next[subId] = record;
				continue;
			}
			const converted = await convert(subId, profile.avatar);
			if (converted.kind === "keep") {
				next[subId] = record;
				continue;
			}
			changed = true;
			// `avatar` 在原位换掉(引用 / 挪成 avatarUrl / 拿掉),别的格一个不动。
			const cachedProfile: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(profile)) {
				if (key !== "avatar") cachedProfile[key] = value;
				else if (converted.kind === "ref") cachedProfile.avatar = converted.ref;
				else if (converted.kind === "url") cachedProfile.avatarUrl = converted.url;
			}
			next[subId] = { ...record, cachedProfile };
		}
		if (changed) {
			await rewriteJsonFile(runtimeFile, next);
			rewritten = [runtimeFile];
		}
	}

	const present = (await listFiles(zeroDir, "")).filter((name) => !leftoverReason(name));
	return { rewritten, copied, dropped, orphans: present.filter((name) => !used.has(name)).length };
}
