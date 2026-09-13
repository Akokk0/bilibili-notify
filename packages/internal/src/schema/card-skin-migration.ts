/**
 * **旧版式 → 卡片皮肤**(ADR-0014 决策 15、17)。
 *
 * `cardLayout` v7 是一维竖栈(块的顺序 / 显隐 / 上边距)+ 上舰卡的受限 2D(徽章靠哪边);
 * 皮肤是 12 列网格 + 每块一段 CSS。这里把前者折成后者,存量用户升级后出图不变:
 *
 * - 顺序 → 行号(1..n,`visible:false` 的块**不生成**,不留空行);
 * - 12 列整跨 → 复刻「一块一行、通栏」的竖栈;
 * - `marginTop` → 该块 `[data-bn="self"]{padding-top:…}`(块间间距 = 下方块的上边距);
 * - 上舰卡 `badgeSide` → 徽章占 4 列、内容列占 8 列,徽章跨满内容的所有行。
 *
 * **`cardLayoutToSkin(DEFAULT_CARD_LAYOUT)` 必须等于 `DEFAULT_CARD_SKIN`** —— 那是
 * 「默认皮肤 = 旧默认版式」的证明,也是这份迁移对不对的唯一客观判据
 * (`__tests__/card-skin-migration.test.ts` 钉着)。
 */

import type { CardBlock, CardLayout, GuardLayout } from "./card-layout";
import {
	CARD_SKIN_LIMITS,
	type CardSkinBlock,
	type CardSkinCard,
	type CardSkinManifest,
	DEFAULT_CARD_SKIN,
} from "./card-skin";

/** 竖栈卡里块的通栏跨度。 */
const FULL_SPAN = CARD_SKIN_LIMITS.columns;

/** 上舰卡:徽章列 4 / 内容列 8(12 等分最接近今天「175px 徽章 + 剩下都是内容」的一档)。 */
const GUARD_BADGE_SPAN = 4;
const GUARD_CONTENT_SPAN = FULL_SPAN - GUARD_BADGE_SPAN;

/**
 * 徽章靠左时内容列整体右对齐 —— 复刻模板镜像时给内容列加的 `items-end text-right`
 * (`templates/guard-card.tsx`)。网格里没有「内容列」这个容器了,所以逐块加。
 */
const MIRROR_DECLS = "display:flex;flex-direction:column;align-items:flex-end;text-align:right";

/**
 * 一块的 CSS。上边距折成 `padding-top`(与 `renderBlocks` 一样用 padding 而非 margin,
 * 免得相邻 margin 塌缩);**首块不写** —— 旧渲染器把首块的上边距交给卡片框架统一提供。
 *
 * ⚠️ 这里的「首块」是**静态**的第一块(隐藏块已剔除),而旧渲染器判的是第一个**真画出来**
 * 的块。两者只在「第一块运行时没数据被收起、第二块又带上边距」时不同 —— 折出来会比旧的
 * 多一段上边距。宁可如此,也不在皮肤里再塞一条「首块特殊」的隐规矩:皮肤是所见即所得的。
 */
function blockCss(b: CardBlock, isFirst: boolean, mirror: boolean): string | undefined {
	const decls: string[] = [];
	if (!isFirst && b.marginTop !== undefined) decls.push(`padding-top:${b.marginTop}px`);
	if (mirror) decls.push(MIRROR_DECLS);
	return decls.length > 0 ? `[data-bn="self"]{${decls.join(";")}}` : undefined;
}

/** 一个 v7 块 → 一个皮肤块。内容块的 id 就是它的 type,分割线保留原 id(可多份)。 */
function toSkinBlock(
	b: CardBlock,
	grid: CardSkinBlock["grid"],
	css: string | undefined,
): CardSkinBlock {
	return {
		id: b.id,
		kind: "builtin",
		builtin: b.type,
		grid,
		...(css ? { css } : {}),
	};
}

/** 竖栈卡(live / dynamic / sc):一块一行、通栏。 */
function stackCard(blocks: CardBlock[], base: CardSkinCard): CardSkinCard {
	const visible = blocks.filter((b) => b.visible);
	return {
		width: base.width,
		...(base.css ? { css: base.css } : {}),
		...(base.gap ? { gap: base.gap } : {}),
		blocks: visible.map((b, i) =>
			toSkinBlock(b, { row: i + 1, column: 1, span: FULL_SPAN }, blockCss(b, i === 0, false)),
		),
	};
}

/**
 * 上舰卡:内容列(姓名 / 文字 / 可插分割线)上下排在一侧,徽章在另一侧跨满这些行。
 * 徽章在左时**排在块数组的最前面** —— 网格靠坐标定位,但 DOM 顺序还是按数组走,
 * 让它与看到的顺序一致(验收门按文档序对块序列)。
 */
function guardCard(layout: GuardLayout, base: CardSkinCard): CardSkinCard {
	const left = layout.badgeSide === "left";
	const visible = layout.blocks.filter((b) => b.visible);
	const content = visible.map((b, i) =>
		toSkinBlock(
			b,
			{ row: i + 1, column: left ? GUARD_BADGE_SPAN + 1 : 1, span: GUARD_CONTENT_SPAN },
			blockCss(b, i === 0, left),
		),
	);
	const badge: CardSkinBlock = {
		id: "badge",
		kind: "builtin",
		builtin: "badge",
		grid: {
			row: 1,
			column: left ? 1 : GUARD_CONTENT_SPAN + 1,
			span: GUARD_BADGE_SPAN,
			rowSpan: Math.max(content.length, 1),
		},
	};
	return {
		width: base.width,
		...(base.css ? { css: base.css } : {}),
		...(base.gap ? { gap: base.gap } : {}),
		blocks: left ? [badge, ...content] : [...content, badge],
	};
}

/**
 * 把一份 v7 版式折成一份皮肤。
 *
 * `base` 提供版式管不着的那些:卡宽、根块 CSS、间距,以及三张 AI 卡与词云(它们整张是一个
 * 固定内置块,没有版式可折,直接抄 base)。缺卡种的 base 回落出厂默认皮肤。
 */
export function cardLayoutToSkin(
	layout: CardLayout,
	base: CardSkinManifest = DEFAULT_CARD_SKIN,
): CardSkinManifest {
	const cardOf = (kind: keyof CardSkinManifest["cards"]): CardSkinCard =>
		// biome-ignore lint/style/noNonNullAssertion: 出厂默认皮肤七种卡齐全,是最后一道回落
		base.cards[kind] ?? DEFAULT_CARD_SKIN.cards[kind]!;
	return {
		...base,
		cards: {
			...base.cards,
			live: stackCard(layout.live, cardOf("live")),
			dynamic: stackCard(layout.dynamic, cardOf("dynamic")),
			sc: stackCard(layout.sc, cardOf("sc")),
			guard: guardCard(layout.guard, cardOf("guard")),
			roastBoard: cardOf("roastBoard"),
			roastSolo: cardOf("roastSolo"),
			wordcloud: cardOf("wordcloud"),
		},
	};
}
