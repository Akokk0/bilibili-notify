/**
 * 包内资产 → data URL 那一口。图片与字体各查各的 mime 表(`image-mime.ts` /
 * `font-mime.ts`);查不到就不给 —— 一个 `application/octet-stream` 的 data URL 浏览器
 * 既不当图画也不当字体装,症状与缺资产一样却更难查。
 */

import { describe, expect, it } from "vite-plus/test";
import { readCardSkinAssetDataUrl } from "../asset-url.js";

const store = {
	ensureReady: async () => {},
	readAsset: async (_id: string, name: string) =>
		name.startsWith("assets/") ? new Uint8Array([1, 2, 3]) : null,
};

describe("readCardSkinAssetDataUrl", () => {
	it("图片按图片表给 mime", async () => {
		const url = await readCardSkinAssetDataUrl(store, "s", "assets/a.webp");
		expect(url).toMatch(/^data:image\/webp;base64,/);
	});

	it("字体按字体表给 mime(皮肤自带字体走 @font-face 要用)", async () => {
		expect(await readCardSkinAssetDataUrl(store, "s", "assets/a.woff2")).toMatch(
			/^data:font\/woff2;base64,/,
		);
		expect(await readCardSkinAssetDataUrl(store, "s", "assets/a.ttf")).toMatch(
			/^data:font\/ttf;base64,/,
		);
	});

	it("认不出的后缀不给(不塞 octet-stream)", async () => {
		expect(await readCardSkinAssetDataUrl(store, "s", "assets/a.bin")).toBeUndefined();
	});
});
