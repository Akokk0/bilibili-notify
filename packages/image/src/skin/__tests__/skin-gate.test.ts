/**
 * **卡片皮肤的验收门**(ADR-0014 决策 24 的自动门)。
 *
 * 拷问时定的验收标准是「默认皮肤画出的 HTML 与现状逐字节一致」,开工后改成两层 —— 网格
 * 容器与 `data-bn` 挂点都是新标记,整份字节不可能相同,但**块的内层**必须一个字节都没变。
 * 这份就是那层自动门(另一层是本机跑一次的像素比对):
 *
 * - **门 A(块内层字节)**:同一份夹具,一边走模板(基准 = 开工前打的 23 份快照),一边走
 *   「旧版式折成皮肤 → 皮肤渲染器」。两边取 `[data-block]` 元素**按文档序**的序列,块名与
 *   内层 HTML(剥掉 `data-bn`)两两相等。转发 inset 里递归装配出来的内层块也在序列里,
 *   照样比。整张是一个固定内置块的四种卡(两张锐评 / 词云 / ——)没有 `data-block`,改比
 *   玻璃层里那一层的**元素子节点**。
 * - **门 B(结构)**:玻璃层真的是网格容器,每个块 wrapper 都带 `bn-blk-` class。
 *
 * 门 A 红了**不许改基准、不许改夹具** —— 它红只有两种可能:皮肤渲染器把块装错了,或者
 * 那份版式折不进网格。两种都得报出来让人看,不是就地把标尺改短。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type CardBlock,
	type CardSkinCard,
	type CardSkinKind,
	cardLayoutToSkin,
	DEFAULT_CARD_LAYOUT,
	DEFAULT_CARD_SKIN,
	type GuardLayout,
} from "@bilibili-notify/internal";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import type { VNode } from "vue";
import {
	CARD_FIXTURES,
	type CardFixture,
	type CardRenderInput,
	stripCardHooks,
} from "../../__tests__/fixtures/card-fixtures";
import { renderCard } from "../../render";
import { renderSkinnedCard } from "../render-skin";

/** 整张是一个固定内置块的卡种:没有块序列可数,比玻璃层那一层。 */
const SINGLE_BLOCK_KINDS: ReadonlySet<CardSkinKind> = new Set([
	"roastBoard",
	"roastSolo",
	"wordcloud",
]);

const BASELINE_DIR = fileURLToPath(
	new URL("../../__tests__/__snapshots__/card-baseline/", import.meta.url),
);

function baselineHtml(name: string): string {
	return readFileSync(`${BASELINE_DIR}${name}.html`, "utf8");
}

/**
 * 这份夹具对应的皮肤条目。四种可排版的卡走**迁移**(夹具里传了什么版式就折什么,
 * 没传就折出厂默认)—— 这样门 A 比的才是「同一份版式,两条路」;其余卡种用默认皮肤。
 */
function skinCardOf(fixture: CardFixture, input: CardRenderInput): CardSkinCard {
	const kind = fixture.kind;
	if (SINGLE_BLOCK_KINDS.has(kind)) {
		const card = DEFAULT_CARD_SKIN.cards[kind];
		if (!card) throw new Error(`默认皮肤缺 ${kind} 卡`);
		return card;
	}
	const layout = { ...DEFAULT_CARD_LAYOUT };
	if (kind === "guard") {
		layout.guard = (input.props.layout as GuardLayout | undefined) ?? DEFAULT_CARD_LAYOUT.guard;
	} else if (kind === "live" || kind === "dynamic" || kind === "sc") {
		layout[kind] = (input.props.layout as CardBlock[] | undefined) ?? DEFAULT_CARD_LAYOUT[kind];
	}
	const card = cardLayoutToSkin(layout).cards[kind];
	if (!card) throw new Error(`折不出 ${kind} 卡`);
	return card;
}

