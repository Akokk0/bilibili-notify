/**
 * 把一张**网上的图**下载成皮肤包里的资产。皮肤工坊「找张壁纸」那条路的落点。
 *
 * 这是这个功能里唯一新增的**出站请求面**,所以每一道闸都写在这儿:
 *
 * - **URL 不由模型给**。调用方只准传「上一次图片搜索返回过的那几条」里的一条
 *   (见 chat-tool 的候选表),模型手上只有序号。模型能编出 `http://127.0.0.1:9000/`,
 *   编不出一个不在候选表里的序号。
 * - **目标 IP 过内网黑名单**:搜索结果本身也是第三方数据,后端被投毒同样能塞进
 *   一个指向内网的链接。域名先解析,解析出来的每个地址都不许落在私有段。
 * - **不跟重定向**:跟了就等于把上面那道 IP 检查作废(302 到 169.254.169.254 是
 *   云上取元数据的经典手法)。
 * - **体积与字节都验**:Content-Length 先筛一道,读完再按真实长度复核;类型只认
 *   PNG / JPEG / WebP 的**字节魔数**,不信 Content-Type(那是对方说了算的)。
 *
 * 拿到的字节交给 SkinStore.addAsset,文件名仍由那边生成。
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { MAX_ASSET_BYTES } from "./package.js";

/** 单张壁纸的墙钟上限。下载挂起不能拖死整条生成链路。 */
const TIMEOUT_MS = 20_000;

export interface FetchedWallpaper {
	bytes: Uint8Array;
	/** png / jpg / webp —— 由字节魔数判定,不看扩展名也不看 Content-Type。 */
	ext: string;
}

/** 域名解析口子;测试注入,生产走 node:dns。 */
export type AddressLookup = (hostname: string) => Promise<string[]>;

const defaultLookup: AddressLookup = async (hostname) => {
	const all = await lookup(hostname, { all: true });
	return all.map((a) => a.address);
};

/**
 * 私有 / 环回 / 链路本地 / 保留地址。命中即拒 —— 这些地址后面坐着的是主人自己的
 * 机器和内网服务,而不是壁纸。
 */
export function isPrivateAddress(ip: string): boolean {
	const v = isIP(ip);
	if (v === 4) {
		const [a = 0, b = 0] = ip.split(".").map(Number);
		if (a === 10 || a === 127 || a === 0) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 169 && b === 254) return true; // 链路本地(含云元数据 169.254.169.254)
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		return false;
	}
	if (v === 6) {
		const low = ip.toLowerCase();
		if (low === "::" || low === "::1") return true;
		if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) return true;
		// IPv4 映射地址(::ffff:127.0.0.1)按它内含的 v4 判
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(low);
		if (mapped?.[1]) return isPrivateAddress(mapped[1]);
		return false;
	}
	// 解析不出形状的东西不放行
	return true;
}

/** 字节魔数 → 扩展名;认不出来返回 null。 */
export function imageExtOf(bytes: Uint8Array): string | null {
	const b = bytes;
	if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		return "png";
	}
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
	if (
		b.length >= 12 &&
		b[0] === 0x52 && // R
		b[1] === 0x49 && // I
		b[2] === 0x46 && // F
		b[3] === 0x46 && // F
		b[8] === 0x57 && // W
		b[9] === 0x45 && // E
		b[10] === 0x42 && // B
		b[11] === 0x50 // P
	) {
		return "webp";
	}
	return null;
}

export async function fetchWallpaperImage(
	url: string,
	opts?: { lookupAddresses?: AddressLookup },
): Promise<FetchedWallpaper> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("图片地址不合法");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("只支持 http(s) 的图片地址");
	}

	const host = parsed.hostname.replace(/^\[|\]$/g, "");
	// 字面量 IP 直接判;域名先解析,**每个**解析结果都得干净(一个域名可以同时
	// 指向公网和内网)。
	const addresses = isIP(host) ? [host] : await (opts?.lookupAddresses ?? defaultLookup)(host);
	if (addresses.length === 0) throw new Error("图片地址解析不到服务器");
	if (addresses.some(isPrivateAddress)) throw new Error("这个地址指向内网,不下载");

	const res = await fetch(parsed.toString(), {
		// 跟重定向就等于把上面的 IP 检查作废。
		redirect: "error",
		signal: AbortSignal.timeout(TIMEOUT_MS),
		headers: { accept: "image/*" },
	}).catch((e) => {
		throw new Error(`图片下载失败:${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
	});
	if (!res.ok) throw new Error(`图片下载失败:HTTP ${res.status}`);

	const claimed = Number(res.headers.get("content-length") ?? "0");
	if (claimed > MAX_ASSET_BYTES) throw new Error("图片太大(上限 5MB)");
	const bytes = new Uint8Array(await res.arrayBuffer());
	// 声称的大小骗得过,真实长度骗不过。
	if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error("图片太大(上限 5MB)");

	const ext = imageExtOf(bytes);
	if (!ext) throw new Error("下下来的不是 PNG / JPEG / WebP 图片");
	return { bytes, ext };
}
