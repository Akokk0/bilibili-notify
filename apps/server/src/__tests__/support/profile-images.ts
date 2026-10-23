import { type ImageRef, ok } from "@bilibili-notify/internal";
import { vi } from "vite-plus/test";

/** 抓头像后的引用(假的图库每张都回它)。 */
export const PROFILE_IMAGE_REF = `${"b".repeat(64)}.webp` as ImageRef;

/** 假的头像抓图服务(`startProfileRefresh` 的 `images`):不联网,每次都抓到 {@link PROFILE_IMAGE_REF},记下调用。 */
export function fakeProfileImages() {
	return { fetchImage: vi.fn(async () => ok({ ref: PROFILE_IMAGE_REF })) };
}
