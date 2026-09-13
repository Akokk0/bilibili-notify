/**
 * 皮肤渲染器的**逐条规矩**(ADR-0014 决策 6、10、11、12、13、15)。
 *
 * 验收门(`skin-gate.test.ts`)钉的是「默认皮肤画出来的块与今天逐字节一致」,走的全是
 * **内置块 + 没有 showIf + 没有自定义块**那条主干;皮肤真正的口子(条件显示、自定义块的
 * 占位符、挂点翻译、行压缩、变量注入)一条都碰不到 —— 它们改坏了门也不会红。这份补上:
 * 每条规矩造一份最小皮肤,单独钉。
 *
 * props 一律借 `CARD_FIXTURES` 里现成的那几份(与基准、挂点对表同源),免得再造一套会
 * 与真实形状漂移的假数据。
 */

import { type CardSkinCard, DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createSSRApp } from "vue";
import { CARD_FIXTURES } from "../../__tests__/fixtures/card-fixtures";
import type { LiveCardProps } from "../../templates/live-card";
import { BLOCKED_IMG_PLACEHOLDER, renderSkinnedCard, type SkinRenderOptions } from "../render-skin";

/** live-streaming 那份 props(直播中、封面 / 分区 / 人气 / 粉丝全开、无粉丝变化)。 */
let liveProps: LiveCardProps;

beforeAll(async () => {
	const fixture = CARD_FIXTURES.find((f) => f.name === "live-streaming");
	if (!fixture) throw new Error("夹具表里没有 live-streaming");
	liveProps = (await fixture.build()).props as unknown as LiveCardProps;
});

/** 一份只有指定块的 live 皮肤。 */
function liveCard(blocks: CardSkinCard["blocks"], over: Partial<CardSkinCard> = {}): CardSkinCard {
	return { width: 600, blocks, ...over };
}

const builtin = (
	id: string,
	name: string,
	grid: { row: number; column: number; span: number },
	over: Record<string, unknown> = {},
): CardSkinCard["blocks"][number] =>
	({ id, kind: "builtin", builtin: name, grid, ...over }) as CardSkinCard["blocks"][number];

const custom = (
	id: string,
	html: string,
	grid = { row: 1, column: 1, span: 12 },
): CardSkinCard["blocks"][number] =>
	({ id, kind: "custom", html, grid }) as CardSkinCard["blocks"][number];

async function render(
	card: CardSkinCard,
	over: Partial<SkinRenderOptions<"live">> = {},
): Promise<{ html: string; css: string; doc: Document }> {
	const { vnode, css } = renderSkinnedCard({ kind: "live", card, props: liveProps, ...over });
	const html = await renderToString(createSSRApp({ render: () => vnode }));
	return { html, css, doc: new JSDOM(html).window.document };
}

const labels = (doc: Document): string[] =>
	[...doc.querySelectorAll("[data-block]")].map((el) => el.getAttribute("data-block") ?? "");

const rows = (doc: Document): string[] =>
	[...doc.querySelectorAll("[class^='bn-blk-']")].map(
		(el) => /grid-row:(\d+)/.exec(el.getAttribute("style") ?? "")?.[1] ?? "?",
	);

describe("皮肤渲染器 — 块的 wrapper", () => {
	it("带 data-block、bn-blk-<id> 的 class、网格坐标与 min-width:0", async () => {
		const { doc } = await render(liveCard([builtin("t", "title", { row: 2, column: 3, span: 4 })]));
		const el = doc.querySelector("[data-block='title']");
		expect(el?.className).toBe("bn-blk-t");
		// 行号被压成 1(第 2 行是唯一一行);列与跨度原样。
		expect(el?.getAttribute("style")).toBe(
			"grid-row:1 / span 1;grid-column:3 / span 4;min-width:0",
		);
	});

	it("玻璃层是 12 列网格,gap 从皮肤来", async () => {
		const { doc } = await render(
			liveCard([builtin("t", "title", { row: 1, column: 1, span: 12 })], {
				gap: { row: 8, column: 4 },
			}),
		);
		const style = doc.querySelector("[data-bn~='glass']")?.getAttribute("style") ?? "";
		expect(style).toContain("grid-template-columns:repeat(12, minmax(0, 1fr))");
		expect(style).toContain("gap:8px 4px");
	});
});

