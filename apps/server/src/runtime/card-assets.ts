/**
 * 卡片背景图的本地资产存储。落盘到 `<dataDir>/assets/card-bg/`,资产 id = 文件名
 * `<32-hex>.<ext>`。**不**用 serveStatic 暴露整个 dataDir(里面有 secrets);只经此模块
 * 的定向读取 + 路由的 id 校验访问,杜绝路径穿越。渲染期由服务端把 id 解析成 data URL
 * 内联给模版(packages/image 不碰文件系统)。
 *
 * 存取本身(取名、认后缀、落盘、读回、列出、删除)由 `createAssetStore` 管;这里只留背景图
 * 自己的规矩 —— 5MB 上限、用户可见的拒收消息,以及渲染期 / 推送轮换那几个消费层函数。
 */

import { existsSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type AssetStore, createAssetStore, isValidAssetId } from "../assets/asset-store.js";
import { MIME_TO_EXT, UPLOAD_EXT_TO_MIME } from "./image-mime.js";

/** 单张背景图上限 5MB(前端应先压缩;这里是兜底)。 */
export const MAX_CARD_BG_BYTES = 5 * 1024 * 1024;

/** 背景图资产目录 `<dataDir>/assets/card-bg`。 */
export function cardBgDir(dataDir: string): string {
	return join(dataDir, "assets", "card-bg");
}

const RULES = {
	formats: UPLOAD_EXT_TO_MIME,
	maxBytes: MAX_CARD_BG_BYTES,
	naming: { kind: "random" },
} as const;

const storeOf = (dataDir: string): AssetStore =>
	createAssetStore({ ...RULES, dir: cardBgDir(dataDir) });

/** id 是否合法(防穿越的唯一闸门)。 */
export function isValidCardBgId(id: string): boolean {
	return isValidAssetId(RULES, id);
}

/** 从图廊删除一张背景图。id 非法 / 文件不存在返回 false(幂等);删成功返回 true。 */
export async function deleteCardBg(dataDir: string, id: string): Promise<boolean> {
	return await storeOf(dataDir).remove(id);
}

/** 列出图廊里所有合法背景图 id;目录不存在或读失败返回 []。供图廊列表路由。 */
export async function listCardBg(dataDir: string): Promise<string[]> {
	return (await storeOf(dataDir).list()).map((asset) => asset.id);
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
	const result = await storeOf(dataDir).put({ bytes, ext });
	// 上面已按同一套规矩判过,走到这里被拒说明两边对不上 —— 是 bug,不是用户输入的事。
	if (!result.ok) throw new Error(result.message);
	return result.id;
}

/** 读背景图原始字节 + mime;id 非法或文件缺失返回 null(供服务路由)。 */
export async function readCardBg(
	dataDir: string,
	id: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
	return await storeOf(dataDir).read(id);
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
	const store = storeOf(dataDir);
	for (const id of ids ?? []) {
		const path = store.pathOf(id);
		if (path === null) continue;
		try {
			await access(path);
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
	const store = storeOf(dataDir);
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
		const exists = (id: string): boolean => {
			if (cachedIds !== null) return cachedIds.has(id);
			const path = store.pathOf(id);
			return path !== null && existsSync(path);
		};
		const existing = images.filter((id) => isValidCardBgId(id) && exists(id));
		return existing.length > 0 ? pick(scopeKey, existing) : undefined;
	};
}