/** 同一份夹具走皮肤那条路出的完整 HTML。 */
async function renderViaSkin(fixture: CardFixture, input: CardRenderInput): Promise<string> {
	const { vnode, css } = renderSkinnedCard({
		kind: fixture.kind,
		card: skinCardOf(fixture, input),
		props: input.props as never,
	});
	return await renderCard({ render: (): VNode => vnode }, {}, { ...input.options, extraCss: css });
}

/** 外框 → 玻璃层。两条路的壳都是这两层,基准那边没有挂点可选,一律按位置取。 */
function glassOf(html: string): Element {
	const frame = new JSDOM(html).window.document.body.firstElementChild;
	const glass = frame?.firstElementChild;
	if (!glass) throw new Error("这份 HTML 里找不到「外框 > 玻璃层」两层");
	return glass;
}

type BlockSlice = { label: string; inner: string };

/** 一份 HTML 里所有 `[data-block]` 按文档序的块名 + 内层(剥掉挂点)。 */
function blockSlices(html: string): BlockSlice[] {
	const doc = new JSDOM(html).window.document;
	return [...doc.querySelectorAll("[data-block]")].map((el) => ({
		label: el.getAttribute("data-block") ?? "",
		inner: stripCardHooks(el.innerHTML),
	}));
}

/** 玻璃层里那一层的元素子节点(剥挂点)。SSR 的 Fragment 锚点注释不参与 —— 见门 A 的说明。 */
function childHtml(parent: Element): string[] {
	return [...parent.children].map((el) => stripCardHooks(el.outerHTML));
}

describe("卡片皮肤验收门 A — 块内层与基准逐字节", () => {
	for (const fixture of CARD_FIXTURES) {
		it(`${fixture.name}:皮肤路径画出的块与模板基准一致`, async () => {
			const input = await fixture.build();
			const html = await renderViaSkin(fixture, input);
			const base = baselineHtml(fixture.name);

			if (SINGLE_BLOCK_KINDS.has(fixture.kind)) {
				// 整张一个块:皮肤路径比基准多一层 wrapper,剥掉它再比玻璃层里的那几个孩子。
				const wrappers = [...glassOf(html).children];
				expect(wrappers).toHaveLength(1);
				expect(childHtml(wrappers[0])).toEqual(childHtml(glassOf(base)));
				return;
			}

			const mine = blockSlices(html);
			const theirs = blockSlices(base);
			expect(mine.map((b) => b.label)).toEqual(theirs.map((b) => b.label));
			for (const [i, slice] of mine.entries()) {
				expect(slice.inner, `${fixture.name} 第 ${i + 1} 块(${slice.label})的内层变了`).toBe(
					theirs[i].inner,
				);
			}
		});
	}
});

/**
 * 网格声明的列数。`repeat(n, …)` 读 n,逐列写法(上舰卡那种混了定宽列的)数条目 ——
 * 数出来必须恒是 12:块的 `column` / `span` 都按 12 列算,少一列整张卡就错位。
 */
function columnCount(style: string): number {
	const tracks = /grid-template-columns:([^;]+)/.exec(style)?.[1] ?? "";
	const repeat = /^repeat\((\d+),/.exec(tracks);
	if (repeat) return Number(repeat[1]);
	return (tracks.match(/minmax\([^)]*\)|[\d.]+px|[\d.]+fr/g) ?? []).length;
}

describe("卡片皮肤验收门 B — 结构", () => {
	for (const fixture of CARD_FIXTURES) {
		it(`${fixture.name}:玻璃层是 12 列网格,每块都有 bn-blk- 的 class`, async () => {
			const input = await fixture.build();
			const glass = glassOf(await renderViaSkin(fixture, input));
			const style = glass.getAttribute("style") ?? "";
			expect(style).toContain("display:grid");
			expect(columnCount(style)).toBe(12);
			const wrappers = [...glass.children];
			expect(wrappers.length).toBeGreaterThan(0);
			for (const el of wrappers) {
				expect([...el.classList].some((c) => c.startsWith("bn-blk-"))).toBe(true);
				expect(el.getAttribute("style") ?? "").toContain("grid-row:");
			}
		});
	}
});