describe("皮肤渲染器 — showIf", () => {
	it("字段为真才画", async () => {
		const { doc } = await render(
			liveCard([
				builtin("t", "title", { row: 1, column: 1, span: 12 }, { showIf: "live.hasCover" }),
			]),
		);
		expect(labels(doc)).toEqual(["title"]);
	});

	it("字段为假整块不画", async () => {
		const { doc } = await render(
			liveCard([
				builtin("t", "title", { row: 1, column: 1, span: 12 }, { showIf: "stats.hasFansChanged" }),
			]),
		);
		expect(labels(doc)).toEqual([]);
	});

	it("取不到的字段当假", async () => {
		const { doc } = await render(
			liveCard([builtin("t", "title", { row: 1, column: 1, span: 12 }, { showIf: "live.nope" })]),
		);
		expect(labels(doc)).toEqual([]);
	});
});

describe("皮肤渲染器 — 分割线的三条规矩", () => {
	it("开头的分割线抑制、末尾的弹出、悬空的抑制", async () => {
		const { doc } = await render(
			liveCard([
				builtin("d0", "divider", { row: 1, column: 1, span: 12 }),
				builtin("t", "title", { row: 2, column: 1, span: 12 }),
				builtin("d1", "divider", { row: 3, column: 1, span: 12 }),
				// data 块三个开关全开、但这份夹具没有粉丝变化 —— 它照画;换成 showIf 假的块来造悬空。
				builtin("h", "header", { row: 4, column: 1, span: 12 }, { showIf: "stats.hasFansChanged" }),
				builtin("d2", "divider", { row: 5, column: 1, span: 12 }),
				builtin("t2", "desc", { row: 6, column: 1, span: 12 }),
			]),
		);
		// d0 开头被抑制;d1 前面是内容块 → 留;h 没画 → d2 悬空 → 抑制。
		expect(labels(doc)).toEqual(["title", "divider", "desc"]);
		expect(doc.querySelectorAll(".bn-blk-d1")).toHaveLength(1);
	});

	it("末尾的分割线弹出", async () => {
		const { doc } = await render(
			liveCard([
				builtin("t", "title", { row: 1, column: 1, span: 12 }),
				builtin("d1", "divider", { row: 2, column: 1, span: 12 }),
			]),
		);
		expect(labels(doc)).toEqual(["title"]);
	});
});

describe("皮肤渲染器 — 行压缩", () => {
	it("被收起的块不留空行,剩下的行号重编成 1..n", async () => {
		const { doc } = await render(
			liveCard([
				builtin("a", "title", { row: 1, column: 1, span: 12 }),
				builtin("b", "header", { row: 2, column: 1, span: 12 }, { showIf: "stats.hasFansChanged" }),
				builtin("c", "desc", { row: 3, column: 1, span: 12 }),
			]),
		);
		expect(labels(doc)).toEqual(["title", "desc"]);
		expect(rows(doc)).toEqual(["1", "2"]);
	});

	it("同一行的两个块压成同一行(不各占一行)", async () => {
		const { doc } = await render(
			liveCard([
				builtin("a", "title", { row: 3, column: 1, span: 6 }),
				builtin("b", "desc", { row: 3, column: 7, span: 6 }),
			]),
		);
		expect(rows(doc)).toEqual(["1", "1"]);
	});
});

describe("皮肤渲染器 — 自定义块的占位符", () => {
	it("文本位置的 {a.b} 换成字段值并转义", async () => {
		const { html } = await render(liveCard([custom("c", "<div>{up.name} · {live.area}</div>")]), {
			props: { ...liveProps, username: '<b>坏"名字</b>' },
		});
		expect(html).toContain("&lt;b&gt;坏&quot;名字&lt;/b&gt; · 虚拟主播");
	});

	it("取不到的字段给空串(不留 {xxx}、不出 undefined)", async () => {
		const { html } = await render(liveCard([custom("c", "<div>[{live.nope}]</div>")]));
		expect(html).toContain("<div>[]</div>");
		expect(html).not.toContain("undefined");
	});

	it("src 的整值占位符:图片字段才替换", async () => {
		const { html } = await render(
			liveCard([custom("c", '<img src="{up.face}"><img src="{live.title}">')]),
		);
		expect(html).toContain(`src="${liveProps.userface}"`);
		expect(html).toContain('<img src="">');
		expect(html).not.toContain(liveProps.data.title);
	});

	it("src 的资产名走 resolveAsset;解析不出退透明占位 GIF", async () => {
		const card = liveCard([custom("c", '<img src="asset:bg.png">')]);
		const withAsset = await render(card, { resolveAsset: () => "data:image/png;base64,AAA" });
		expect(withAsset.html).toContain('src="data:image/png;base64,AAA"');
		const without = await render(card);
		expect(without.html).toContain(`src="${BLOCKED_IMG_PLACEHOLDER}"`);
	});

	it("字面地址的 src 原样带过", async () => {
		const { html } = await render(
			liveCard([custom("c", '<img src="http://i0.hdslb.com/bfs/x.jpg">')]),
		);
		expect(html).toContain('src="http://i0.hdslb.com/bfs/x.jpg"');
	});
});

