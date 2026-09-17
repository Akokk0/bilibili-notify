/**
 * **旧版式 → 卡片皮肤**(ADR-0014 决策 15、17)。
 *
 * `cardLayout` v7 是一维竖栈(块的顺序 / 显隐 / 上边距)+ 上舰卡的受限 2D(徽章靠哪边);
 * 皮肤是 12 列网格 + 每块一段 CSS。这里把前者折成后者,存量用户升级后出图不变:
 *
 * - 顺序 → 行号(1..n,`visible:false` 的块**不生成**,不留空行);
 * - 12 列整跨 → 复刻「一块一行、通栏」的竖栈;
 * - `marginTop` → 该块 `[data-bn="self"]{padding-top:…}`(块间间距 = 下方块的上边距);
 * - 上舰卡 `badgeSide` → 徽章占 4 列(定宽,合 175px)、内容列占 8 列(等分),徽章跨满
 *   内容的所有行;原内容列的内边距与「贴顶 / 贴底」逐块补回(见 `guardBlockCss`)。
 * - 直播卡数据区的三个显隐开关(`cardStyle.show*`)→ 关过任何一个的,`data` 复合块换成
 *   **原子块拼装**(见 `dataAtoms`);三个都开的照旧用复合块,折出来一字不差。
 *
 * **`cardLayoutToSkin(DEFAULT_CARD_LAYOUT)` 必须等于 `LEGACY_DEFAULT_CARD_SKIN`** —— 那是
 * 「旧默认皮肤 = 旧默认版式」的证明,也是这份迁移对不对的唯一客观判据
 * (`card-skin-migration.test.ts` 钉着)。底子认的是**冻住的旧默认**,不是出厂默认皮肤:
 * 出厂默认 2026-09-18 起拆成了原子块(ADR-0014 决策 8 的 🔗),拿它当底子的话,派生皮肤
 * 会吃到为原子块写的列宽与 CSS,与存量用户原来的卡对不上。
 */

import type { CardBlock, CardLayout, GuardLayout } from "./card-layout";
import {
	CARD_SKIN_LIMITS,
	type CardSkinBlock,
	type CardSkinCard,
	type CardSkinColumn,
	type CardSkinKind,
	type CardSkinManifest,
	cardSkinFrameBgRule,
	DEFAULT_FRAME_BG_RULE,
	DEFAULT_SKIN_KNOB_KEYS,
	LEGACY_DEFAULT_CARD_SKIN,
} from "./card-skin";

/** 竖栈卡里块的通栏跨度。 */
const FULL_SPAN = CARD_SKIN_LIMITS.columns;

/**
 * 上舰卡:徽章列 4 / 内容列 8。徽章那 4 列**定宽**,合起来正好是徽章图的 175px ——
 * 12 等分给不出这个数(400 / 12 × 4 = 133.33),等分的话徽章会溢出自己的列。
 */
const GUARD_BADGE_SPAN = 4;
const GUARD_CONTENT_SPAN = FULL_SPAN - GUARD_BADGE_SPAN;
const GUARD_BADGE_PX = 175;
const GUARD_BADGE_COLUMN_PX = GUARD_BADGE_PX / GUARD_BADGE_SPAN;

/** 原内容列的内边距(`px-[16px] py-[12px]`)—— 网格里没有那个容器了,逐块补回来。 */
const GUARD_PAD_X = 16;
const GUARD_PAD_Y = 12;

/** 玻璃层的高度。徽章那一格占满它、内部垂直居中,复刻旧外框的 `items-center`。 */
const GUARD_CARD_HEIGHT = 190;

/**
 * 徽章块:占满卡高、内部垂直居中、贴着第一行的顶。三句缺一不可 ——
 * 不给高度,徽章会跟着内容行走(内容超高时整体下沉);不 `align-self:start`,
 * 这一格自己又会被居中一次。
 */
const GUARD_BADGE_CSS = `[data-bn="self"]{height:${GUARD_CARD_HEIGHT}px;display:flex;align-items:center;align-self:start}`;

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

/** 一张卡的壳(卡宽 / 根块 CSS / 间距照抄 base),块序列由调用方给。 */
function cardWith(base: CardSkinCard, blocks: CardSkinBlock[]): CardSkinCard {
	return {
		width: base.width,
		...(base.css ? { css: base.css } : {}),
		...(base.gap ? { gap: base.gap } : {}),
		blocks,
	};
}

/** 竖栈卡(live / dynamic / sc):一块一行、通栏。 */
function stackCard(blocks: CardBlock[], base: CardSkinCard): CardSkinCard {
	const visible = blocks.filter((b) => b.visible);
	return cardWith(
		base,
		visible.map((b, i) =>
			toSkinBlock(b, { row: i + 1, column: 1, span: FULL_SPAN }, blockCss(b, i === 0, false)),
		),
	);
}

