/**
 * **造 node 的零件**(ADR-0019 决策 68):拓展作品装配时照着 B 站那条同样造一棵 node,
 * 不碰本包内部。B 站那条走的是同一份实现 —— 图廊的 B 站路径另有 `dynamic-content-pics.test.ts`
 * 与基准快照钉着,这里只钉中立那一侧多出来的规矩:
 *
 * - `buildGallery`:吃中立的图列表。动图只认来源给的 `animated`(不再自己看 `.gif` 结尾 ——
 *   那是 B 站映射那一步的事,拓展的图是 data URL);宽高缺了就按普通比例铺。
 * - `buildPlainText`:纯文本正文,保留换行,落在与 B 站富文本同一个根上(`body` 挂点);给了话题名,
 *   正文里的 `#名字#` / `#名字` 画成 B 站富文本话题那一种 span(决策 55 的 09-24 🔗)。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, type VNode } from "vue";
import { parseRichText } from "../rich-text";
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

describe("buildPlainText — 照拓展报的话题名给正文里的话题上色", () => {
	/** B 站富文本里话题节点画出来的那一种 span。 */
	const topic = (text: string) => `<span class="text-[#FF6699]">${text}</span>`;

	it("画法与 B 站富文本的话题节点同一种 span(皮肤对两边一视同仁)", async () => {
		const bili = await htmlOf(
			parseRichText([
				{ type: "RICH_TEXT_NODE_TYPE_TOPIC", text: "#假话题#", orig_text: "#假话题#" },
			]),
		);
		expect(bili).toContain(topic("#假话题#"));
		const ours = await htmlOf(buildPlainText("#假话题#", ["假话题"]));
		expect(ours).toContain(topic("#假话题#"));
	});

	it("#名字# 与 #名字 都上色,两边的字照旧", async () => {
		const html = await htmlOf(buildPlainText("去 #海边# 玩,顺便 #旅行", ["海边", "旅行"]));
		expect(html).toContain(topic("#海边#"));
		expect(html).toContain(topic("#旅行"));
		expect(html).toContain("去 ");
		expect(html).toContain(" 玩,顺便 ");
	});

	it("名字有包含关系时长的先匹配,与报的次序无关", async () => {
		const html = await htmlOf(buildPlainText("#旅行日记 和 #旅行", ["旅行", "旅行日记"]));
		expect(html).toContain(topic("#旅行日记"));
		expect(html).toContain(topic("#旅行"));
		expect(html).not.toContain(`${topic("#旅行")}日记`);
	});

	it("#名字# 优先于 #名字:收尾的 # 算进话题,不留给后面", async () => {
		const html = await htmlOf(buildPlainText("#旅行#日记", ["旅行"]));
		expect(html).toContain(`${topic("#旅行#")}日记`);
	});

	it("名字在正文里找不到:不上色、不出错,与没给话题时一模一样", async () => {
		const text = "今天走了两万步 #城市散步";
		expect(await htmlOf(buildPlainText(text, ["vlog"]))).toBe(await htmlOf(buildPlainText(text)));
		expect(await htmlOf(buildPlainText(text, []))).toBe(await htmlOf(buildPlainText(text)));
	});

	it("不在名单里的 # 一律不动 —— 「C#」「#1」不是话题,BN 不按 # 猜", async () => {
		const html = await htmlOf(buildPlainText("学 C# 的第 #1 课 #编程", ["编程"]));
		expect(html.match(/text-\[#FF6699\]/g)).toHaveLength(1);
		expect(html).toContain(topic("#编程"));
		expect(html).toContain("学 C# 的第 #1 课 ");
	});

	it("HTML 转义照旧:正文与话题里的标签都当文字", async () => {
		const html = await htmlOf(buildPlainText("<b>粗</b> #<i>#", ["<i>"]));
		expect(html).toContain("&lt;b&gt;粗&lt;/b&gt; ");
		expect(html).toContain(topic("#&lt;i&gt;#"));
		expect(html).not.toContain("<b>");
		expect(html).not.toContain("<i>");
	});

	it("换行照旧:话题前后换行,<br> 落在原处", async () => {
		const html = await htmlOf(buildPlainText("第一行 #话题\r\n第二行 #话题#", ["话题"]));
		expect(html).toContain(`第一行 ${topic("#话题")}<br>第二行 ${topic("#话题#")}`);
	});
});
