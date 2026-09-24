/**
 * **造 node 的零件**(ADR-0019 决策 68):拓展作品装配时照着 B 站那条同样造一棵 node,
 * 不碰本包内部。B 站那条走的是同一份实现 —— 图廊的 B 站路径另有 `dynamic-content-pics.test.ts`
 * 与基准快照钉着,这里只钉中立那一侧多出来的规矩:
 *
 * - `buildGallery`:吃中立的图列表。动图只认来源给的 `animated`(不再自己看 `.gif` 结尾 ——
 *   那是 B 站映射那一步的事,拓展的图是 data URL);宽高缺了就按普通比例铺。
 * - `buildPlainText`:纯文本正文,保留换行,落在与 B 站富文本同一个根上(`body` 挂点)。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, type VNode } from "vue";
import { buildGallery, buildPlainText, type GalleryImage } from "../templates/dynamic-content";

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
	 * 「看 `.gif` 结尾」是 B 站那头的判据(`opusImages` 映射时算好 `animated`),图廊自己不再猜。
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

	it("宽高给全时长图 / 超长图照判(与 B 站那条同一份规矩)", async () => {
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

describe("buildPlainText — 纯文本正文", () => {
	it("保留换行;落在与 B 站富文本同一个根上(`body` 挂点)", async () => {
		const html = await htmlOf(buildPlainText("第一行\n第二行"));
		expect(html).toMatch(/^<div data-bn="body"/);
		expect(html).toContain("第一行<br>第二行");
	});

	it("\\r\\n 与 \\r 也当换行", async () => {
		const html = await htmlOf(buildPlainText("甲\r\n乙\r丙"));
		expect(html).toContain("甲<br>乙<br>丙");
		expect(html).not.toContain("\r");
	});

	it("原样当文字:标签被转义,#话题 照字面", async () => {
		const html = await htmlOf(buildPlainText("<b>加粗</b> #话题#"));
		expect(html).toContain("&lt;b&gt;加粗&lt;/b&gt; #话题#");
		expect(html).not.toContain("<b>");
	});

	it("一个字都没有(空串 / 只有空白)→ null,正文块收起", () => {
		expect(buildPlainText("")).toBeNull();
		expect(buildPlainText(" \n\t ")).toBeNull();
	});
});