describe("皮肤渲染器 — CSS 翻译", () => {
	it("块级:self → 该块的 class;内部挂点 → 该块内的 ~= 选择器", async () => {
		const { css } = await render(
			liveCard([
				builtin(
					"hd",
					"header",
					{ row: 1, column: 1, span: 12 },
					{ css: '[data-bn="self"]{padding-top:4px}[data-bn="avatar"]{border-radius:0}' },
				),
			]),
		);
		expect(css).toContain(".bn-blk-hd{padding-top:4px}");
		// `~=` 不是 `=`:图廊的单图容器挂的是 "pics pic" 双挂点,`=` 选不中。
		expect(css).toContain('.bn-blk-hd [data-bn~="avatar"]{border-radius:0}');
	});

	it("根级:frame / glass 原样落在 DOM 上的挂点(只换成 ~=)", async () => {
		const { css } = await render(
			liveCard([builtin("t", "title", { row: 1, column: 1, span: 12 })], {
				css: '[data-bn="frame"]{padding:0}[data-bn="glass"]{height:190px}',
			}),
		);
		expect(css).toContain('[data-bn~="frame"]{padding:0}');
		expect(css).toContain('[data-bn~="glass"]{height:190px}');
	});

	it("没画出来的块不留 CSS", async () => {
		const { css } = await render(
			liveCard([
				builtin(
					"t",
					"title",
					{ row: 1, column: 1, span: 12 },
					{ showIf: "stats.hasFansChanged", css: '[data-bn="self"]{color:red}' },
				),
			]),
		);
		expect(css).not.toContain("bn-blk-t");
	});
});

describe("皮肤渲染器 — 皮肤变量", () => {
	const card = (): CardSkinCard =>
		liveCard([builtin("t", "title", { row: 1, column: 1, span: 12 })]);

	it("四个变量注在外框的 inline style 上,值与外框自己画的一致", async () => {
		const { doc } = await render(card());
		const style = doc.querySelector("[data-bn~='frame']")?.getAttribute("style") ?? "";
		expect(style).toContain("--bn-card-color-start:#e0c3fc");
		expect(style).toContain("--bn-card-color-end:#8ec5fc");
		expect(style).toContain("--bn-card-glass-opacity:0.82");
		expect(style).toContain("--bn-card-glass-blur:10px");
	});

	it("完全透明:白纱与模糊都归零", async () => {
		const { doc } = await render(card(), { props: { ...liveProps, glassClear: true } });
		const style = doc.querySelector("[data-bn~='frame']")?.getAttribute("style") ?? "";
		expect(style).toContain("--bn-card-glass-opacity:0");
		expect(style).toContain("--bn-card-glass-blur:0px");
	});
});

describe("皮肤渲染器 — 整张一个块的卡种", () => {
	it("词云:外框 + 网格 + 一个 body 块", async () => {
		const fixture = CARD_FIXTURES.find((f) => f.name === "wordcloud");
		if (!fixture) throw new Error("夹具表里没有 wordcloud");
		const input = await fixture.build();
		const wc = DEFAULT_CARD_SKIN.cards.wordcloud;
		if (!wc) throw new Error("默认皮肤缺词云卡");
		const { vnode } = renderSkinnedCard({
			kind: "wordcloud",
			card: wc,
			props: input.props as never,
		});
		const html = await renderToString(createSSRApp({ render: () => vnode }));
		const doc = new JSDOM(html).window.document;
		expect(labels(doc)).toEqual(["body"]);
		expect(doc.querySelector("#wordCloudCanvas")).not.toBeNull();
	});
});
