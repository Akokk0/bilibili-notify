import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Disposable,
	isExtensionSubscription,
	type Logger,
	type MessageBus,
	SUBSCRIPTION_AVATAR_MAX_BYTES,
	SubscriptionAvatarSchema,
	sniffImageFormat,
} from "@bilibili-notify/internal";
import { z } from "zod";

/**
 * 拓展订阅的头像文件(ADR-0019 决策 49):`<dataDir>/avatars/<订阅 id>.<png|jpeg|webp>`,面板从
 * `/api/subs/<id>/avatar?v=<摘要>` 取(走面板鉴权;内容一变地址就变,浏览器不会拿旧缓存)。
 *
 * - 进来的有两条路:新建订阅时解析门候选带的位图 data URL(`SubscriptionAvatarSchema`:png / jpeg /
 *   webp、128 KiB 封顶),与之后拓展「报资料更新」交的字节(决策 62,约 96 KiB 封顶)。**开头的
 *   魔数字节得是这三种之一**,data URL 那条还得对得上它声明的类型 —— 这些字节以后从同源地址按
 *   认出来的类型发出去,不是位图的一律不收。认魔数只有一份(`sniffImageFormat`,上报校验也用它)。
 * - **内容没变就不重写**:拓展每轮都可能报一次资料,同一张图每次换一个文件是白写盘;地址里的摘要
 *   也就不变,浏览器的缓存照样命中。
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
const isAvatarExt = (format: string | undefined): format is AvatarExt =>
	format !== undefined && Object.hasOwn(AVATAR_TYPES, format);

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
	if (sniffImageFormat(bytes) !== ext) {
		return { ok: false, reason: `头像声明是 ${AVATAR_TYPES[ext]},内容却不是这种图` };
	}
	return { ok: true, avatar: { bytes, ext, contentType: AVATAR_TYPES[ext] } };
}

/**
 * 拓展报资料时交的头像字节(决策 62):类型按文件头认(不信谁说的),封顶与上报校验同一把尺子
 * (`SUBSCRIPTION_AVATAR_MAX_BYTES`)。上报那一道本已核过,这里再核一遍:存文件这一道不靠调用方。
 */
export function checkSubscriptionAvatarBytes(bytes: Uint8Array): AvatarDecodeResult {
	if (bytes.byteLength > SUBSCRIPTION_AVATAR_MAX_BYTES) {
		return {
			ok: false,
			reason: `头像超过 ${Math.floor(SUBSCRIPTION_AVATAR_MAX_BYTES / 1024)} KiB`,
		};
	}
	const ext = sniffImageFormat(bytes);
	if (!isAvatarExt(ext)) {
		return { ok: false, reason: "头像只收 png / jpeg / webp(按文件头认),这张都不是" };
	}
	return {
		ok: true,
		avatar: { bytes: Buffer.from(bytes), ext, contentType: AVATAR_TYPES[ext] },
	};
}

export interface SubAvatarStore {
	/**
	 * 存下这条订阅的头像,回面板取它的地址(`/api/subs/<id>/avatar?v=<摘要>`)。头像不合规矩
	 * (见 {@link decodeSubscriptionAvatar})、id 不是 uuid、写盘失败都抛。盘上那张与它一模一样
	 * 时不重写,回的地址也不变。
	 */
	write(subId: string, dataUrl: string): Promise<string>;
	/** 同 {@link SubAvatarStore.write},收的是字节(拓展报资料更新,决策 62;见 {@link checkSubscriptionAvatarBytes})。 */
	writeBytes(subId: string, bytes: Uint8Array): Promise<string>;
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

/** 盘上这个文件的内容是不是正好这几个字节。没有这个文件就是「不是」。 */
async function sameContent(path: string, bytes: Buffer): Promise<boolean> {
	try {
		return (await readFile(path)).equals(bytes);
	} catch (err) {
		if (isMissing(err)) return false;
		throw err;
	}
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

	/** 两条写的路汇到这儿:核 id → 核图 → 落盘(内容没变就不写)→ 回地址。在队里跑。 */
	function save(subId: string, decode: () => AvatarDecodeResult): Promise<string> {
		return runSerial(async () => {
			if (!SubIdSchema.safeParse(subId).success) {
				throw new Error(`订阅 id 不是 uuid:${subId}`);
			}
			const decoded = decode();
			if (!decoded.ok) throw new Error(decoded.reason);
			const { bytes, ext } = decoded.avatar;
			const final = fileOf(subId, ext);
			if (!(await sameContent(final, bytes))) {
				await mkdir(dir, { recursive: true });
				// 先写临时文件再改名(同 SubRuntimeStore 的 atomicWriteJson):读的人永远看不见半张图。
				const tmp = `${final}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
				try {
					await writeFile(tmp, bytes);
					await rename(tmp, final);
				} catch (err) {
					await unlinkIfPresent(tmp).catch(() => undefined);
					throw err;
				}
			}
			// 换了类型(png → webp)的话,旧类型那个文件就成了残留 —— 改名成功之后再删,
			// 中途失败时手里至少还有一张。内容没变那一趟也照删:上次改名之后、删旧类型之前崩了的话,
			// 残留就是这时候收掉的。
			for (const other of AVATAR_EXTS) {
				if (other !== ext) await unlinkIfPresent(fileOf(subId, other));
			}
			const digest = createHash("sha256").update(bytes).digest("hex").slice(0, DIGEST_CHARS);
			return `/api/subs/${subId}/avatar?v=${digest}`;
		});
	}

	return {
		write(subId, dataUrl) {
			return save(subId, () => decodeSubscriptionAvatar(dataUrl));
		},

		writeBytes(subId, bytes) {
			return save(subId, () => checkSubscriptionAvatarBytes(bytes));
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
