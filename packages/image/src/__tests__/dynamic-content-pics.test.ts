/**
 * 多图动态的图廊 —— 九宫格截断与图片角标。
 *
 * 两件事照 B 站官方网页端的做法:
 *   1. 最多铺 9 格,余下的折进第 9 格上的 `+N`。以前是有几张铺几张,17 张图的动态
 *      能把卡片拉出去一米多长,推到群里全是缩略图墙。
 *   2. 角标除「长图」外还要有「动图」。出图走截图,GIF 只截得到一帧 —— 不标的话
 *      那一帧看着就是张静图,没人知道原动态是会动的。
 *
 * 动图判据取两条的并集:`live_url` 非空(B 站给动图带的播放地址)**或** URL 后缀是
 * `.gif`。单靠一条,万一那条在某类动态里不成立就是整片漏标,而两条都不满足时不标,
 * 宁可漏也不误标。
 */

import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, h } from "vue";
import { renderCard } from "../render";
import { DynamicCard } from "../templates/dynamic-card";
import { buildDynamicNode } from "../templates/dynamic-content";
import type { Dynamic } from "../types";

const fmt = { time: () => "刚刚", num: (n: number) => String(n) };

type Pic = { width: number; height: number; url: string; live_url?: string };

/** 一张普通的方图。 */
function pic(over: Partial<Pic> = {}): Pic {
	return { width: 1000, height: 1000, url: "https://i0.hdslb.com/bfs/new_dyn/a.jpg", ...over };
}

function drawDynamic(pics: Pic[]): Dynamic {
	return {
		basic: {},
		id_str: "1",
		type: "DYNAMIC_TYPE_DRAW",
		visible: true,
		modules: {
			module_author: {
				avatar: {},
				face: "face.jpg",
				face_nft: false,
				following: false,
				jump_url: "",
				label: "",
				mid: 1,
				name: "示例UP",
				pub_action: "",
				pub_action_text: "",
				pub_location_text: "",
				pub_time: "刚刚",
				pub_ts: 0,
				type: "AUTHOR_TYPE_NORMAL",
				vip: { type: 0 },
			},
			module_dynamic: { major: { type: "MAJOR_TYPE_OPUS", opus: { pics } } },
			module_stat: { forward: { count: 0 }, comment: { count: 0 }, like: { count: 0 } },
		},
	} as unknown as Dynamic;
}

async function picsHtml(pics: Pic[]): Promise<string> {
	const node = await buildDynamicNode(drawDynamic(pics), false, fmt);
	const app = createSSRApp({ render: () => h("div", [node.body]) });
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
		const pics = Array.from({ length: 12 }, (_, i) =>
			pic({ url: `https://i0.hdslb.com/bfs/new_dyn/p${i}.jpg` }),
		);
		const html = await picsHtml(pics);
		expect(imgCount(html)).toBe(9);
		// 第 9 张(p8)之后才出现 +3,且 p9/p10/p11 一张都没渲染
		expect(html.indexOf("+3")).toBeGreaterThan(html.indexOf("p8.jpg"));
		expect(html).not.toContain("p9.jpg");
	});
});

describe("图廊 — 动图角标", () => {
	it("live_url 非空 → 标「动图」", async () => {
		const html = await picsHtml([
			pic(),
			pic({ url: "https://i0.hdslb.com/bfs/new_dyn/b.jpg", live_url: "https://x/live.mp4" }),
		]);
		expect(html).toContain("动图");
	});

	it("URL 是 .gif → 标「动图」(live_url 缺席也认)", async () => {
		const html = await picsHtml([pic(), pic({ url: "https://i0.hdslb.com/bfs/new_dyn/b.gif" })]);
		expect(html).toContain("动图");
	});

	it("带处理后缀 / query 的 .gif 也认得出来", async () => {
		// 真实 URL 常写成 `….gif@1280w_80q_1s.webp` —— 光看结尾会当成 webp 漏标。
		const html = await picsHtml([
			pic(),
			pic({ url: "https://i0.hdslb.com/bfs/new_dyn/b.gif@1280w_80q_1s.webp?from=dyn" }),
		]);
		expect(html).toContain("动图");
	});

	it("普通静图不标 —— 宁可漏也不误标", async () => {
		const html = await picsHtml([pic(), pic({ url: "https://i0.hdslb.com/bfs/new_dyn/b.png" })]);
		expect(html).not.toContain("动图");
	});

	it("既是动图又超长 → 只标「动图」", async () => {
		// 「这张会动」是截图里看不出来的信息;「被裁过」缩略图上多少看得出来。
		const html = await picsHtml([
			pic(),
			pic({ width: 500, height: 3000, url: "https://i0.hdslb.com/bfs/new_dyn/b.gif" }),
		]);
		expect(html).toContain("动图");
		expect(html).not.toContain("长图");
	});

	it("单图动态是 GIF 也要标", async () => {
		const html = await picsHtml([pic({ url: "https://i0.hdslb.com/bfs/new_dyn/only.gif" })]);
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
		const pics = Array.from({ length: 14 }, (_, i) =>
			pic({ url: `https://i0.hdslb.com/bfs/new_dyn/p${i}.gif` }),
		);
		const node = await buildDynamicNode(drawDynamic(pics), false, fmt);
		const html = await renderCard(
			DynamicCard,
			{ node, cardColorStart: "#A18CD1", cardColorEnd: "#FBC2EB" },
			{ htmlWidth: 600 },
		);
		const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
		for (const cls of ["inset-0", "bg-black/40", "text-[28px]", "bg-black/50", "text-[10px]"]) {
			expect(hasRule(css, cls), `${cls} 的规则没生成(多半被 Fragment 锚点吞了)`).toBe(true);
		}
	});
});
