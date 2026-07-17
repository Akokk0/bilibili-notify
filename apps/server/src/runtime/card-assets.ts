/**
 * 卡片背景图的本地资产存储。落盘到 `<dataDir>/assets/card-bg/`,资产 id = 文件名
 * `<32-hex>.<ext>`。**不**用 serveStatic 暴露整个 dataDir(里面有 secrets);只经此模块
 * 的定向读取 + 路由的 id 正则校验访问,杜绝路径穿越。渲染期由服务端把 id 解析成 data URL
 * 内联给模版(packages/image 不碰文件系统)。
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 单张背景图上限 5MB(前端应先压缩;这里是兜底)。 */
const MAX_CARD_BG_BYTES = 5 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
};
const EXT_TO_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};
/** 资产 id 严格形如 `<32 位小写 hex>.<png|jpg|jpeg|webp>` —— 排除 `..` / `/` 等穿越。 */
const ID_RE = /^[a-f0-9]{32}\.(png|jpe?g|webp)$/;

/** 背景图资产目录 `<dataDir>/assets/card-bg`。 */
export function cardBgDir(dataDir: string): string {
	return join(dataDir, "assets", "card-bg");
}

/** id 是否合法(防穿越的唯一闸门)。 */
export function isValidCardBgId(id: string): boolean {
	return ID_RE.test(id);
}

/** 从图廊删除一张背景图。id 非法 / 文件不存在返回 false(幂等);删成功返回 true。 */
export async function deleteCardBg(dataDir: string, id: string): Promise<boolean> {
	if (!isValidCardBgId(id)) return false;
	try {
		await unlink(join(cardBgDir(dataDir), id));
		return true;
	} catch {
		return false;
	}
}

/** 列出图廊里所有合法背景图 id;目录不存在或读失败返回 []。供图廊列表路由。 */
export async function listCardBg(dataDir: string): Promise<string[]> {
	try {
		const names = await readdir(cardBgDir(dataDir));
		return names.filter(isValidCardBgId);
	} catch {
		return [];
	}
}

/** 保存上传的背景图,返回资产 id(= 文件名)。非图片 mime 或超限抛错(消息面向用户)。 */
export async function saveCardBg(
	dataDir: string,
	bytes: Uint8Array,
	mime: string,
): Promise<string> {
	const ext = MIME_TO_EXT[mime];
	if (!ext) throw new Error(`不支持的图片类型：${mime}（仅 PNG / JPEG / WebP）`);
	if (bytes.byteLength > MAX_CARD_BG_BYTES) throw new Error("图片过大（上限 5MB）");
	const id = `${randomBytes(16).toString("hex")}.${ext}`;
	const dir = cardBgDir(dataDir);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, id), bytes);
	return id;
}

/** 读背景图原始字节 + mime;id 非法或文件缺失返回 null(供服务路由)。 */
export async function readCardBg(
	dataDir: string,
	id: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
	if (!isValidCardBgId(id)) return null;
	const ext = id.split(".").pop() as string;
	try {
		const bytes = await readFile(join(cardBgDir(dataDir), id));
		return { bytes, mime: EXT_TO_MIME[ext] ?? "application/octet-stream" };
	} catch {
		return null;
	}
}

/** 读背景图并转 data URL;id 为空 / 非法 / 缺失时返回 ""(供渲染期内联)。 */
export async function readCardBgDataUrl(dataDir: string, id: string): Promise<string> {
	if (!id) return "";
	const res = await readCardBg(dataDir, id);
	if (!res) return "";
	return `data:${res.mime};base64,${res.bytes.toString("base64")}`;
}

/**
 * 取列表里第一张盘上真实存在的图的 id;全悬空 / 空列表返回 ""。
 * 配置里的 id 可能指向已删盘的文件(历史悬空引用、卷丢失)——直接取 `[0]` 会解析失败
 * 静默回退渐变 / 原封面,预览与静态兜底取图一律经此跳过死条目。
 */
export async function firstExistingCardBg(
	dataDir: string,
	ids: string[] | undefined,
): Promise<string> {
	for (const id of ids ?? []) {
		if (!isValidCardBgId(id)) continue;
		try {
			await access(join(cardBgDir(dataDir), id));
			return id;
		} catch {
			// 文件不存在 → 试下一张
		}
	}
	return "";
}

/** existsSync 缓存的存活期 —— 权衡"删图后多久轮换才会跳过它"与"推送热路径少碰几次盘"。 */
const EXISTING_IDS_TTL_MS = 5_000;

/**
 * 包一层推送轮换选择器:选图前过滤掉盘上已不存在的资产 id,轮换永远只在真实存在的图里转
 * (悬空条目不占游标位、不会渲染成空背景)。过滤后为空返回 undefined → 调用点静态兜底。
 *
 * pick 在推送点同步推进游标,过滤必须同步完成。稳态下靠一份短 TTL 的 id 集合缓存
 * (后台异步 readdir 刷新)做 Set.has() 判断,不再对轮换列表逐张 existsSync ——
 * 高频推送 / 慢速存储(网络卷等)下避免每次推送都拿同步 stat 卡一下事件循环。
 * 仅缓存冷启动(尚未有过一次成功 readdir)时退化到同步 existsSync 兜底,保正确性。
 */
export function makeExistingCardBgPicker(
	dataDir: string,
	pick: (scopeKey: string, images: string[]) => string | undefined,
): (scopeKey: string, images: string[]) => string | undefined {
	let cachedIds: Set<string> | null = null;
	let cachedAt = 0;
	let refreshing: Promise<void> | null = null;
	const refresh = (): void => {
		if (refreshing) return;
		refreshing = readdir(cardBgDir(dataDir))
			.then((names) => {
				cachedIds = new Set(names.filter(isValidCardBgId));
				cachedAt = Date.now();
			})
			.catch(() => {
				// 目录不存在等 → 保留旧缓存(或仍为 null),下次调用到期再试。
			})
			.finally(() => {
				refreshing = null;
			});
	};
	return (scopeKey, images) => {
		if (cachedIds === null || Date.now() - cachedAt > EXISTING_IDS_TTL_MS) refresh();
		const exists = (id: string): boolean =>
			cachedIds !== null ? cachedIds.has(id) : existsSync(join(cardBgDir(dataDir), id));
		const existing = images.filter((id) => isValidCardBgId(id) && exists(id));
		return existing.length > 0 ? pick(scopeKey, existing) : undefined;
	};
}
