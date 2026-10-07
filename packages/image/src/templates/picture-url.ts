/**
 * `PostImage` → 卡里能画的地址(㉑d)。
 *
 * 出卡认 `ref`(图库引用),由调用方给的 {@link ImageUrlOf} 事先解析好、同步查;只有 `url` 的(B 站出卡前抓进图库,抓不到
 * 的)照旧画 `url`。**`ref` 与 `url` 都有时认 `ref`**,引用解析不到(图已被清扫)就画占位、不退回 `url`、不抛;
 * 两样都没有也画占位 —— 一张图坏了不该让整张卡出不来,更不该画一个裂图。
 */

import type { PostImage } from "@bilibili-notify/internal";
import type { ImageUrlOf } from "../rich-text";
import { BLOCKED_IMG_PLACEHOLDER } from "../skin/render-skin";

export function pictureUrl(image: PostImage | undefined, imageUrl?: ImageUrlOf): string {
	if (image?.ref !== undefined) return imageUrl?.(image.ref) ?? BLOCKED_IMG_PLACEHOLDER;
	if (image?.url !== undefined) return image.url;
	return BLOCKED_IMG_PLACEHOLDER;
}
