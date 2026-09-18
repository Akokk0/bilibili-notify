/**
 * **按形态覆盖版式**(ADR-0014 决策 10 的 2026-09-18 🔗)—— 渲染器这一端。
 *
 * 皮肤写一份基础版式,再按形态写「改了哪几块」;渲染器**按这张卡的数据**挑形态。
 * 这里钉的是那条线真的接上了:
 * - 换一条数据,同一份皮肤摆得不一样(接线剪断的话两张会一模一样);
 * - **内层各判各的** —— 转发卡外层恒是转发那一档,框里那张按原动态判;
 * - 一条覆盖都没匹配上时,出来的 HTML 与压根不写 `variants` 的皮肤**逐字节相同**。
 *   这一条是整条特性的地基:存量皮肤与默认皮肤的出图不许动。
 */

import type { CardSkinCard } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createSSRApp } from "vue";
import { CARD_FIXTURES } from "../../__tests__/fixtures/card-fixtures";
import { FORWARD_INSET_CLASS } from "../../blocks/dynamic";
import type { DynamicCardProps } from "../../templates/dynamic-card";
import type { Dynamic } from "../../types";
import { renderSkinnedCard } from "../render-skin";

/** dynamic-av:一条视频投稿(不是转发)。dynamic-forward:转发了一条视频投稿。 */
let avProps: DynamicCardProps;
let forwardProps: DynamicCardProps;

async function fixtureProps(name: string): Promise<DynamicCardProps> {
	const fixture = CARD_FIXTURES.find((f) => f.name === name);
	if (!fixture) throw new Error(`夹具表里没有 ${name}`);
	return (await fixture.build()).props as unknown as DynamicCardProps;
}

beforeAll(async () => {
	avProps = await fixtureProps("dynamic-av");
	forwardProps = await fixtureProps("dynamic-forward");
});

// 形态判据读的是**契约数据**,而视频 / 图廊那两组字段从原始动态取 —— 出图真路径
// (`image-renderer.ts`)传的就是它,这里照样传。
const ARCHIVE = {
	cover: "https://img/cover.jpg",
	duration_text: "12:34",
	title: "一期视频",
	desc: "",
	stat: { play: "1.2万", danmaku: "34" },
	bvid: "BV1xx411c7mD",
	jump_url: "",
};
const raw = (major: unknown, type: string, orig?: Dynamic): Dynamic =>
	({ type, modules: { module_dynamic: { major } }, orig }) as unknown as Dynamic;

const RAW_VIDEO = raw({ type: "MAJOR_TYPE_ARCHIVE", archive: ARCHIVE }, "DYNAMIC_TYPE_AV");
const RAW_PICS = raw(
	{ type: "MAJOR_TYPE_OPUS", opus: { pics: [{ url: "https://img/p1.jpg" }] } },
	"DYNAMIC_TYPE_DRAW",
);
const RAW_FORWARD_OF_VIDEO = raw({}, "DYNAMIC_TYPE_FORWARD", RAW_VIDEO);

const block = (id: string, builtin: string, row: number): CardSkinCard["blocks"][number] =>
	({ id, kind: "builtin", builtin, grid: { row, column: 1, span: 12 } }) as never;

/** 三块 + 转发框的一张卡。`variants` 由各用例自己给。 */
function card(variants?: unknown): CardSkinCard {
	return {
		width: 600,
		blocks: [block("who", "avatar", 1), block("words", "text", 2), block("box", "forward", 3)],
		...(variants === undefined ? {} : { variants }),
	} as unknown as CardSkinCard;
}

async function render(
	c: CardSkinCard,
	props: DynamicCardProps,
	rawDynamic?: Dynamic,
): Promise<{ html: string; doc: Document; css: string }> {
	const { vnode, css } = renderSkinnedCard({ kind: "dynamic", card: c, props, raw: rawDynamic });
	const html = await renderToString(createSSRApp({ render: () => vnode }));
	return { html, doc: new JSDOM(html).window.document, css };
}

/** 外层网格里每个块落在第几行(`grid-row:N / span M` 的 N)。 */
function rowsOf(root: ParentNode): Record<string, number> {
	const out: Record<string, number> = {};
	for (const el of root.querySelectorAll('[class*="bn-blk-"]')) {
		const id = [...el.classList].find((c) => c.startsWith("bn-blk-"))?.slice(7);
		const m = /grid-row:(\d+)/.exec(el.getAttribute("style") ?? "");
		if (id && m && !(id in out)) out[id] = Number(m[1]);
	}
	return out;
}

function inset(doc: Document): Element {
	const el = doc.querySelector(`[class="${FORWARD_INSET_CLASS}"]`);
	if (!el) throw new Error("这张卡上没有转发框");
	return el;
}

