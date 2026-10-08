import type { PostImage } from "@bilibili-notify/internal";

/**
 * 图集载荷里**发得出去的图**:适配器照 `url` 发,没有 `url` 的图(只带图库引用)发不了,跳过。
 * 回的是新对象,只有地址与尺寸 —— 图库引用与 `isAnimated` 不跟出去,调用方原样写上线也不会漏内部的格。
 * 尺寸只有 QQ 官方机器人的原生 markdown 多图用得上,别的平台只取 `url`。
 */
export function imageGroupUrls(
	images: readonly PostImage[],
): { url: string; width?: number; height?: number }[] {
	return images.flatMap((img) =>
		img.url ? [{ url: img.url, width: img.width, height: img.height }] : [],
	);
}
