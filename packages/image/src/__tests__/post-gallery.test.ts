/**
 * 多图作品的图廊 —— 九宫格截断与图片角标。
 *
 * 两件事照 B 站官方网页端的做法:
 *   1. 最多铺 9 格,余下的折进第 9 格上的 `+N`。以前是有几张铺几张,17 张图的动态
 *      能把卡片拉出去一米多长,推到群里全是缩略图墙。
 *   2. 角标除「长图」外还要有「动图」。出图走截图,GIF 只截得到一帧 —— 不标的话
 *      那一帧看着就是张静图,没人知道原动态是会动的。
 *
 * 动图只认来源给的 `PostImage.isAnimated`,图廊自己不猜地址结尾:B 站那头的判据(`live_url` 非空**或** URL 后缀是
 * `.gif`,先削掉 `@` 后缀与 query)在 `packages/dynamic` 的翻译里,`post-from-dynamic.test.ts` 钉着;拓展的图是
 * data URL,「看结尾」对它不成立。宁可漏标也不误标。
 */

import type { Post, PostImage } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, h } from "vue";
import { BLOCKED_IMG_PLACEHOLDER } from "../skin/render-skin";
import { buildGallery } from "../templates/post-content";
import { nodeFromPost } from "../templates/post-node";
import { renderViaDefaultSkin } from "./fixtures/skin-render";

const FMT = { time: () => "刚刚" };

/** 一张普通的方图。 */
function pic(over: Partial<PostImage> = {}): PostImage {
	return { width: 1000, height: 1000, url: "https://i0.hdslb.com/bfs/new_dyn/a.jpg", ...over };
}

function imagePost(images: PostImage[]): Post {
	return {
		creator: { name: "示例UP" },
		publishedAt: "2023-11-14T22:13:20.000Z",
		text: "",
		images,
	};
}

async function picsHtml(images: PostImage[]): Promise<string> {
	const node = nodeFromPost(imagePost(images), FMT);
	const app = createSSRApp({
		render: () => h("div", [node.text, buildGallery(node.images ?? [])]),
	});
	return renderToString(app);
}

/** 图廊里实际铺出来的图片数。 */
function imgCount(html: string): number {
	return (html.match(/<img/g) ?? []).length;
}

describe("图廊 — 九宫格截断", () => {
	it("超过 9 张 → 只铺 9 张,余下的折成 +N", async () => {
		const html = await picsHtml(Array.from({ length: 14 }, () => pic()));
		expect(imgCount(html)).toBe(9);
		expect(html).toContain("+5");
	});

	it("恰好 9 张 → 全铺开,不出现 +0 这种废话", async () => {
		const html = await picsHtml(Array.from({ length: 9 }, () => pic()));
		expect(imgCount(html)).toBe(9);
		expect(html).not.toContain("+0");
	});

	it("不足 9 张 → 一张不少,也没有 +N", async () => {
		const html = await picsHtml(Array.from({ length: 4 }, () => pic()));
		expect(imgCount(html)).toBe(4);
		expect(html).not.toMatch(/\+\d/);
	});

	it("+N 落在**最后一格**上 —— 官方就是盖在第 9 张图上,不是另起一格", async () => {
		// 另起一格的话会变成 10 格,第 10 格空着,布局也就散了。
		const images = Array.from({ length: 12 }, (_, i) =>
			pic({ url: `https://i0.hdslb.com/bfs/new_dyn/p${i}.jpg` }),
		);
		const html = await picsHtml(images);
		expect(imgCount(html)).toBe(9);
		// 第 9 张(p8)之后才出现 +3,且 p9/p10/p11 一张都没渲染
		expect(html.indexOf("+3")).toBeGreaterThan(html.indexOf("p8.jpg"));
		expect(html).not.toContain("p9.jpg");
	});
});

describe("图廊 — 动图角标", () => {
	it("isAnimated 为真 → 标「动图」", async () => {
		const html = await picsHtml([
			pic(),
			pic({ url: "https://i0.hdslb.com/bfs/new_dyn/b.jpg", isAnimated: true }),
		]);
		expect(html).toContain("动图");
	});

	it("没给 isAnimated 的 .gif 地址不标 —— 判不判动图是来源的事,图廊不看地址结尾", async () => {
		const html = await picsHtml([pic(), pic({ url: "https://i0.hdslb.com/bfs/new_dyn/b.gif" })]);
		expect(html).not.toContain("动图");
	});

	it("普通静图不标 —— 宁可漏也不误标", async () => {
		const html = await picsHtml([
			pic({ isAnimated: false }),
			pic({ url: "https://i0.hdslb.com/bfs/new_dyn/b.png", isAnimated: false }),
		]);
		expect(html).not.toContain("动图");
	});

	it("既是动图又超长 → 只标「动图」", async () => {
		// 「这张会动」是截图里看不出来的信息;「被裁过」缩略图上多少看得出来。
		const html = await picsHtml([
			pic(),
			pic({
				width: 500,
				height: 3000,
				url: "https://i0.hdslb.com/bfs/new_dyn/b.gif",
				isAnimated: true,
			}),
		]);
		expect(html).toContain("动图");
		expect(html).not.toContain("长图");
	});

	it("单图动态是 GIF 也要标", async () => {
		const html = await picsHtml([
			pic({ url: "https://i0.hdslb.com/bfs/new_dyn/only.gif", isAnimated: true }),
		]);
		expect(html).toContain("动图");
	});
});

