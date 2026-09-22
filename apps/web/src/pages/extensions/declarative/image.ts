import {
	EXTENSION_IMAGE_DATA_URL_RE,
	EXTENSION_IMAGE_MAX_CHARS,
} from "@bilibili-notify/internal/constants";

/**
 * 拓展交来的图(表格的 icon 格、二维码、`enum` 选项的图标)在画之前再认一次形状。
 *
 * 宿主在交出来之前已经照 `ExtensionImageSchema` 拦过一道(只收图片的 base64 data URL、不超过
 * 那个字数,ADR-0019 决策 31),这里是出口自己的那一道,判据与那道门**同一份**(internal 的
 * `/constants`):一个 `https://` 地址当 `<img src>` 画,面板一开就去对家点名 —— 而面板与服务端
 * 在应用内升级那几秒里版本可能对不上,不该只靠对面那道门。不合的当它没有,摆放处退回自己的
 * 兜底(两个字母 / 不画)。
 */
export function safeImage(src: unknown): string | undefined {
	return typeof src === "string" &&
		src.length <= EXTENSION_IMAGE_MAX_CHARS &&
		EXTENSION_IMAGE_DATA_URL_RE.test(src)
		? src
		: undefined;
}
