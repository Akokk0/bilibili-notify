/**
 * 主人上传的字体文件的本地资产存储。落盘到 `<dataDir>/assets/font/`,资产 id = 文件名
 * `<32-hex>.<ext>`。**不**用 serveStatic 暴露整个 dataDir(里面有 secrets);只经此模块
 * 的定向读取 + 路由的 id 正则校验访问,杜绝路径穿越。渲染期由服务端把 id 解析成 data URL
 * 拼进 `@font-face` 内联给模版(`packages/image` 不碰文件系统)。
 *
 * 整体照抄 `card-assets.ts` 的形态,两处刻意不一样:
 *
 * 1. **后缀取自原始文件名,不看 mime**(见 `font-mime.ts`,那张表与皮肤包自带字体共用)。
 * 2. **记住原始文件名。** 背景图有缩略图可看,字体没有 —— 列表里只剩一串 hex 主人根本
 *    认不出哪个是哪个。名字存同目录的 `index.json`,而**目录才是真相**:清单丢了照样列
 *    得出字体(名字回落成 id),清单里多出盘上没有的记录则一概不列。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FONT_ASSET_WARN_BYTES, MAX_FONT_ASSET_BYTES } from "@bilibili-notify/internal/constants";
import { parseAssetNames, sanitizeAssetLabel } from "./asset-labels.js";
import { FONT_EXT_TO_MIME, fontExtOf } from "./font-mime.js";

/**
 * 单款字体上限 —— 与前端共用一个数(`@bilibili-notify/internal/constants`),否则两边各写
 * 一个 20MB,改了一处另一处照旧,主人看到的说明和实际拒收线就对不上。
 *
 * 超过 {@link FONT_ASSET_WARN_BYTES} 的**不拒**,只在设置页提醒转 woff2:上限是按文件
 * 本身多大定的,没算出图开销(base64 内联再涨三分之一,而镜像堆上限只有 512MB),但降
 * 上限会把主人已经传上去的那款挡在门外。
 */
export { FONT_ASSET_WARN_BYTES, MAX_FONT_ASSET_BYTES };

/** 资产 id 严格形如 `<32 位小写 hex>.<woff2|woff|ttf|otf>` —— 排除 `..` / `/` 等穿越。 */
const ID_RE = /^[a-f0-9]{32}\.(woff2|woff|ttf|otf)$/;

/** 名字清单的文件名。它住在资产目录里,故 id 正则不会让它被当成一款字体读出去。 */
const MANIFEST = "index.json";

/**
 * 字体缓存的闲置释放上限。跟「空闲就把浏览器关掉」同一套路数:占大头的东西没人用了
 * 就该放掉,而不是攒到进程结束。5 分钟远长于一轮推送里几张卡的间隔,热路径不受影响。
 */
const DEFAULT_FONT_CACHE_IDLE_MS = 5 * 60_000;

/** 字体资产目录 `<dataDir>/assets/font`。 */
export function fontAssetDir(dataDir: string): string {
	return join(dataDir, "assets", "font");
}

/** id 是否合法(防穿越的唯一闸门)。 */
export function isValidFontAssetId(id: string): boolean {
	return ID_RE.test(id);
}

/**
 * 读名字清单;缺失 / 损坏一律当空 —— 名字没了不该让整个图廊瘫掉。
 *
 * 内容过 {@link parseAssetNames}:键得是合法字体 id、值得清洗得出一个能显示的标签,
 * 不合格的只丢那一条。清单文件是盘上的普通 JSON,能被手改、能从别处拷来,不该因为
 * 它写着 `{"x": 42}` 就让 `name` 撒谎说自己是字符串。
 */