describe("图廊 — 长图角标不受影响", () => {
	it("多图里的超长静图仍标「长图」", async () => {
		const html = await picsHtml([pic(), pic({ width: 500, height: 3000 })]);
		expect(html).toContain("长图");
		expect(html).not.toContain("动图");
	});

	it("单图超长静图仍标「长图」", async () => {
		const html = await picsHtml([pic({ width: 500, height: 3000 })]);
		expect(html).toContain("长图");
	});
});

describe("图廊 — 挂点与根", () => {
	/** 一段 HTML 里出现过的全部挂点(`data-bn` 可以一次挂好几个,空格分开)。 */
	function hooksIn(html: string): string[] {
		return [...html.matchAll(/data-bn="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/));
	}

	it("单图:整个图廊就是那一格,`images` 与 `image` 两个挂点落在同一个元素上;根上没有跟在文字后面的间距", async () => {
		const node = nodeFromPost(imagePost([pic()]), FMT);
		const html = await renderToString(
			createSSRApp({ render: () => buildGallery(node.images ?? []) as never }),
		);
		expect(html).toMatch(/^<div data-bn="images image"/);
		expect(html).not.toContain("mt-[8px]");
	});

	it("多图:根挂 `images`,每一格挂 `image`", async () => {
		const node = nodeFromPost(imagePost([pic(), pic(), pic()]), FMT);
		const html = await renderToString(
			createSSRApp({ render: () => buildGallery(node.images ?? []) as never }),
		);
		expect(html).toMatch(/^<div data-bn="images"/);
		expect(hooksIn(html).filter((hook) => hook === "image")).toHaveLength(3);
	});

	it("没有图 → 图廊是 null(块收起),专栏的头图取 article.images", () => {
		expect(buildGallery(nodeFromPost(imagePost([]), FMT).images ?? [])).toBeNull();
		const article = nodeFromPost(
			{
				creator: { name: "某人" },
				publishedAt: "2023-11-14T22:13:20.000Z",
				text: "摘要",
				article: { title: "标题", images: [pic()] },
			},
			FMT,
		);
		expect(buildGallery(article.images ?? [])).not.toBeNull();
	});
});

describe("图廊 — 没有地址的图画占位", () => {
	it("只有 ref(没注入解析口 / 解析不到)与什么都没有的那几张:各占一格,画占位,不裂图、不省掉", async () => {
		const html = await picsHtml([pic(), { ref: "abc.png" }, {}]);
		expect(imgCount(html)).toBe(3);
		expect(html.split(BLOCKED_IMG_PLACEHOLDER).length - 1).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// 类名有没有真的变成 CSS
// ---------------------------------------------------------------------------

/**
 * UnoCSS 的 extractor 把整份 HTML 当一锅字符切词,Vue 给 `.map()` 插的 SSR 锚点注释
 * `<!--[-->` 会让它从 `[` 一路吃到下一个 `]`,把中途的类名并成一个无效 token。图廊
 * 恰好整个长在 `.map()` 里,而遮罩用的 `bg-black/40`、`text-[28px]` 都是**全卡唯一**
 * ——被吞了也没有别处把规则带出来,于是 `+5` 变成一行没有底色的裸字。这种错构建 /
 * 类型 / lint 全绿,只有出图那一刻看得见,所以这里盯的是「规则生成了没有」。
 */
describe("图廊 — 遮罩与角标的样式真的生成了", () => {
	/** UnoCSS 输出里类名的特殊字符是反斜杠转义的:`text-[28px]` → `.text-\[28px\]{…}`。 */
	function hasRule(css: string, cls: string): boolean {
		const selector = cls.replace(/[[\]().#%/:]/g, (c) => `\\${c}`);
		return new RegExp(`\\.${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[,{]`).test(css);
	}

	it("`+N` 遮罩与角标用到的每个类都有对应 CSS 规则", async () => {
		const images = Array.from({ length: 14 }, (_, i) =>
			pic({ url: `https://i0.hdslb.com/bfs/new_dyn/p${i}.gif`, isAnimated: true }),
		);
		const node = nodeFromPost(imagePost(images), FMT);
		const html = await renderViaDefaultSkin("dynamic", { node }, { htmlWidth: 600 });
		const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
		for (const cls of ["inset-0", "bg-black/40", "text-[28px]", "bg-black/50", "text-[10px]"]) {
			expect(hasRule(css, cls), `${cls} 的规则没生成(多半被 Fragment 锚点吞了)`).toBe(true);
		}
	});
});
