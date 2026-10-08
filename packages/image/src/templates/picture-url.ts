/**
 * `PostImage` → 卡里能画的地址(㉑d)。
 *
 * 出卡**只认 `ref`**(图库引用),由调用方给的 {@link ImageUrlOf} 事先解析好、同步查。`url` 是这张图的来源地址,
 * 留给来源在出卡前把它抓进图库用,出图器不画它:渲染页不联网(浏览器适配层的请求闸只放行 `data:`),地址进了卡
 * 也画不出来。引用解析不到(图已被清扫)、只有 `url`(来源没抓到)、两样都没有,一律画占位、不抛 —— 一张图坏了
 * 不该让整张卡出不来,更不该画一个裂图。
 */

import type { PostImage } from "@bilibili-notify/internal";
import type { ImageUrlOf } from "../rich-text";
import { BLOCKED_IMG_PLACEHOLDER } from "../skin/render-skin";

export function pictureUrl(image: PostImage | undefined, imageUrl?: ImageUrlOf): string {
	if (image?.ref === undefined) return BLOCKED_IMG_PLACEHOLDER;
	return imageUrl?.(image.ref) ?? BLOCKED_IMG_PLACEHOLDER;
}