async function readManifest(dataDir: string): Promise<Record<string, string>> {
	try {
		const parsed: unknown = JSON.parse(
			await readFile(join(fontAssetDir(dataDir), MANIFEST), "utf8"),
		);
		return parseAssetNames(parsed, isValidFontAssetId);
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
	/**
	 * 文件字节数。列表里带上它,设置页那句「这款大到会把出图撑爆」才能**按当前选中的
	 * 那款**算出来 —— 从前只在上传那一下提醒一次,重载页面就没了,而正被 OOM 折磨的
	 * 主人恰恰是重载之后来看这块界面的。读不到大小(文件刚被删)记 0,不影响列出。
	 */
	size: number;
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
	const dir = fontAssetDir(dataDir);
	return await Promise.all(
		names.filter(isValidFontAssetId).map(async (id) => ({
			id,
			name: manifest[id] ?? id,
			size: await fileSize(join(dir, id)),
		})),
	);
}

/** 文件字节数;读不到(刚被删 / 权限)记 0 —— 少一句提醒好过整个图廊列不出来。 */
async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
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
	const ext = fontExtOf(filename);
	if (!ext) {
		throw new Error(`不支持的字体格式：${filename}（仅 woff2 / woff / ttf / otf）`);
	}
	if (bytes.byteLength > MAX_FONT_ASSET_BYTES) {
		throw new Error(
			// 上限从常量算,别硬写 —— 写死的话改了常量这句话还在说旧数字。
			`字体文件过大（上限 ${Math.round(MAX_FONT_ASSET_BYTES / 1024 / 1024)}MB，这个 ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB）—— 同一套字转成 woff2 通常只占三分之一`,
		);
	}
	const id = `${randomBytes(16).toString("hex")}.${ext}`;
	const dir = fontAssetDir(dataDir);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, id), bytes);
	// 存进去的就先洗一遍(读出来那头也洗):浏览器给的这一串可能是整条桌面路径,
	// 也可能带着双向覆盖符 —— 让它显示成别的文件名,就把这个功能反过来用了。
	const label = sanitizeAssetLabel(filename);
	await writeManifest(dataDir, {
		...(await readManifest(dataDir)),
		...(label ? { [id]: label } : {}),
	});
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
		return { bytes, mime: FONT_EXT_TO_MIME[ext] ?? "application/octet-stream" };
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
 * 造一个**带缓存**的字体资产读取器,只留一条缓存。
 *
 * 直接用 {@link readFontAssetDataUrl} 的地方每次都会从头读一遍盘、再搓一个 base64
 * 字符串。一款完整中文字库十几到几十兆,base64 之后还要再涨三分之一,而 Docker 镜像
 * 里 V8 的 old-space 上限被压到 512MB(见 `apps/Dockerfile`)—— 预览路由那条 mock
 * 路径(live / dyn 走示例数据)是**每个请求**读一次,一屏几张卡就能把堆顶起来。
 *
 * 按 **id** 缓存是安全的:资产 id 是随机 32 位 hex,换字体必然换 id,删掉再传也是新
 * id,所以缓存永远不会喂出过期内容,不需要看 mtime。只留一条 —— 同一时刻真正在用的
 * 通常就一款,攒着已经不用的那几十兆没有意义。
 *
 * 缓存里存的是**那次读取本身**(promise)而不是结果:并发同一款时后来者搭上前一次
 * 的车,不会各读各的。读不出来(资产悬空,约定返回空串)与读崩了都不留缓存 —— 前者
 * 是为了重新传一份还能拿回来,后者是别把一个 rejected promise 焊死在那儿。
 */
export function createFontAssetReader(
	dataDir: string,
	opts: {
		/**
		 * data URL → **缓存里真正留下的那个串**。缺省原样留 data URL。
		 *
		 * 渲染那条路传 `buildFontFace`:留拼好的 `@font-face` 规则,原始 data URL 随即
		 * 可被回收 —— 规则本身就把它包在里头,两个都留就是白占一份几十兆。
		 */
		transform?: (dataUrl: string) => string;
		/** 底层读取,默认真读盘;注入便于单测观察读了几次。 */
		read?: (dataDir: string, id: string) => Promise<string>;
		/**
		 * 闲置多久就把缓存放掉(ms),默认 5 分钟。
		 *
		 * 只留一条缓存不等于「留得住」—— 主人把卡片切回默认字体之后,那份拼好的
		 * `@font-face` 没有任何一条路径会再碰它,却会一直挂到进程结束;一款几十兆的
		 * 中文字库在镜像那 512MB 的堆里就是白扔一大块。
		 *
		 * 释放的触发点是**闲置**,不是「这张卡没选字体」。`fontAsset` 能按 UP 覆盖,
		 * 「这个 UP 有字体、那个用默认」是常态,拿 `load("")` 当释放信号会让交替渲染
		 * 反复读盘 + 重搓 base64 —— 那是拿一个 OOM 换另一个。
		 *
		 * 惰性判定,不挂定时器:每次调用先扫一眼过没过期。于是释放必定发生在下一次
		 * 分配**之前**,也就是堆压力真正到来的那一刻,而进程闲着时也没有 timer 要收。
		 */
		idleMs?: number;
		/** 取当前时刻,默认 `Date.now`;注入便于单测拨表。 */
		now?: () => number;
	} = {},
): (id: string) => Promise<string> {
	const read = opts.read ?? readFontAssetDataUrl;
	const transform = opts.transform;
	const idleMs = opts.idleMs ?? DEFAULT_FONT_CACHE_IDLE_MS;
	const now = opts.now ?? Date.now;
	let cached: { id: string; pending: Promise<string>; lastUsedAt: number } | null = null;

	return async function load(id: string): Promise<string> {
		// 先扫过期再干别的 —— 包括 id 为空这条路:不带字体的卡也是一次「没人再要它」
		// 的机会,错过它,取消选择之后就再没有任何调用会来收这几十兆。
		if (cached && now() - cached.lastUsedAt >= idleMs) cached = null;
		if (!id) return "";
		if (cached?.id !== id) {
			// transform 在这儿跑一次就定住 —— 放到下面每次 await 之后跑,等于每张卡重拼一遍。
			// 解析不出来(空串)保持空串,别拼出一条 src 为空的规则。
			cached = {
				id,
				pending: transform
					? read(dataDir, id).then((v) => (v ? transform(v) : ""))
					: read(dataDir, id),
				lastUsedAt: now(),
			};
		}
		const entry = cached;
		// 命中也要续期,否则一直在用的那款也会到点被扔掉,下一张卡又从盘上搓一遍。
		entry.lastUsedAt = now();
		try {
			const dataUrl = await entry.pending;
			// 空串 = 资产悬空。别缓存它,否则主人重新传一份同一个 id 也拿不回来。
			if (!dataUrl && cached === entry) cached = null;
			return dataUrl;
		} catch (err) {
			// 失败的那次读取不能留下 —— 留着就等于把这款字体永久判死。
			if (cached === entry) cached = null;
			throw err;
		}
	};
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
