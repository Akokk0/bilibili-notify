/**
 * 主人上传的字体文件的本地资产存储。落盘到 `<dataDir>/assets/font/`,资产 id = 文件名
 * `<32-hex>.<ext>`。**不**用 serveStatic 暴露整个 dataDir(里面有 secrets);只经此模块
 * 的定向读取 + 路由的 id 正则校验访问,杜绝路径穿越。渲染期由服务端把 id 解析成 data URL
 * 拼进 `@font-face` 内联给模版(`packages/image` 不碰文件系统)。
 *
 * 整体照抄 `card-assets.ts` 的形态,两处刻意不一样:
 *
 * 1. **后缀取自原始文件名,不看 mime。** 图片的 mime 各家浏览器给得准,字体不然:同一个
 *    .ttf 可能是 `font/ttf`、`application/x-font-ttf`、`application/octet-stream`、
 *    甚至空串。照 mime 判会把一堆正常字体拒在门外。
 * 2. **记住原始文件名。** 背景图有缩略图可看,字体没有 —— 列表里只剩一串 hex 主人根本
 *    认不出哪个是哪个。名字存同目录的 `index.json`,而**目录才是真相**:清单丢了照样列
 *    得出字体(名字回落成 id),清单里多出盘上没有的记录则一概不列。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 单款字体上限 20MB —— 完整中文字库的 ttf/otf 单字重就有 15-25MB。
 *
 * 它会被 base64 内联进渲染 HTML(再涨 33%),与背景图同一条路,而 Docker 那边堆上限是
 * 384MB。所以设置页要引导主人优先用 woff2(同一套字通常只占 ttf 的 1/3),解析结果也
 * 在渲染器里缓存住,不每张卡重算一遍。
 */
export const MAX_FONT_ASSET_BYTES = 20 * 1024 * 1024;

/** 后缀 → data URL 用的 mime(RFC 8081 的 `font/*`,Chromium 认)。 */
const EXT_TO_MIME: Record<string, string> = {
	woff2: "font/woff2",
	woff: "font/woff",
	ttf: "font/ttf",
	otf: "font/otf",
};

/** 资产 id 严格形如 `<32 位小写 hex>.<woff2|woff|ttf|otf>` —— 排除 `..` / `/` 等穿越。 */
const ID_RE = /^[a-f0-9]{32}\.(woff2|woff|ttf|otf)$/;

/** 名字清单的文件名。它住在资产目录里,故 id 正则不会让它被当成一款字体读出去。 */
const MANIFEST = "index.json";

/** 字体资产目录 `<dataDir>/assets/font`。 */
export function fontAssetDir(dataDir: string): string {
	return join(dataDir, "assets", "font");
}

/** id 是否合法(防穿越的唯一闸门)。 */
export function isValidFontAssetId(id: string): boolean {
	return ID_RE.test(id);
}

/** 原始文件名 → 后缀;认不出返回 undefined(调用方据此拒收)。 */
function extOf(filename: string): string | undefined {
	const ext = filename.toLowerCase().split(".").pop();
	return ext && ext in EXT_TO_MIME ? ext : undefined;
}

/** 读名字清单;缺失 / 损坏一律当空 —— 名字没了不该让整个图廊瘫掉。 */
async function readManifest(dataDir: string): Promise<Record<string, string>> {
	try {
		const parsed: unknown = JSON.parse(
			await readFile(join(fontAssetDir(dataDir), MANIFEST), "utf8"),
		);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, string>)
			: {};
	} catch {
		return {};
	}
}

async function writeManifest(dataDir: string, next: Record<string, string>): Promise<void> {
	const dir = fontAssetDir(dataDir);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, MANIFEST), JSON.stringify(next, null, 2));
}

/** 图廊里的一款字体。`name` 是上传时的原始文件名(清单丢了则回落成 id)。 */
export interface FontAsset {
	id: string;
	name: string;
}

/**
 * 列出图廊里所有字体。**以目录为真相**:盘上有的才列,清单只贡献名字。
 * 目录不存在或读失败返回 []。
 */
export async function listFontAssets(dataDir: string): Promise<FontAsset[]> {
	let names: string[];
	try {
		names = await readdir(fontAssetDir(dataDir));
	} catch {
		return [];
	}
	const manifest = await readManifest(dataDir);
	return names.filter(isValidFontAssetId).map((id) => ({ id, name: manifest[id] ?? id }));
}

/**
 * 保存上传的字体,返回资产 id(= 文件名)。后缀不认或超限抛错(消息面向用户)。
 * 原始文件名记进清单,供设置页显示。
 */
export async function saveFontAsset(
	dataDir: string,
	bytes: Uint8Array,
	filename: string,
): Promise<string> {
	const ext = extOf(filename);
	if (!ext) {
		throw new Error(`不支持的字体格式：${filename}（仅 woff2 / woff / ttf / otf）`);
	}
	if (bytes.byteLength > MAX_FONT_ASSET_BYTES) {
		throw new Error(
			`字体文件过大（上限 20MB，这个 ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB）—— 同一套字转成 woff2 通常只占三分之一`,
		);
	}
	const id = `${randomBytes(16).toString("hex")}.${ext}`;
	const dir = fontAssetDir(dataDir);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, id), bytes);
	await writeManifest(dataDir, { ...(await readManifest(dataDir)), [id]: filename });
	return id;
}

/** 读字体原始字节 + mime;id 非法或文件缺失返回 null(供服务路由)。 */
export async function readFontAsset(
	dataDir: string,
	id: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
	if (!isValidFontAssetId(id)) return null;
	const ext = id.split(".").pop() as string;
	try {
		const bytes = await readFile(join(fontAssetDir(dataDir), id));
		return { bytes, mime: EXT_TO_MIME[ext] ?? "application/octet-stream" };
	} catch {
		return null;
	}
}

/**
 * 读字体并转 data URL;id 为空 / 非法 / 缺失时返回 ""(供渲染期内联)。
 *
 * 返回空串而不是抛错:主人把字体删了、卷丢了,出图该静静回落到家族名那条路,
 * 而不是整张卡渲染失败 —— 与背景图同一条纪律。
 */
export async function readFontAssetDataUrl(dataDir: string, id: string): Promise<string> {
	if (!id) return "";
	const res = await readFontAsset(dataDir, id);
	if (!res) return "";
	return `data:${res.mime};base64,${res.bytes.toString("base64")}`;
}

/**
 * 从图廊删除一款字体。id 非法 / 文件不存在返回 false(幂等);删成功返回 true。
 * 清单里那条一并抹掉 —— 留着就是个永远对不上的名字。
 */
export async function deleteFontAsset(dataDir: string, id: string): Promise<boolean> {
	if (!isValidFontAssetId(id)) return false;
	try {
		await unlink(join(fontAssetDir(dataDir), id));
	} catch {
		return false;
	}
	const manifest = await readManifest(dataDir);
	if (id in manifest) {
		delete manifest[id];
		await writeManifest(dataDir, manifest);
	}
	return true;
}
