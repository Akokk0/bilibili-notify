import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Disposable,
	isExtensionSubscription,
	type Logger,
	type MessageBus,
	SubscriptionAvatarSchema,
} from "@bilibili-notify/internal";
import { z } from "zod";

/**
 * 拓展订阅的头像文件(ADR-0019 决策 49):`<dataDir>/avatars/<订阅 id>.<png|jpeg|webp>`,面板从
 * `/api/subs/<id>/avatar?v=<摘要>` 取(走面板鉴权;内容一变地址就变,浏览器不会拿旧缓存)。
 *
 * - 进来的只有位图 data URL(`SubscriptionAvatarSchema`:png / jpeg / webp、128 KiB 封顶),而且
 *   **开头的魔数字节得对得上声明的类型** —— 这些字节以后从同源地址按声明的类型发出去,声明是
 *   png、内容是别的东西的,一律不收。
 * - 🔴 **不进备份**(与资料缓存 `sub-runtime.json` 同一口径):恢复之后头像等拓展下一次报资料再来。
 * - 不塞进资料缓存:订阅列表每拉一次都带着全部头像,一百个订阅约 1 MB。
 *
 * B 站订阅用不着它:那一支的头像是 B 站 CDN 的图链。
 */

/** 收的三种位图:文件后缀 → 发出去时的 `Content-Type`。 */
const AVATAR_TYPES = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
} as const;
type AvatarExt = keyof typeof AVATAR_TYPES;
const AVATAR_EXTS = Object.keys(AVATAR_TYPES) as AvatarExt[];

/** 订阅 id 要当文件名用 —— 与订阅 schema 同一把尺子(`z.uuid()`),挡住 `../` 这类。 */
const SubIdSchema = z.uuid();

/** 地址里 `v` 取内容 sha256 的前几位。 */
const DIGEST_CHARS = 12;

/** 盘上认得的文件名:`<id>.<后缀>`,或者写到一半留下的 `<id>.<后缀>.tmp.<…>`。 */
const FILE_NAME_RE = /^([0-9a-fA-F-]{36})\.(png|jpeg|webp)(\.tmp\..+)?$/;

export interface DecodedAvatar {
	bytes: Buffer;
	ext: AvatarExt;
	contentType: string;
}

export type AvatarDecodeResult =
	| { ok: true; avatar: DecodedAvatar }
	| { ok: false; reason: string };

/** 各类型开头那几个字节对不对。只看魔数,不解码图。 */
function magicMatches(ext: AvatarExt, bytes: Buffer): boolean {
	switch (ext) {
		case "png":
			return bytes
				.subarray(0, 8)
				.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		case "jpeg":
			return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
		case "webp":
			return (
				bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
				bytes.subarray(8, 12).toString("latin1") === "WEBP"
			);
	}
}

/**
 * 把一张头像 data URL 解成字节,并核对魔数。不合规矩的回一句点名的原因(路由原样交给面板)。
 *
 * 新建订阅那条路在落盘**之前**先拿它核一遍 —— 不能等订阅建好了才发现头像不收。
 */
export function decodeSubscriptionAvatar(dataUrl: string): AvatarDecodeResult {
	const parsed = SubscriptionAvatarSchema.safeParse(dataUrl);
	if (!parsed.success) {
		return { ok: false, reason: parsed.error.issues.map((i) => i.message).join(";") };
	}
	// 形状已由上面那条正则钉死:`data:image/<png|jpeg|webp>;base64,<…>`。
	const comma = dataUrl.indexOf(",");
	const ext = dataUrl.slice("data:image/".length, dataUrl.indexOf(";")) as AvatarExt;
	const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
	if (!magicMatches(ext, bytes)) {
		return { ok: false, reason: `头像声明是 ${AVATAR_TYPES[ext]},内容却不是这种图` };
	}
	return { ok: true, avatar: { bytes, ext, contentType: AVATAR_TYPES[ext] } };
}

export interface SubAvatarStore {
	/**
	 * 存下这条订阅的头像,回面板取它的地址(`/api/subs/<id>/avatar?v=<摘要>`)。头像不合规矩
	 * (见 {@link decodeSubscriptionAvatar})、id 不是 uuid、写盘失败都抛。
	 */
	write(subId: string, dataUrl: string): Promise<string>;
	/** 这条订阅的头像。没有就是 `undefined`。 */
	read(subId: string): Promise<{ bytes: Buffer; contentType: string } | undefined>;
	/** 删掉这条订阅的头像。没有也不报错。 */
	remove(subId: string): Promise<void>;
	/** 开机清扫:不在 `keepIds` 里的订阅的头像、写到一半留下的临时文件都删掉。不认得的文件不碰。 */
	sweep(keepIds: Iterable<string>): Promise<void>;
}

export interface CreateSubAvatarStoreOptions {
	dataDir: string;
	logger: Logger;
}

