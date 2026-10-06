/**
 * 档位卡(醒目留言 / 会员)的 `data-rank` 属性(㉔d,ADR-0028 决策 4 的 2026-10-06 🔗:按档换色的挂点是属性 `data-rank`)。
 *
 * 出图器在这两种卡的**外框**(`data-bn="frame"` 那一层)和**每个块的 wrapper**(带 `bn-blk-<id>` 的那层 div)上写
 * `data-rank="<档位>"`:醒目留言用视图上夹进 1–6 的有效档位,会员用视图的 `rank`;没有 rank(0)的会员档不写;别的卡一律不写。
 * 皮肤 CSS 于是能写 `[data-bn="frame"][data-rank="3"]{…}` / `[data-bn="self"][data-rank="3"]{…}` 按档换色。
 * 清洗器放行这两条规则(`apps/server/src/card-skins/__tests__/rank-selectors.test.ts` 断言过它们清洗后原样);下面最后一组把同样的两条
 * 规则塞进皮肤、真出图,断言翻译后的选择器在渲染出的 DOM 上档位对得上的选得中、对不上的选不中。
 */

import {
	CARD_SKIN_RANK_ATTR,
	type CardSkinCard,
	type CardSkinManifest,
	DEFAULT_CARD_SKIN,
} from "@bilibili-notify/internal";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import { renderCardWithSkin } from "../skin/render-skin";
import { CARD_FIXTURES } from "./fixtures/card-fixtures";
import { renderViaDefaultSkin, renderViaSkin } from "./fixtures/skin-render";

const TIERED = [
	"sc-low",
	"sc-high",
	"guard-captain",
	"guard-governor",
	"guard-badge-left",
] as const;
const UNTIERED = ["live-streaming", "dynamic-av", "dynamic-forward", "roast-board", "wordcloud"];

const fixtureOf = (name: string) => {
	const fixture = CARD_FIXTURES.find((f) => f.name === name);
	if (!fixture) throw new Error(`夹具表里没有 ${name}`);
	return fixture;
};

const docOf = (html: string) => new JSDOM(html).window.document;

/** 块的 wrapper:内层那层 div,class 是 `bn-blk-<id>`。 */
const blockWrappers = (doc: Document): Element[] =>
	[...doc.querySelectorAll("div")].filter((el) => /^bn-blk-/.test(el.getAttribute("class") ?? ""));

describe("data-rank:属性名是一个常量", () => {
	it("就叫 data-rank(皮肤作者与 AI 做皮肤的说明读的是同一个常量)", () => {
		expect(CARD_SKIN_RANK_ATTR).toBe("data-rank");
	});
});

describe("data-rank:醒目留言卡与会员卡的外框和每个块 wrapper 都带档位", () => {
	for (const name of TIERED) {
		it(`${name}:外框与每个块的 wrapper 的 data-rank 都等于视图的 rank`, async () => {
			const fixture = fixtureOf(name);
			const input = await fixture.build();
			const rank = (input.props as unknown as { rank: number }).rank;
			expect(rank, "夹具的档位应是真档位").toBeGreaterThan(0);
			const doc = docOf(await renderViaSkin(fixture, input));

			expect(doc.querySelector('[data-bn~="frame"]')?.getAttribute("data-rank")).toBe(String(rank));
			const wrappers = blockWrappers(doc);
			expect(wrappers.length).toBeGreaterThan(0);
			for (const el of wrappers) {
				expect(el.getAttribute("data-rank"), el.getAttribute("class") ?? "").toBe(String(rank));
			}
		});
	}

	it("醒目留言两档:rank 取视图上夹进 1–6 的有效档位(不是输入的原值)", async () => {
		const low = await renderViaSkin(fixtureOf("sc-low"), await fixtureOf("sc-low").build());
		const high = await renderViaSkin(fixtureOf("sc-high"), await fixtureOf("sc-high").build());
		expect(docOf(low).querySelector('[data-bn~="frame"]')?.getAttribute("data-rank")).toBe("1");
		expect(docOf(high).querySelector('[data-bn~="frame"]')?.getAttribute("data-rank")).toBe("6");
	});
});

describe("data-rank:没有 rank 的会员档、别的卡一律不加", () => {
	it("会员卡 rank 为 0(没有 rank 的体系)→ 整张卡一个 data-rank 都没有", async () => {
		const fixture = fixtureOf("guard-captain");
		const props = (await fixture.build()).props as unknown as Record<string, unknown>;
		const html = await renderViaDefaultSkin("membership", { ...props, rank: 0 });
		expect(html).not.toContain("data-rank");
		// 对照:同一张卡有 rank 时是有的 —— 上面那条不是因为根本没渲染出东西才绿。
		const withRank = await renderViaDefaultSkin("membership", { ...props, rank: 2 });
		expect(withRank).toContain('data-rank="2"');
	});

	for (const name of UNTIERED) {
		it(`${name}:没有 data-rank`, async () => {
			const fixture = fixtureOf(name);
			expect(await renderViaSkin(fixture, await fixture.build())).not.toContain("data-rank");
		});
	}
});