// ── 直播卡数据区:三个显隐开关 → 原子块 ───────────────────────────────────────

/**
 * 数据区那三件的显隐开关(退役中的 `cardStyle.showPopularity / showArea / showFans`)。
 *
 * 三个都开(或整个不传)时数据区照旧是一个 `data` 复合块;关过任何一个,就换成用原子块
 * 拼出来的同一副样子 —— 因为块级的 `showIf` 管不到复合块**内部**的一行(ADR-0014 决策 16
 * 的 🔗:不留开关,拆成原子块让用户直接编辑块)。
 */
export interface LiveDataToggles {
	showPopularity: boolean;
	showArea: boolean;
	showFans: boolean;
}

/** live 版式里数据复合块的 type。 */
const LIVE_DATA_TYPE = "data";

/**
 * 顶行两件各占半边(人气 1~6 列、分区 7~12 列)—— 复刻复合块顶行的
 * `flex justify-between`:左边贴左、右边贴右。只剩一件时那件通栏。
 */
const DATA_HALF_SPAN = FULL_SPAN / 2;

/** 分区永远靠右,单独在时也是 —— 顶行那两件的左 / 右是它们各自的身份,不是「谁先谁后」。 */
const AREA_ALIGN = "text-align:right";

/** 顶行与粉丝行之间的 4px:复合块根上的 `gap-1`。网格里没有那个 flex 容器了,落到下一行块上。 */
const DATA_ROW_GAP = 4;

/** 一个数据区原子块。`decls` 为空就不写 css(与别处同规矩:没内容的 css 一律不生成)。 */
function dataAtom(builtin: string, grid: CardSkinBlock["grid"], decls: string[]): CardSkinBlock {
	return {
		id: builtin,
		kind: "builtin",
		builtin,
		grid,
		...(decls.length > 0 ? { css: `[data-bn="self"]{${decls.join(";")}}` } : {}),
	};
}

/**
 * `data` 复合块 → 原子块拼装。关掉的项**不生成**(不是生成了再藏)。
 *
 * 两处是在复刻复合块的根:`marginTop` 落到**该组第一行**的块上(顶行在就落顶行那两件,
 * 顶行整个关掉就落到粉丝行),粉丝行的 `padding-top:4px` 复刻根上的 `gap-1`。
 */
function dataAtoms(
	b: CardBlock,
	isFirst: boolean,
	toggles: LiveDataToggles,
	row: number,
): CardSkinBlock[] {
	const { showPopularity, showArea, showFans } = toggles;
	// 首块的上边距由卡片框架统一提供(与 `blockCss` 同一条规矩)。
	const groupTop = !isFirst && b.marginTop !== undefined ? [`padding-top:${b.marginTop}px`] : [];
	const hasTopRow = showPopularity || showArea;
	const both = showPopularity && showArea;
	const out: CardSkinBlock[] = [];
	if (showPopularity) {
		out.push(
			dataAtom("popularity", { row, column: 1, span: both ? DATA_HALF_SPAN : FULL_SPAN }, groupTop),
		);
	}
	if (showArea) {
		out.push(
			dataAtom(
				"area",
				{
					row,
					column: both ? DATA_HALF_SPAN + 1 : 1,
					span: both ? DATA_HALF_SPAN : FULL_SPAN,
				},
				[...groupTop, AREA_ALIGN],
			),
		);
	}
	if (showFans) {
		out.push(
			dataAtom(
				"fans",
				{ row: hasTopRow ? row + 1 : row, column: 1, span: FULL_SPAN },
				hasTopRow ? [`padding-top:${DATA_ROW_GAP}px`] : groupTop,
			),
		);
	}
	return out;
}

/**
 * 直播卡:竖栈,只是 `data` 那一块可能被展开成原子块组(占 0~2 行)。
 * 三个开关全开 / 不传 → 与 `stackCard` 逐字相同。
 */
function liveCard(
	blocks: CardBlock[],
	base: CardSkinCard,
	toggles?: LiveDataToggles,
): CardSkinCard {
	if (!toggles || (toggles.showPopularity && toggles.showArea && toggles.showFans)) {
		return stackCard(blocks, base);
	}
	const visible = blocks.filter((b) => b.visible);
	const out: CardSkinBlock[] = [];
	let row = 0;
	visible.forEach((b, i) => {
		if (b.type !== LIVE_DATA_TYPE) {
			row += 1;
			out.push(toSkinBlock(b, { row, column: 1, span: FULL_SPAN }, blockCss(b, i === 0, false)));
			return;
		}
		const atoms = dataAtoms(b, i === 0, toggles, row + 1);
		out.push(...atoms);
		// 三件全关 → 一行都不占(复合块今天就是整块收起),后面的块不留空行。
		row += new Set(atoms.map((a) => a.grid.row)).size;
	});
	return cardWith(base, out);
}

