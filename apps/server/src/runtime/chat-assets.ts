/**
 * 聊天附件的本地资产存储。落盘到 `<dataDir>/assets/chat/`,资产 id = 文件名
 * `<32-hex>.<ext>`。
 *
 * 与卡片背景图(card-assets)同形却**另起一份**,是因为两者生命周期完全不同:
 * 背景图是主人精心挑的长期素材,由图廊管理、删前还要查引用;聊天附件是随手一发、
 * 跟着会话生灭的。混在一个目录里,删会话时就没法只清自己那几张。
 *
 * 存 id 而不是把 base64 塞进会话文件:会话是整份读进内存的,一张 2MB 的图变成
 * 2.7MB base64 混在 JSON 里,往后每次打开这个会话都要扛一遍。
 *
 * 安全:**不**用 serveStatic 暴露 dataDir(里面有 `bn.config.yaml`,带 apiKey 与
 * cookie)。id 从 HTTP 请求原样进来,{@link isValidChatImageId} 是唯一那道闸。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 单张附件上限 5MB —— 与卡片背景图同口径。 */
const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;

/** 一条消息最多带几张图。与动态点评那条路的上限一致(`extractDynamicImages`)。 */
export const MAX_CHAT_IMAGES_PER_MESSAGE = 4;

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
/**
 * 资产 id 严格形如 `<32 位小写 hex>.<png|jpg|jpeg|webp>`。
 *
 * SVG 刻意不在白名单里 —— 它能带脚本,而这些图会在 dashboard 里直接渲染。
 */
const ID_RE = /^[a-f0-9]{32}\.(png|jpe?g|webp)$/;

/** 聊天附件目录 `<dataDir>/assets/chat`。 */
export function chatImageDir(dataDir: string): string {
	return join(dataDir, "assets", "chat");
}

/** id 是否合法(防穿越的唯一闸门)。 */
export function isValidChatImageId(id: string): boolean {
	return ID_RE.test(id);
}

/** 保存一张附件,返回资产 id(= 文件名)。非白名单 mime 或超限抛错(消息面向用户)。 */
export async function saveChatImage(
	dataDir: string,
	bytes: Uint8Array,
	mime: string,
): Promise<string> {
	const ext = MIME_TO_EXT[mime];
	if (!ext) throw new Error(`不支持的图片类型：${mime}（仅 PNG / JPEG / WebP）`);
	if (bytes.byteLength > MAX_CHAT_IMAGE_BYTES) throw new Error("图片过大（上限 5MB）");
	const id = `${randomBytes(16).toString("hex")}.${ext}`;
	const dir = chatImageDir(dataDir);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, id), bytes);
	return id;
}

/** 读附件原始字节 + mime;id 非法或文件缺失返回 null(供服务路由)。 */
export async function readChatImage(
	dataDir: string,
	id: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
	if (!isValidChatImageId(id)) return null;
	const ext = id.split(".").pop() as string;
	try {
		const bytes = await readFile(join(chatImageDir(dataDir), id));
		return { bytes, mime: EXT_TO_MIME[ext] ?? "application/octet-stream" };
	} catch {
		return null;
	}
}

/**
 * 读附件并转 data URL;id 为空 / 非法 / 缺失时返回 ""。
 *
 * 视觉模型只能吃 data URL,不能吃链接 —— 服务商在公网,拉不到主人本地的
 * `http://localhost:9000/...`。这与 B 站动态里的图不同(那些本来就是公网可达的)。
 */
export async function readChatImageDataUrl(dataDir: string, id: string): Promise<string> {
	if (!id) return "";
	const res = await readChatImage(dataDir, id);
	if (!res) return "";
	return `data:${res.mime};base64,${res.bytes.toString("base64")}`;
}

/** 删一张附件。id 非法 / 文件不存在返回 false(幂等);删成功返回 true。 */
export async function deleteChatImage(dataDir: string, id: string): Promise<boolean> {
	if (!isValidChatImageId(id)) return false;
	try {
		await unlink(join(chatImageDir(dataDir), id));
		return true;
	} catch {
		return false;
	}
}