describe("按形态覆盖版式 — 渲染器真按数据挑", () => {
	// 把头像推到很后面的一行,好让它和正文**换位**。压行那一步会把行号重编成 1..n,
	// 所以断言看的是名次 —— 只把块推后一行的话,收起的块一让位,名次可能原地不动。
	const moved = card({ video: { blocks: { who: { grid: { row: 9 } } } } });

	it("同一份皮肤,视频动态与图文动态摆得不一样", async () => {
		const video = await render(moved, avProps, RAW_VIDEO);
		const pics = await render(moved, avProps, RAW_PICS);
		// 视频那一档把头像推到了正文后面;图文那一档没写覆盖,照 base 摆。
		expect(rowsOf(video.doc).who).toBeGreaterThan(rowsOf(video.doc).words ?? 0);
		expect(rowsOf(pics.doc).who).toBeLessThan(rowsOf(pics.doc).words ?? 0);
	});

	// 整条特性的地基:一条覆盖都没匹配上 = 今天。
	it("没匹配上的形态,与压根不写 variants 的皮肤逐字节相同", async () => {
		const withTable = await render(moved, avProps, RAW_PICS);
		const without = await render(card(), avProps, RAW_PICS);
		expect(withTable.html).toBe(without.html);
		expect(withTable.css).toBe(without.css);
	});

	it("这一形态藏起来的块整个不画", async () => {
		const hidden = card({ video: { blocks: { words: { hidden: true } } } });
		const { doc } = await render(hidden, avProps, RAW_VIDEO);
		expect(doc.querySelectorAll(".bn-blk-words").length).toBe(0);
		expect(doc.querySelectorAll(".bn-blk-who").length).toBe(1);
	});

	// **内层各判各的**:外层是转发(`isForward` 为真、判据排最前),框里那张按原动态判成视频。
	it("内层各判各的:外层用转发那份,框里那张用视频那份", async () => {
		const c = card({
			forward: { blocks: { words: { hidden: true } } },
			video: { blocks: { who: { hidden: true } } },
		});
		const { doc } = await render(c, forwardProps, RAW_FORWARD_OF_VIDEO);
		const box = inset(doc);
		// 外层:转发那档藏了正文,头像还在。
		expect(doc.querySelectorAll(".bn-blk-who").length).toBeGreaterThan(0);
		expect(box.querySelectorAll(".bn-blk-who").length).toBe(0);
		// 内层:视频那档藏了头像,正文还在 —— 两层各藏各的,正好互换。
		expect(box.querySelectorAll(".bn-blk-words").length).toBe(1);
		expect(doc.querySelectorAll(".bn-blk-words").length).toBe(1);
	});
});

describe("按形态覆盖版式 — 覆盖的 CSS", () => {
	const c = card({
		video: { blocks: { words: { css: '[data-bn="self"]{color:red}' } } },
	});

	it("单发一条规则,挂的是带形态后缀的 class", async () => {
		const { css, doc } = await render(c, avProps, RAW_VIDEO);
		expect(css).toContain(".bn-blk-words--video{color:red}");
		const words = doc.querySelector(".bn-blk-words");
		expect(words?.classList.contains("bn-blk-words--video")).toBe(true);
	});

	// 同特异度,所以**后来居上**靠的是源码顺序 —— base 那条必须排在前面。
	it("排在 base 那条后面", async () => {
		const withBase = {
			...c,
			blocks: c.blocks.map((b) =>
				b.id === "words" ? { ...b, css: '[data-bn="self"]{color:blue}' } : b,
			),
		} as CardSkinCard;
		const { css } = await render(withBase, avProps, RAW_VIDEO);
		expect(css.indexOf("color:blue")).toBeGreaterThanOrEqual(0);
		expect(css.indexOf("color:red")).toBeGreaterThan(css.indexOf("color:blue"));
	});

	// 后缀 class 只贴在那一层 —— 不然转发卡的内外两层会抢同一条规则。
	it("后缀 class 不贴到别的形态那一层上", async () => {
		const both = card({
			forward: { blocks: { words: { css: '[data-bn="self"]{color:green}' } } },
			video: { blocks: { words: { css: '[data-bn="self"]{color:red}' } } },
		});
		const { doc, css } = await render(both, forwardProps, RAW_FORWARD_OF_VIDEO);
		expect(css).toContain(".bn-blk-words--forward{color:green}");
		expect(css).toContain(".bn-blk-words--video{color:red}");
		const outer = [...doc.querySelectorAll(".bn-blk-words")].filter(
			(el) => !inset(doc).contains(el),
		);
		expect(outer[0]?.classList.contains("bn-blk-words--forward")).toBe(true);
		expect(outer[0]?.classList.contains("bn-blk-words--video")).toBe(false);
		const innerWords = inset(doc).querySelector(".bn-blk-words");
		expect(innerWords?.classList.contains("bn-blk-words--video")).toBe(true);
		expect(innerWords?.classList.contains("bn-blk-words--forward")).toBe(false);
	});

	it("没写覆盖 CSS 时,一个后缀 class 都不多挂", async () => {
		const { html } = await render(card(), avProps, RAW_VIDEO);
		expect(html).not.toContain("--video");
	});
});
