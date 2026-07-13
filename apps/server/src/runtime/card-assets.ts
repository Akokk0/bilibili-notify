/**
 * 卡片背景图的本地资产存储。落盘到 `<dataDir>/assets/card-bg/`,资产 id = 文件名
 * `<32-hex>.<ext>`。**不**用 serveStatic 暴露整个 dataDir(里面有 secrets);只经此模块
 * 的定向读取 + 路由的 id 正则校验访问,杜绝路径穿越。渲染期由服务端把 id 解析成 data URL
 * 内联给模版(packages/image 不碰文件系统)。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
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
