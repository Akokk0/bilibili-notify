/**
 * 出图器的「图库引用 → 可画的地址」解析口(`ImageRenderer` 的 `resolveImageRef`,㉑d)。
 *
 * 作品卡里的配图、封面、头像、正文小图标都是图库引用,出图器自己不读盘、不联网,出图前把引用交给宿主注入的这个
 * 口。**读字节、转成 data URL**,不给本机地址:
 *
 * - 渲染页只许 `data:`(别的请求被浏览器适配层的闸掐断),不该为了一张作品图去访问本机 HTTP(还得带上面板的鉴权令牌);
 * - 同一份字节转出来的 data URL 逐字相同,所以拓展作品卡从「内存字节」换成「图库字节」后可见内容不变;
 * - 引用指着的图已被清扫(或读盘出错)就回 `undefined`,出图器画占位 —— 一张图坏了不拖累整张卡。
 */

import { Buffer } from "node:buffer";
import type { ImageRef } from "@bilibili-notify/internal";
import type { ImageStore } from "./image-store.js";

/**
 * 一张图的字节 + 类型 → data URL(`data:<mime>;base64,…`)。纯函数:作品点评看图、拓展作品卡、锐评卡与出图器的引用解析
 * 拼的是同一种串,只此一份。
 */
export function bytesDataUrl(mime: string, bytes: Uint8Array): string {
	return `data:${mime};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`;
}

export function imageRefDataUrl(
	store: Pick<ImageStore, "read">,
): (ref: ImageRef) => Promise<string | undefined> {
	return async (ref) => {
		let found: Awaited<ReturnType<ImageStore["read"]>>;
		try {
			found = await store.read(ref);
		} catch {
			return undefined;
		}
		if (!found) return undefined;
		return bytesDataUrl(found.mime, found.bytes);
	};
}