/** 徽章在左 / 在右两种列宽:定宽的 4 列跟着徽章走,剩下 8 列等分给内容。 */
function guardColumns(left: boolean): CardSkinColumn[] {
	const content: CardSkinColumn[] = Array.from({ length: GUARD_CONTENT_SPAN }, () => ({ fr: 1 }));
	const badge: CardSkinColumn[] = Array.from({ length: GUARD_BADGE_SPAN }, () => ({
		px: GUARD_BADGE_COLUMN_PX,
	}));
	return left ? [...badge, ...content] : [...content, ...badge];
}

/**
 * 上舰卡内容块的 CSS。除了竖栈那套(上边距、镜像),还要补回原内容列自己的内边距:
 * 左右恒 16px(**两边都补** —— 右边那 16px 决定文字在哪儿折行,少了它镜像那侧的
 * 文字会换一种折法),上下 12px 只落在首 / 末块(原来是容器的 `py`)。
 *
 * `align-self` 把原来 `justify-between` 的「首块贴顶、末块贴底」钉死:徽章那一格占满
 * 卡高会把内容行撑开,不钉的话块会跟着行一起被挪。只有一个块时按旧行为贴顶。
 */
function guardBlockCss(b: CardBlock, isFirst: boolean, isLast: boolean, mirror: boolean): string {
	const top = isFirst ? GUARD_PAD_Y : (b.marginTop ?? 0);
	const bottom = isLast ? GUARD_PAD_Y : 0;
	const decls = [`padding:${top}px ${GUARD_PAD_X}px ${bottom}px`];
	if (isFirst) decls.push("align-self:start");
	else if (isLast) decls.push("align-self:end");
	if (mirror) decls.push(MIRROR_DECLS);
	return `[data-bn="self"]{${decls.join(";")}}`;
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
			guardBlockCss(b, i === 0, i === visible.length - 1, left),
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
		css: GUARD_BADGE_CSS,
	};
	return {
		width: base.width,
		columns: guardColumns(left),
		...(base.css ? { css: base.css } : {}),
		...(base.gap ? { gap: base.gap } : {}),
		blocks: left ? [badge, ...content] : [...content, badge],
	};
}

// ── 退役的渐变色 → 外框 CSS ───────────────────────────────────────────────────

/** 一对渐变端点色。 */
export interface CardSkinGradient {
	start: string;
	end: string;
}

/**
 * 存量用户改过的渐变色(退役中的 `cardStyle.cardColorStart / cardColorEnd`)。
 *
 * - `base`:所有吃用户色的卡种的默认。对应 `globals.defaults.cardStyle` 那一份。
 * - `byKind`:某个卡种另有一份(`cardStyleByKind.<kind>` 或 per-UP 覆盖算出来的)。
 *   只有 **live / dynamic / roastBoard / roastSolo / wordcloud** 吃用户色;SC 按价位档、
 *   上舰按舰长等级(`--bn-card-tier-color`),给它们写颜色没有意义,这里直接忽略。
 *
 * 两处都不传(或整个参数不传)= 颜色就是出厂色,外框 CSS 一字不动。
 */
export interface CardSkinColors {
	base?: CardSkinGradient;
	byKind?: Partial<Record<CardSkinKind, CardSkinGradient>>;
}

/** 吃用户渐变色的卡种。sc / guard 不在其中(它们的底色按档位走)。 */
const USER_GRADIENT_KINDS = [
	"live",
	"dynamic",
	"roastBoard",
	"roastSolo",
	"wordcloud",
] as const satisfies readonly CardSkinKind[];

type UserGradientKind = (typeof USER_GRADIENT_KINDS)[number];

const isUserGradientKind = (k: CardSkinKind): k is UserGradientKind =>
	(USER_GRADIENT_KINDS as readonly CardSkinKind[]).includes(k);

/**
 * 把一张卡外框 CSS 里那条「用户渐变」规则**换成**指定的两端色。
 *
 * 换而不是加:`background` 写两遍只有后一条生效,追加等于赌规则顺序。认不出默认那条规则
 * (`base` 不是出厂皮肤)时原样返回 —— 不知道该换哪条就什么都别动,宁可颜色没迁进去,
 * 也不在别人的皮肤里塞一条来历不明的 background。
 *
 * 换进去的**仍是旋钮形态**(2026-09-14):派生皮肤是从默认皮肤克隆的,连那两枚渐变旋钮的
 * 声明一起带走了 —— 把颜色写死成字面量的话,面板上那两个取色器就成了拧不动的摆设。
 * 存量颜色进的是**兜底位**,用户没拧过看到的就是他原来的色,拧了照样生效。
 */
