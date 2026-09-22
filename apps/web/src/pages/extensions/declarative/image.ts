/**
 * 拓展交来的图(表格的 icon 格、二维码、`enum` 选项的图标)在画之前再认一次形状。
 *
 * 宿主在交出来之前已经照 `ExtensionImageSchema` 拦过一道(只收图片的 base64 data URL,
 * ADR-0019 决策 31),这里是出口自己的那一道:一个 `https://` 地址当 `<img src>` 画,面板一开
 * 就去对家点名 —— 而面板与服务端在应用内升级那几秒里版本可能对不上,不该只靠对面那道门。
 * 不合的当它没有,摆放处退回自己的兜底(两个字母 / 不画)。
 */
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;

export function safeImage(src: unknown): string | undefined {
	return typeof src === "string" && IMAGE_DATA_URL.test(src) ? src : undefined;
}
