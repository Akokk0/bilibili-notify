/**
 * **图廊零件**(`buildGallery`,ADR-0019 决策 68):吃中立的图列表(`GalleryImage`)。`Post` 那条
 * (`nodeFromPost`)把 `PostImage` 映射成它再交给它 —— 图廊的 `Post` 路径另有 `post-gallery.test.ts` 与基准快照钉着,
 * 这里钉图廊自己的规矩:
 *
 * - 动图只认来源给的 `animated`(不再自己看 `.gif` 结尾 —— 那是来源翻译那一步的事:B 站看 `live_url` /
 *   `.gif`,拓展看文件头);
 * - 宽高缺了就按普通比例铺,不判长图。
 *
 * 纯文本正文怎么切成带话题的 `RichText` 片段(从前的 `buildPlainText`)搬去了服务端的 `postFromReport`,
 * 测试在 `apps/server/src/runtime/__tests__/post-from-report.test.ts`。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, type VNode } from "vue";
import { buildGallery, type GalleryImage } from "../templates/post-content";

async function htmlOf(v: VNode | null): Promise<string> {
	if (!v) throw new Error("零件回了 null");
	return await renderToString(createSSRApp({ render: () => v }));
}

const gif = (name: string) => `data:image/gif;base64,${name}`;

describe("buildGallery — 中立的图列表", () => {
	it("空列表 → null(块收起)", () => {
		expect(buildGallery([])).toBeNull();
	});

	it("动图只认 animated:给了就标「动图」,哪怕地址是 data URL", async () => {
		const html = await htmlOf(buildGallery([{ url: gif("A"), animated: true }]));
		expect(html).toContain("动图");
	});

	/**
	 * 「看 `.gif` 结尾」是 B 站那头的判据(`postFromDynamic` 翻译时算好 `isAnimated`),图廊自己不再猜。
	 * 验红:在 `picBadgeText` 里把 URL 结尾的判断加回来,这条红。
	 */
	it("没给 animated 的 .gif 地址不标 —— 判不判动图是来源的事", async () => {
		const html = await htmlOf(
			buildGallery([{ url: "https://example.invalid/a.gif", width: 100, height: 100 }]),
		);
		expect(html).not.toContain("动图");
	});

	/** 验红:把 `tallerThan` 改成宽高缺了也照比(`(h ?? 0) > (w ?? 0) * r`),单图那条红。 */
	it("宽高缺了 → 按普通比例铺,不判长图", async () => {
		const single = await htmlOf(buildGallery([{ url: gif("S"), height: 3000 }]));
		expect(single).toContain('class="w-full h-auto block"');
		expect(single).not.toContain("长图");

		const grid = await htmlOf(buildGallery([{ url: gif("A") }, { url: gif("B"), height: 3000 }]));
		expect(grid).not.toContain("长图");
		expect(grid).not.toContain("object-top");
	});

	it("宽高给全时长图 / 超长图照判(与 `Post` 那条同一份规矩)", async () => {
		const superLong = await htmlOf(buildGallery([{ url: gif("L"), width: 100, height: 300 }]));
		expect(superLong).toContain("长图");
		expect(superLong).toContain("height: 400px");
	});

	it("超过 9 张 → 铺 9 格,余下的折进最后一格的 +N", async () => {
		const images: GalleryImage[] = Array.from({ length: 12 }, (_, i) => ({ url: gif(`P${i}`) }));
		const html = await htmlOf(buildGallery(images));
		expect(html.match(/<img/g)).toHaveLength(9);
		expect(html).toContain("+3");
		expect(html).not.toContain(gif("P9"));
	});
});
