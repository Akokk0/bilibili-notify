/**
 * 聊天附件的本地资产存储。落盘到 `<dataRoot>/assets/chat/`,资产 id = 文件名
 * `<32-hex>.<ext>`。
 *
 * 与卡片背景图(card-assets)同形却**另起一份**,是因为两者生命周期完全不同:
 * 背景图是主人精心挑的长期素材,由图廊管理、删前还要查引用;聊天附件是随手一发、
 * 跟着会话生灭的。混在一个目录里,删会话时就没法只清自己那几张。
 *
 * 存 id 而不是把 base64 塞进会话文件:会话是整份读进内存的,一张 2MB 的图变成
 * 2.7MB base64 混在 JSON 里,往后每次打开这个会话都要扛一遍。
 *
 * 安全:**不**用 serveStatic 暴露 dataRoot(里面有 `bn.config.yaml`,带 apiKey 与
 * cookie)。id 从 HTTP 请求原样进来,{@link isValidChatImageId} 是唯一那道闸。
 *
 * 存取本身(取名、认后缀、落盘、读回、删除)由 `createAssetStore` 管;这里只留聊天附件
 * 自己的规矩 —— 5MB 上限、每条消息的张数、用户可见的拒收消息,以及转 data URL 那一步。
 */

import {
	AssetRejectedError,
	type AssetStore,
	createAssetStore,
	isValidAssetId,
} from "../assets/asset-store.js";
import { MIME_TO_EXT, UPLOAD_EXT_TO_MIME } from "./image-mime.js";
import { dataPath } from "./roots.js";

/** 单张附件上限 5MB —— 与卡片背景图同口径。 */
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;

/** 一条消息最多带几张图。与动态点评那条路的上限一致(`extractDynamicImages`)。 */
export const MAX_CHAT_IMAGES_PER_MESSAGE = 4;

/** 聊天附件目录 `<dataRoot>/assets/chat`。 */
export function chatImageDir(dataRoot: string): string {
	return dataPath(dataRoot, "assets", "chat");
}

/**
 * 存储的规矩。资产 id 严格形如 `<32 位小写 hex>.<png|jpg|jpeg|webp>`(格式表见
 * `UPLOAD_EXT_TO_MIME`)。
 *
 * SVG 刻意不在白名单里 —— 它能带脚本,而这些图会在 dashboard 里直接渲染。
 */
const RULES = {
	formats: UPLOAD_EXT_TO_MIME,
	maxBytes: MAX_CHAT_IMAGE_BYTES,
	naming: { kind: "random" },
} as const;

const storeOf = (dataRoot: string): AssetStore =>
	createAssetStore({ ...RULES, dir: chatImageDir(dataRoot) });

/** id 是否合法(防穿越的唯一闸门)。 */
export function isValidChatImageId(id: string): boolean {
	return isValidAssetId(RULES, id);
}

/** 保存一张附件,返回资产 id(= 文件名)。非白名单 mime 或超限抛 {@link AssetRejectedError}(消息面向用户)。 */
export async function saveChatImage(
	dataRoot: string,
	bytes: Uint8Array,
	mime: string,
): Promise<string> {
	const ext = MIME_TO_EXT[mime];
	if (!ext) throw new AssetRejectedError(`不支持的图片类型：${mime}（仅 PNG / JPEG / WebP）`);
	if (bytes.byteLength > MAX_CHAT_IMAGE_BYTES) throw new AssetRejectedError("图片过大（上限 5MB）");
	const result = await storeOf(dataRoot).put({ bytes, ext });
	// 上面已按同一套规矩判过,走到这里被拒说明两边对不上 —— 是 bug,不是用户输入的事。
	if (!result.ok) throw new Error(result.message);
	return result.id;
}

/** 读附件原始字节 + mime;id 非法或文件缺失返回 null(供服务路由)。 */
export async function readChatImage(
	dataRoot: string,
	id: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
	return await storeOf(dataRoot).read(id);
}

/**
 * 读附件并转 data URL;id 为空 / 非法 / 缺失时返回 ""。
 *
 * 视觉模型只能吃 data URL,不能吃链接 —— 服务商在公网,拉不到主人本地的
 * `http://localhost:9000/...`。这与 B 站动态里的图不同(那些本来就是公网可达的)。
 */
export async function readChatImageDataUrl(dataRoot: string, id: string): Promise<string> {
	if (!id) return "";
	const res = await readChatImage(dataRoot, id);
	if (!res) return "";
	return `data:${res.mime};base64,${res.bytes.toString("base64")}`;
}

/** 删一张附件。id 非法 / 文件不存在返回 false(幂等);删成功返回 true。 */
export async function deleteChatImage(dataRoot: string, id: string): Promise<boolean> {
	return await storeOf(dataRoot).remove(id);
}