function withGradient(
	css: string | undefined,
	c: CardSkinGradient | undefined,
): string | undefined {
	if (!c) return css;
	const next = cardSkinFrameBgRule(
		`var(--bn-knob-${DEFAULT_SKIN_KNOB_KEYS.gradientStart},${c.start})`,
		`var(--bn-knob-${DEFAULT_SKIN_KNOB_KEYS.gradientEnd},${c.end})`,
	);
	if (css === undefined) return next;
	return css.includes(DEFAULT_FRAME_BG_RULE) ? css.replace(DEFAULT_FRAME_BG_RULE, next) : css;
}

/**
 * 派生皮肤里那两枚渐变旋钮的**起始位置**跟着存量颜色走 —— 面板打开时取色器显示的
 * 该是主人原来那两个色,不是出厂色。只动 `default`,不碰声明的其余部分。
 */
/**
 * 存量颜色能不能当颜色旋钮的默认值。契约 2026-09-14 收紧成 hex-only,而
 * `cardStyle.cardColorStart` 是个**没有格式约束**的字符串(面板的取色器只吐 hex,手改
 * 配置或走 API 灌进来的可以是任何东西)。塞进去过不了装包门,而装包门正在开机迁移的
 * 必经之路上 —— 一炸就是起不来,与上面「名字太长」同一类防守。
 */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function knobsWithGradientDefaults(
	knobs: CardSkinManifest["knobs"],
	base: CardSkinGradient | undefined,
): CardSkinManifest["knobs"] {
	if (!knobs || !base) return knobs;
	const K = DEFAULT_SKIN_KNOB_KEYS;
	// 拿不了的色就把起始位置留在出厂值。**CSS 那头照旧用主人的色** —— 卡片外观不变是
	// 迁移的头等目标,这里让步的只是面板上取色器的起始位置。
	const pick = (v: string, fallback: string): string => (HEX_COLOR_RE.test(v) ? v : fallback);
	return knobs.map((k) => {
		if (k.type !== "color") return k;
		if (k.key === K.gradientStart) return { ...k, default: pick(base.start, k.default) };
		if (k.key === K.gradientEnd) return { ...k, default: pick(base.end, k.default) };
		return k;
	});
}

/** 这张卡该用哪对色:卡种自己那份优先,否则全局那份。 */
function gradientFor(
	colors: CardSkinColors | undefined,
	kind: UserGradientKind,
): CardSkinGradient | undefined {
	return colors?.byKind?.[kind] ?? colors?.base;
}

/**
 * 把一份 v7 版式折成一份皮肤。
 *
 * `base` 提供版式管不着的那些:卡宽、根块 CSS、间距,以及三张 AI 卡与词云(它们整张是一个
 * 固定内置块,没有版式可折,直接抄 base)。不传就是冻住的旧默认皮肤,缺卡种的 base 也回落它。
 *
 * `toggles` 是直播卡数据区那三个显隐开关(`cardStyle.show*`)。不传 = 三个都开 = 数据区
 * 照旧用 `data` 复合块;关过任何一个的存量用户,折出来的是用原子块拼的同一副样子。
 *
 * `colors` 是退役中的渐变起 / 止色(`cardStyle.cardColorStart / cardColorEnd`)。传了就把
 * 对应卡种外框 CSS 里那条渐变规则换掉 —— **只认 `base` 是出厂皮肤的情形**(迁移就是这么调的);
 * 形状见 {@link CardSkinColors}。
 */
export function cardLayoutToSkin(
	layout: CardLayout,
	base: CardSkinManifest = LEGACY_DEFAULT_CARD_SKIN,
	toggles?: LiveDataToggles,
	colors?: CardSkinColors,
): CardSkinManifest {
	const cardOf = (kind: keyof CardSkinManifest["cards"]): CardSkinCard => {
		// biome-ignore lint/style/noNonNullAssertion: 旧默认皮肤七种卡齐全,是最后一道回落
		const card = base.cards[kind] ?? LEGACY_DEFAULT_CARD_SKIN.cards[kind]!;
		const g = isUserGradientKind(kind) ? gradientFor(colors, kind) : undefined;
		const css = withGradient(card.css, g);
		return css === card.css ? card : { ...card, css };
	};
	const knobs = knobsWithGradientDefaults(base.knobs, colors?.base);
	return {
		...base,
		...(knobs ? { knobs } : {}),
		cards: {
			...base.cards,
			live: liveCard(layout.live, cardOf("live"), toggles),
			dynamic: stackCard(layout.dynamic, cardOf("dynamic")),
			sc: stackCard(layout.sc, cardOf("sc")),
			guard: guardCard(layout.guard, cardOf("guard")),
			roastBoard: cardOf("roastBoard"),
			roastSolo: cardOf("roastSolo"),
			wordcloud: cardOf("wordcloud"),
		},
	};
}