function isMissing(err: unknown): boolean {
	return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function unlinkIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (err) {
		if (!isMissing(err)) throw err;
	}
}

export function createSubAvatarStore(opts: CreateSubAvatarStoreOptions): SubAvatarStore {
	const dir = join(opts.dataDir, "avatars");
	const fileOf = (subId: string, ext: AvatarExt) => join(dir, `${subId}.${ext}`);

	// 一条 FIFO:同一条订阅的写 / 删 / 清扫不交错(新建时写一次、以后报资料再写,删订阅与之并发)。
	let queue: Promise<unknown> = Promise.resolve();
	function runSerial<T>(task: () => Promise<T>): Promise<T> {
		const next = queue.then(task, task);
		queue = next.catch(() => undefined);
		return next;
	}

	return {
		write(subId, dataUrl) {
			return runSerial(async () => {
				if (!SubIdSchema.safeParse(subId).success) {
					throw new Error(`订阅 id 不是 uuid:${subId}`);
				}
				const decoded = decodeSubscriptionAvatar(dataUrl);
				if (!decoded.ok) throw new Error(decoded.reason);
				const { bytes, ext } = decoded.avatar;
				await mkdir(dir, { recursive: true });
				// 先写临时文件再改名(同 SubRuntimeStore 的 atomicWriteJson):读的人永远看不见半张图。
				const final = fileOf(subId, ext);
				const tmp = `${final}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
				try {
					await writeFile(tmp, bytes);
					await rename(tmp, final);
				} catch (err) {
					await unlinkIfPresent(tmp).catch(() => undefined);
					throw err;
				}
				// 换了类型(png → webp)的话,旧类型那个文件就成了残留 —— 改名成功之后再删,
				// 中途失败时手里至少还有一张。
				for (const other of AVATAR_EXTS) {
					if (other !== ext) await unlinkIfPresent(fileOf(subId, other));
				}
				const digest = createHash("sha256").update(bytes).digest("hex").slice(0, DIGEST_CHARS);
				return `/api/subs/${subId}/avatar?v=${digest}`;
			});
		},

		async read(subId) {
			if (!SubIdSchema.safeParse(subId).success) return undefined;
			// 正常只有一个。改名之后、删旧类型之前崩了的话会有两个 —— 取最新写的那个。
			let newest: { ext: AvatarExt; mtimeMs: number } | undefined;
			for (const ext of AVATAR_EXTS) {
				try {
					const { mtimeMs } = await stat(fileOf(subId, ext));
					if (!newest || mtimeMs > newest.mtimeMs) newest = { ext, mtimeMs };
				} catch (err) {
					if (!isMissing(err)) throw err;
				}
			}
			if (!newest) return undefined;
			try {
				const bytes = await readFile(fileOf(subId, newest.ext));
				return { bytes, contentType: AVATAR_TYPES[newest.ext] };
			} catch (err) {
				// stat 与读之间被删掉了(删订阅正好赶上)。
				if (isMissing(err)) return undefined;
				throw err;
			}
		},

		remove(subId) {
			return runSerial(async () => {
				if (!SubIdSchema.safeParse(subId).success) return;
				for (const ext of AVATAR_EXTS) await unlinkIfPresent(fileOf(subId, ext));
			});
		},

		sweep(keepIds) {
			const keep = new Set(keepIds);
			return runSerial(async () => {
				let names: string[];
				try {
					names = await readdir(dir);
				} catch (err) {
					if (isMissing(err)) return;
					throw err;
				}
				let dropped = 0;
				for (const name of names) {
					const m = FILE_NAME_RE.exec(name);
					if (!m) continue;
					// 临时文件一律删:清扫排在这条队里,不会有哪次写正写到一半。
					if (m[3] !== undefined || !keep.has(m[1] as string)) {
						await unlinkIfPresent(join(dir, name));
						dropped++;
					}
				}
				if (dropped > 0) opts.logger.debug(`[sub-avatar] swept ${dropped} orphan file(s)`);
			});
		},
	};
}

/**
 * 删订阅时把它的头像一起删(决策 49)—— 删的路不止一条(面板删、恢复备份整份覆盖、别处的级联),
 * 它们最后都汇到 `subscription-changed` 的 remove 那一格上(同 FansPoller 清资料缓存),所以听那里。
 * B 站订阅没有头像文件,不理。
 */
export function bindSubAvatarCleanup(opts: {
	bus: MessageBus;
	avatars: SubAvatarStore;
	logger: Logger;
}): Disposable {
	return opts.bus.on("subscription-changed", (ops) => {
		for (const op of ops) {
			if (op.type !== "remove" || !isExtensionSubscription(op.sub)) continue;
			const id = op.sub.id;
			opts.avatars.remove(id).catch((err) => {
				opts.logger.warn(`[sub-avatar] 删订阅 ${id} 的头像失败:${String(err)}`);
			});
		}
	});
}