// ── 皮肤 CSS 按档写规则:翻译后的选择器真能选中渲染出的元素 ───────────────────────────────

/** 清洗器放行且原样保留的两条按档规则(与 `rank-selectors.test.ts` 里断言的是同一对字符串)。 */
const BLOCK_RULE = `[data-bn="self"][data-rank="3"]{color:rgb(1,2,3)}`;
const FRAME_RULE = `[data-bn="frame"][data-rank="3"]{outline:2px solid rgb(4,5,6)}`;

/** 默认皮肤的醒目留言卡:外框 CSS 追加 {@link FRAME_RULE},`amount` 块 CSS 追加 {@link BLOCK_RULE}。 */
function skinWithRankRules(): CardSkinManifest {
	const base = DEFAULT_CARD_SKIN.cards.superchat as CardSkinCard;
	return {
		...DEFAULT_CARD_SKIN,
		cards: {
			...DEFAULT_CARD_SKIN.cards,
			superchat: {
				...base,
				css: `${base.css ?? ""}${FRAME_RULE}`,
				blocks: base.blocks.map((b) =>
					b.id === "amount" ? { ...b, css: `${b.css ?? ""}${BLOCK_RULE}` } : b,
				),
			},
		},
	} as CardSkinManifest;
}

/** 渲染出的整页 HTML 里,选择器带 `data-rank` 的每条规则的选择器(翻译之后的写法)。 */
function rankSelectors(html: string): string[] {
	const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
	return [...css.matchAll(/([^{}]*\[data-rank="\d"\][^{}]*)\{/g)].map((m) => (m[1] ?? "").trim());
}

async function scProps(name: string, rank: number): Promise<unknown> {
	const props = (await fixtureOf(name).build()).props as unknown as Record<string, unknown>;
	return { ...props, rank };
}

describe("data-rank:翻译后的选择器在渲染出的 DOM 上档位对上的选得中、对不上的选不中", () => {
	it("醒目留言 rank 3:块规则与外框规则各选中自己的那一个元素", async () => {
		const html = await renderCardWithSkin(
			"superchat",
			(await scProps("sc-low", 3)) as never,
			skinWithRankRules(),
		);
		const selectors = rankSelectors(html);
		expect(selectors).toHaveLength(2);
		const doc = docOf(html);
		const frameSel = selectors.find((s) => s.includes('[data-bn~="frame"]'));
		const blockSel = selectors.find((s) => s.includes(".bn-blk-amount"));
		if (!frameSel || !blockSel) throw new Error(`翻译后的选择器:${selectors.join(" | ")}`);
		expect(doc.querySelectorAll(frameSel)).toHaveLength(1);
		const hit = doc.querySelectorAll(blockSel);
		expect(hit).toHaveLength(1);
		expect(hit[0]?.getAttribute("data-block")).toBe("amount");
	});

	it("rank 1:同一套规则(写的是第 3 档)一个元素都选不中", async () => {
		const html = await renderCardWithSkin(
			"superchat",
			(await scProps("sc-low", 1)) as never,
			skinWithRankRules(),
		);
		const selectors = rankSelectors(html);
		expect(selectors).toHaveLength(2);
		const doc = docOf(html);
		for (const sel of selectors) expect(doc.querySelectorAll(sel), sel).toHaveLength(0);
	});

	it("没有 rank 的会员档:整张卡没有 data-rank,按档的外框规则一条也选不中", async () => {
		const guard = DEFAULT_CARD_SKIN.cards.membership as CardSkinCard;
		const skin = {
			...DEFAULT_CARD_SKIN,
			cards: {
				...DEFAULT_CARD_SKIN.cards,
				membership: { ...guard, css: `${guard.css ?? ""}${FRAME_RULE}` },
			},
		} as CardSkinManifest;
		const props = (await fixtureOf("guard-captain").build()).props as unknown as Record<
			string,
			unknown
		>;
		const html = await renderCardWithSkin("membership", { ...props, rank: 0 } as never, skin);
		const doc = docOf(html);
		expect(doc.querySelectorAll("[data-rank]")).toHaveLength(0);
		const selectors = rankSelectors(html);
		expect(selectors).toHaveLength(1);
		expect(doc.querySelectorAll(selectors[0] ?? "")).toHaveLength(0);
	});
});
