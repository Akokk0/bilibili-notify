/**
 * 拓展交来的图在画之前,出口自己再认一次(ADR-0019 决策 31)。判据与宿主那道门**同一份**
 * (`@bilibili-notify/internal/constants`):只收图片的 base64 data URL,且不超过那个字数。
 */

import {
	EXTENSION_IMAGE_DATA_URL_RE,
	EXTENSION_IMAGE_MAX_CHARS,
} from "@bilibili-notify/internal/constants";
import { describe, expect, it } from "vite-plus/test";
import { safeImage } from "../image";

const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** 一段合规、正好 `length` 个字的 png data URL。 */
function pngOfLength(length: number): string {
	const head = "data:image/png;base64,";
	return head + "A".repeat(length - head.length);
}

describe("safeImage", () => {
	it("图片的 base64 data URL 原样交回", () => {
		expect(safeImage(PNG)).toBe(PNG);
		const svg = `data:image/svg+xml;base64,${btoa("<svg/>")}`;
		expect(safeImage(svg)).toBe(svg);
	});

	it("地址、别的 data URL、不是字的,都当它没有", () => {
		expect(safeImage("https://evil.example/track.png")).toBeUndefined();
		expect(safeImage("data:text/html;base64,PHNjcmlwdD4=")).toBeUndefined();
		expect(safeImage(`${PNG}"onerror="x`)).toBeUndefined();
		expect(safeImage(undefined)).toBeUndefined();
		expect(safeImage(42)).toBeUndefined();
	});

	/** 宿主那道门也按这个数拦;面板与服务端版本对不上的那几秒里,出口不该比门宽。 */
	it("超过字数上限的不画;正好卡在上限的照画", () => {
		const atCap = pngOfLength(EXTENSION_IMAGE_MAX_CHARS);
		expect(EXTENSION_IMAGE_DATA_URL_RE.test(atCap)).toBe(true);
		expect(safeImage(atCap)).toBe(atCap);
		expect(safeImage(pngOfLength(EXTENSION_IMAGE_MAX_CHARS + 1))).toBeUndefined();
	});
});
