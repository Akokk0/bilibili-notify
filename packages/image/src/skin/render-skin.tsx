/** @jsxImportSource vue */

/**
 * **皮肤渲染器**(ADR-0014 决策 18)—— 一份洗过的皮肤条目 + 一张卡的 props,装配成
 * 「外框 + 12 列网格 + 块」的 VNode,外加一段要拼在 UnoCSS 之后的 CSS。
 *
 * 与模板路径的分工:模板按**旧版式**(`CardBlock[]` 竖栈 / 上舰受限 2D)把块装进外框,
 * 这里按**皮肤**(网格坐标)装。两条路共用同一份块库(`blocks/*`)与同一份外框
 * (`blocks/frames.tsx`),所以「皮肤画出来的块」与「模板画出来的块」内层逐字节相同 ——
 * 这正是验收门 A(`__tests__/skin-gate.test.ts`)钉的东西。
 *
 * 四条纪律:
 * - **只吃洗过的皮肤**:CSS 与自定义 HTML 的清洗归 server 的清洗器(装包时做一次),
 *   这里只做**替换与转义**,不再清洗 —— 别在这儿补第二道闸,补了就会有人以为这儿能拦。
 * - **块内层一个字节都不碰**:块库返回什么就铺什么,皮肤只能从外面(wrapper + CSS)改。
 * - **挂点按 hook 翻译**:皮肤写 `[data-bn="avatar"]`,这里翻成 `.bn-blk-<id> [data-bn~="avatar"]`。
 *   用 `~=` 不用 `=`:单图图廊那个容器挂的是 `"pics pic"` 双挂点,`=` 会漏掉它。
 * - **取不到的字段一律空串**,绝不让 `undefined` 或原样的 `{a.b}` 进图里。
 */

import type { CardSkinAssetVars, CardSkinFont } from "@bilibili-notify/internal";
import {
	CARD_SKIN_BUILTIN_BLOCKS,
	CARD_SKIN_FIELDS,
	CARD_SKIN_LIMITS,
	CARD_SKIN_SELF_HOOK,
	CARD_SKIN_VARIABLES,
	type CardSkinBlock,
	type CardSkinCard,
	type CardSkinKind,
	type CardSkinKnob,
	type CardSkinKnobOverrides,
	type CardSkinManifest,
	cardSkinKnobDeclarations,
	DEFAULT_CARD_SKIN,
	DIVIDER_TYPE,
	rowMapOf,
} from "@bilibili-notify/internal";
import { h, type VNode } from "vue";
import { DYNAMIC_BLOCKS } from "../blocks/dynamic";
import { type CardPropsByKind, FRAMES, type FrameExtra } from "../blocks/frames";
import { GUARD_BLOCKS } from "../blocks/guard";
import { LIVE_BLOCKS } from "../blocks/live";
import { ROAST_BOARD_BLOCKS, ROAST_SOLO_BLOCKS } from "../blocks/roast";
import { SC_BLOCKS } from "../blocks/sc";
import type { BlockRenderer } from "../blocks/types";
import { WORDCLOUD_BLOCKS } from "../blocks/wordcloud";
import { renderCard } from "../render";
import type { DynamicCardProps } from "../templates/dynamic-card";
import type { DynamicNode } from "../templates/dynamic-content";
import type { Dynamic } from "../types";
import { buildCardData, type CardData, readCardField } from "./card-data";
import type { ResolvedKnobAssets } from "./knob-assets";

/**
 * 1×1 透明 GIF —— 取不到的包内资产退成它(与远端图被拦时同一串,见 `image-renderer.ts`)。
 * 单点定义:两处各写一份的话,迟早出现「一处换了、另一处还是老的」。
 */
export const BLOCKED_IMG_PLACEHOLDER =
	"data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/** 每种卡的块表(键名对齐 `CARD_SKIN_BUILTIN_BLOCKS`)。 */
const BLOCK_TABLES: Record<CardSkinKind, Record<string, BlockRenderer<never>>> = {
	live: LIVE_BLOCKS,
	dynamic: DYNAMIC_BLOCKS,
	sc: SC_BLOCKS,
	guard: GUARD_BLOCKS,
	roastBoard: ROAST_BOARD_BLOCKS,
	roastSolo: ROAST_SOLO_BLOCKS,
	wordcloud: WORDCLOUD_BLOCKS,
} as unknown as Record<CardSkinKind, Record<string, BlockRenderer<never>>>;

export interface SkinRenderOptions<K extends CardSkinKind = CardSkinKind> {
	kind: K;
	/** 该卡种的皮肤条目(已由 server 清洗 / 校验过)。 */
	card: CardSkinCard;
	/** 与模板同一份 props。 */
	props: CardPropsByKind[K];
	/** 仅 dynamic 卡:原始动态,视频卡 / 图廊那两组契约字段从它取。 */
	raw?: Dynamic;
	/** 包内资产名 → data URL(宿主注入)。缺省或回 undefined → 用透明占位 GIF。 */
	resolveAsset?: (name: string) => string | undefined;
	/** 皮肤自带的字体(清单级),每款注一条 `@font-face`;解析不出资产的那款跳过。 */
	fonts?: readonly CardSkinFont[];
	/** 皮肤声明的旋钮(清单级)。注入面只认这张表,存储里多出来的 key 一概不认。 */
	knobs?: readonly CardSkinKnob[];
	/** 用户拧过的旋钮值(按皮肤 id 存的那一份)。没拧过的 key 不在里面。 */
	knobValues?: CardSkinKnobOverrides;
	/**
	 * 宿主已经解析好的那两档旋钮(字体文件 / 图):额外的 `@font-face` 与要注在根块上的
	 * 变量。**在这儿注不在 `knobValues` 里注** —— 它们要读盘,而这条路径是同步的。
	 */
	knobAssets?: ResolvedKnobAssets;
}

export interface SkinRenderResult {
	vnode: VNode;
	/** 皮肤的 CSS(挂点已翻成真实选择器)。调用方塞进 `renderCard` 的 `extraCss`。 */
	css: string;
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

/** 文本与属性值统一的 HTML 转义(属性位置也用它,所以引号必须转)。 */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * 块 id → wrapper 的 class。**同一个函数既生成 class 属性也生成 CSS 选择器**,所以
 * 两边永远对得上;顺手把 id 里的怪字符换成下划线,皮肤 id 再脏也拼不出第二个选择器。
 */
function blockClass(id: string): string {
	return `bn-blk-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** 皮肤 CSS 里的挂点选择器。清洗器的产物只有 `[data-bn="x"]` 这一种写法(css-tree generate)。 */
const HOOK_SELECTOR_RE = /\[data-bn="([^"]*)"\]/g;

/**
 * 块级 CSS:`self` → 该块的 class;其余挂点只把 `=` 换成 `~=`。
 *
 * 前缀**不在这里补**:清洗器已把每条选择器归一成以 `[data-bn="self"]` 起头(ADR-0014
 * 决策 13 的 🔗),挂点永远出现在它后面;这里若再给挂点补 `.bn-blk-x `,就成了
 * `.bn-blk-x .bn-blk-x [data-bn~=…]`,一条都选不中。
 */
function translateBlockCss(css: string, cls: string): string {
	return css.replace(HOOK_SELECTOR_RE, (_m, hook: string) =>
		hook === CARD_SKIN_SELF_HOOK ? `.${cls}` : `[data-bn~="${hook}"]`,
	);
}

/** `asset:assets/x.png` → `assets/x.png`(与自定义块 `src` 那条路同一个前缀)。 */
const ASSET_PREFIX = "asset:";

/**
 * 一张资产变量表 → 一串 inline 声明 `--bn-asset-<名>:url("<data URL>");`。
 * 解析不出的资产**不注**:留一个指向空串的 `url("")` 会让浏览器去请求文档自身,而作者
 * 在 CSS 里写的 `var(--bn-asset-x, none)` 兜底反倒失效。
 */
function assetVarsStyle(
	vars: CardSkinAssetVars | undefined,
	resolveAsset: SkinRenderOptions["resolveAsset"],
): string {
	if (!vars) return "";
	let out = "";
	for (const [name, ref] of Object.entries(vars)) {
		const url = resolveAsset?.(ref.slice(ASSET_PREFIX.length));
		if (url) out += `--bn-asset-${name}:url("${url}");`;
	}
	return out;
}

/** 皮肤字体 → 一串 `@font-face`(每款一条;资产解析不出的跳过)。 */
function fontFaces(
	fonts: readonly CardSkinFont[] | undefined,
	resolveAsset: SkinRenderOptions["resolveAsset"],
): string {
	if (!fonts) return "";
	let out = "";
	for (const f of fonts) {
		const url = resolveAsset?.(f.asset.slice(ASSET_PREFIX.length));
		if (url) out += `@font-face{font-family:"${f.family}";src:url("${url}")}`;
	}
	return out;
}

/** 根级 CSS:`frame` / `glass` 本就挂在 DOM 上,只把 `=` 换成 `~=`。 */
function translateRootCss(css: string): string {
	return css.replace(HOOK_SELECTOR_RE, (_m, hook: string) => `[data-bn~="${hook}"]`);
}

// ── 自定义块的内容 ────────────────────────────────────────────────────────────

/** `src="…"` 整值占位符 / 资产名,或文本位置的 `{a.b}`。src 分支先匹配,所以它里头的花括号不会被二次替换。 */
const CUSTOM_HTML_RE = /src="([^"]*)"|\{([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\}/g;

/** 该卡种里这个字段是不是图片类型 —— 只有图片类型才准进 `src`(ADR-0014 决策 12)。 */
function isImageField(kind: CardSkinKind, path: string): boolean {
	return CARD_SKIN_FIELDS[kind].some((f) => f.path === path && f.type === "image");
}

/**
 * 自定义块的 HTML:替换占位符 + 转义。**不做清洗**(装包时已按白名单重建过节点树)。
 *
 * - 文本 / 普通属性里的 `{a.b}` → 字段值,HTML 转义;取不到给空串。
 * - `src="{a.b}"` → 只在该字段是图片类型时替换,否则空串(别让任意文本变成一次取网)。
 * - `src="asset:<名>"` → 宿主解析出的 data URL,解析不出给透明占位 GIF。
 * - 其余 `src="…"`(清洗器放行的字面地址)原样带过。
 */
function renderCustomHtml(
	html: string,
	kind: CardSkinKind,
	data: CardData,
	resolveAsset?: (name: string) => string | undefined,
): string {
	return html.replace(
		CUSTOM_HTML_RE,
		(match, src: string | undefined, path: string | undefined) => {
			if (src !== undefined) {
				if (src.startsWith("asset:")) {
					const url = resolveAsset?.(src.slice("asset:".length)) ?? BLOCKED_IMG_PLACEHOLDER;
					return `src="${escapeHtml(url)}"`;
				}
				const whole = /^\{([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\}$/.exec(src);
				if (!whole) return match;
				if (!isImageField(kind, whole[1])) return 'src=""';
				return `src="${escapeHtml(String(readCardField(data, whole[1]) ?? ""))}"`;
			}
			return escapeHtml(String(readCardField(data, path as string) ?? ""));
		},
	);
}

// ── 皮肤变量 ──────────────────────────────────────────────────────────────────

/**
 * 用户在面板里调的那几样 → 根块上的 CSS 自定义属性(ADR-0014 决策 15、16)。
 * 字体不在 props 里(它经 `renderCard` 的 `font` 进来),所以不写 `--bn-card-font`。
 *
 * 渐变起 / 止色**不在这里注**(决策 15 的 🔗):底色归皮肤自己的外框 CSS,
 * props 里那两个颜色字段只剩模板路径(基准快照)在用。**玻璃同理**(决策 16 的 🔗,
 * 2026-09-14):它退役成皮肤自己的旋钮,值从 `cardSkinKnobs` 经 `knobValues` 进来,
 * 不再从 props 翻译。
 */
function frameVariables(props: unknown): string {
	const p = props as {
		bgColor?: readonly [string, string];
		backgroundImage?: string;
	};
	const V = CARD_SKIN_VARIABLES;
	let out = "";
	// 档位色(SC 按价位、上舰按舰长等级)只有那两种卡的 props 才带;皮肤 CSS 用它按档变色。
	if (p.bgColor) out += `${V.tierColor.css}:${p.bgColor[0]};${V.tierColorEnd.css}:${p.bgColor[1]};`;
	// ⛔ **`--bn-card-bg-image` 不再注**(2026-09-19 补上 ADR-0014 决策 15 那条 2026-09-14 🔗
	// 的最后一步,原文:「旧皮肤里引用 `--bn-card-bg-image` 的那句**从此没人喂**」)。
	// 背景图 2026-09-14 退役成皮肤自己的 `image` 旋钮,值走 `--bn-knob-wallpaper`
	// (宿主经 `resolveKnobAssets` 读盘解析,见 `skin/knob-assets.ts`);全仓**零条 CSS**
	// 再读 `--bn-card-bg-image`,默认外框读的是 `var(--bn-knob-wallpaper, <渐变>)`。
	// 留着它只会骗人:2026-09-19 主人正是看见这个变量,才把「背景图旋钮不生效」错怪到
	// 改名头上(真因是面板预览那条路没调 `resolveKnobAssets`,已修)。
	// `p.backgroundImage` 那条入参链(模板 / ImageRenderer / engines)还在,拆它是另一件事
	// —— 与整卡模板退役(决策 24 的 2026-09-18 🔗)缠在一起。
	return out;
}

// ── 块 ────────────────────────────────────────────────────────────────────────

/**
 * 块表吃的 props:除动态卡外就是卡片 props 本身。
 *
 * 动态卡多一样 `renderForward` —— 转发框里是**另一张完整的卡**,按同一份皮肤再装一遍
 * (数据换成内层那条动态)。这条递归以前走的是模板那条一维竖栈,而且因为全仓已经没人往
 * props 里传 `layout`,实际是钉死在出厂默认版式上:换皮肤不跟,迁移过自己版式的也拿不回来。
 */
function blockPropsOf(ctx: AssembleCtx, props: unknown, raw: Dynamic | undefined): unknown {
	if (ctx.kind !== "dynamic") return props;
	const p = props as DynamicCardProps;
	return {
		node: p.node,
		renderForward: (node: DynamicNode): VNode =>
			h(
				"div",
				{ style: gridStyleOf(ctx.card) },
				// 内层的 `raw` 是外层那条动态的 `orig` —— 视频卡 / 图廊那两组契约字段从它取,
				// 不接上的话内层的 `{video.title}` / `hasPics` 会凭空变空。
				placeBlocks(ctx, { ...p, node }, raw?.orig),
			),
	};
}

/** 一个进了网格的块:块本身 + 它的内层 VNode(自定义块是一段 HTML)。 */
interface PlacedBlock {
	block: CardSkinBlock;
	inner: VNode | null;
	html?: string;
	isDivider: boolean;
	/** 块自己的根上已经有 `data-block` 了(今天只有 guard.badge),wrapper 就不再挂。 */
	selfLabelled: boolean;
}

/**
 * 块的 wrapper 样式:网格坐标(行号已压过)+ `min-width:0`(不写的话超宽内容会把这一列
 * 撑爆)+ 可选的层次。
 *
 * **层次不写就一个字节都不注**(0 也不注):存量皮肤一个 `z` 都没有,多一句 `z-index:0`
 * 就是 23 份字节基准与像素门一起红,而外观根本没变。而且「没声明」是个有用的档 ——
 * 块 CSS 里手写的 `z-index` 一直是放行的,不声明就等于把这件事交还给它。
 *
 * grid item 的 `z-index` **不需要 `position`** 就生效(与 flex item 同,CSS Grid 规范里
 * grid item 自成一个 painting 层级),所以这里只写一句就够。
 */
function gridStyle(kind: CardSkinKind, block: CardSkinBlock, row: number): string {
	const { column, span, rowSpan, z } = block.grid;
	const layer = z ? `;z-index:${z}` : "";
	// **「跨几行」对单张图的块是真高度**(2026-09-18 主人拍板)。行是隐式的、按内容撑,所以
	// 别的块写了 `rowSpan` 也只是给画布看的一句声明;标了 `heightFromRows` 的块(两张封面)
	// 才由这里注成真高度,图自己 `object-fit:cover` 填满。没写 `rowSpan` 就一个字节都不注 ——
	// 存量皮肤那条路原样有效。
	const sized =
		rowSpan !== undefined &&
		block.kind === "builtin" &&
		CARD_SKIN_BUILTIN_BLOCKS[kind][block.builtin]?.heightFromRows === true;
	const height = sized ? `;height:${(rowSpan ?? 1) * CARD_SKIN_LIMITS.rowHeight}px` : "";
	return `grid-row:${row} / span ${rowSpan ?? 1};grid-column:${column} / span ${span};min-width:0${height}${layer}`;
}

/**
 * 网格的列宽。皮肤不写 `columns` 就是 12 等分;写了就逐列拼 —— 等分列走
 * `minmax(0, nfr)`(与缺省那句同形:不加 `minmax(0, …)` 的话超宽内容会把列撑爆),
 * 定宽列原样写 px(上舰卡的徽章是 175px 的方图,等分列落不到这个数)。
 */
function templateColumns(card: CardSkinCard): string {
	if (!card.columns) return `repeat(${CARD_SKIN_LIMITS.columns}, minmax(0, 1fr))`;
	return card.columns.map((c) => ("px" in c ? `${c.px}px` : `minmax(0, ${c.fr}fr)`)).join(" ");
}

/**
 * 网格容器那一句。外层落在玻璃层上,内层(转发框里那张卡)落在自己的一层 div 上 ——
 * **同一个函数**吐给两处,两层的分栏才不会漂。
 */
function gridStyleOf(card: CardSkinCard): string {
	const gap = `${card.gap?.row ?? 0}px ${card.gap?.column ?? 0}px`;
	return `display:grid;grid-template-columns:${templateColumns(card)};width:100%;gap:${gap};`;
}

/**
 * 一个块的 wrapper。自定义块把清洗过的 HTML 经 `innerHTML` 铺进去;内置块把块的内层
 * VNode 原样放进来 —— 内层一个字节都不碰,皮肤只能从 wrapper 与 CSS 这两面改它。
 */
function wrapBlock(item: PlacedBlock, cls: string, style: string): VNode {
	const label = item.block.kind === "builtin" ? item.block.builtin : "custom";
	if (item.html !== undefined) {
		return <div data-block={label} class={cls} style={style} innerHTML={item.html} />;
	}
	// 块自带 `data-block` 时 wrapper 不重复挂:一个块在 DOM 里出现两个 `[data-block]`,
	// 按「一块一个」数序列的验收门当场对不上(今天只有 guard.badge 这一个)。
	if (item.selfLabelled) {
		return (
			<div class={cls} style={style}>
				{item.inner}
			</div>
		);
	}
	return (
		<div data-block={label} class={cls} style={style}>
			{item.inner}
		</div>
	);
}

/**
 * 一次装配从头到尾共用的东西。`used` 是**跨层**的:转发框里那张内层卡用的是同一批块、
 * 同一批 class,所以同一段 CSS 只写一次,而内层独有的块(外层被 `showIf` 筛掉的那些)
 * 也得记上 —— 漏了它的规则就只有内层没样式。
 */
interface AssembleCtx {
	kind: CardSkinKind;
	/** 这张卡的版式。**只有这一份** —— 出图端没有形态,每一层拿的都是它。 */
	card: CardSkinCard;
	resolveAsset?: (name: string) => string | undefined;
	/** 真画出来过的块 id(内外两层合起来)。 */
	used: Set<string>;
}

/**
 * 按皮肤把一张卡的块铺成网格的孩子(**不含外框**)。外层由 `renderSkinnedCard` 套外框,
 * 内层由转发框里那一层 div 套。
 *
 * 顺序是刻意的:先按 `showIf` 与「块自己有没有数据」筛,再**按行号排**定视觉先后,然后
 * 按 `renderBlocks` 那三条规矩收分割线,最后才压行号 —— 反过来的话,被收起的块会在网格
 * 里留一行空白,而 `gap` 会把那行空白撑成看得见的缝。
 */
function placeBlocks(ctx: AssembleCtx, props: unknown, raw: Dynamic | undefined): VNode[] {
	const { kind, card } = ctx;
	// 契约数据每层各算一份:`showIf` 与这一层所有自定义块的占位符共用它。(重载签名按 kind
	// 分支,这里 kind 是运行时值,按同一份实现的宽签名调。)
	const data = (buildCardData as (k: CardSkinKind, p: unknown, raw?: Dynamic) => CardData)(
		kind,
		props,
		raw,
	);
	const table = BLOCK_TABLES[kind] as Record<string, BlockRenderer<unknown>>;
	const blockProps = blockPropsOf(ctx, props, raw);

	// ① 筛:showIf 为假、内置块没数据(返回 null)的整块不画。
	const kept: PlacedBlock[] = [];
	for (const block of card.blocks) {
		if (block.showIf && !readCardField(data, block.showIf)) continue;
		if (block.kind === "custom") {
			kept.push({
				block,
				inner: null,
				html: renderCustomHtml(block.html, kind, data, ctx.resolveAsset),
				isDivider: false,
				selfLabelled: false,
			});
			continue;
		}
		const inner = table[block.builtin]?.(blockProps);
		if (inner == null) continue;
		kept.push({
			block,
			inner,
			isDivider: block.builtin === DIVIDER_TYPE,
			selfLabelled: Boolean((inner.props as Record<string, unknown> | null)?.["data-block"]),
		});
	}

	// ② 排出一份**视觉顺序**的视图:`grid.row` 才是「第几行」,数组先后只管同一行内的
	// 左右。下面两步问的都是「画出来谁在谁上面」,得照这份视图走 —— 照数组走的话,编辑器
	// 里把块拖到别的行,出图会一动不动(④ 按「出现顺序」重编行号,正好把换行抵消掉)。
	// `sort` 稳定,同一行仍按数组先后。
	const inOrder = [...kept].sort((a, b) => a.block.grid.row - b.block.grid.row);

	// ③ 收分割线:开头抑制、前一块不是内容块就抑制、末尾弹出(与 `renderBlocks` 同一套)。
	// 「前一块」「末尾」都按 ② 那份视觉顺序问。
	const dropped = new Set<PlacedBlock>();
	let lastWasContent = false;
	let trailing: PlacedBlock | null = null;
	for (const item of inOrder) {
		if (item.isDivider) {
			if (!lastWasContent) {
				dropped.add(item);
				continue;
			}
			lastWasContent = false;
			trailing = item;
		} else {
			lastWasContent = true;
			trailing = null;
		}
	}
	if (trailing) dropped.add(trailing);

	// 出 DOM 的序**照旧是数组先后**:位置整个由 `grid-row` / `grid-column` 定,DOM 先后只
	// 决定叠放的缺省档,而那一档的约定就是「跟数组先后走」(见 schema 里 `z` 那段);验收门
	// A 也照这个序跟模板逐块比。
	const placed = kept.filter((item) => !dropped.has(item));

	// ④ 压行:把剩下的块占到的行重编成 1..n,免得被收起的块留下吃 gap 的空行。算法住
	// `@bilibili-notify/internal`,画布与这里共用同一份(见 `rowMapOf` 的注释)。
	const rowMap = rowMapOf(placed.map((item) => item.block.grid));

	// ⑤ 铺 wrapper。CSS 不在这儿拼:内外两层会走到这里两遍,拼在这儿就会按「谁先画完」
	// 排序,而且同一条规则出现两次。统一在 `renderSkinnedCard` 里按 `card.blocks` 的顺序拼。
	return placed.map((item) => {
		const id = item.block.id;
		const cls = blockClass(id);
		ctx.used.add(id);
		const vars = assetVarsStyle(item.block.assets, ctx.resolveAsset);
		const grid = gridStyle(kind, item.block, rowMap.get(item.block.grid.row) ?? 1);
		const style = vars ? `${grid};${vars}` : grid;
		return wrapBlock(item, cls, style);
	});
}

/** 按皮肤装配一张卡:块铺成网格,外面套这张卡的外框。 */
export function renderSkinnedCard<K extends CardSkinKind>(
	o: SkinRenderOptions<K>,
): SkinRenderResult {
	const { kind, card } = o;
	const ctx: AssembleCtx = {
		kind,
		card,
		resolveAsset: o.resolveAsset,
		used: new Set(),
	};
	const children = placeBlocks(ctx, o.props, o.raw);

	// 翻译 CSS。按 `card.blocks` 的顺序走而不是按画出来的顺序 —— 内层先画完也不会把
	// 它的规则插到前面去;真没画出来过的块照旧不留 CSS。
	const parts: string[] = [];
	const faces = fontFaces(o.fonts, o.resolveAsset) + (o.knobAssets?.fontFaces ?? "");
	if (faces) parts.push(faces);
	if (card.css) parts.push(translateRootCss(card.css));
	for (const block of card.blocks) {
		if (block.css && ctx.used.has(block.id)) {
			parts.push(translateBlockCss(block.css, blockClass(block.id)));
		}
	}

	const extra: FrameExtra = {
		frame:
			frameVariables(o.props) +
			cardSkinKnobDeclarations(o.knobs, o.knobValues) +
			// 宿主解析出来的那两档排在后面:同一个 key 时以读盘拿到的为准(纯字面量那条
			// 路径对它们一律回 null,本来也注不出东西来)。
			(o.knobAssets?.vars ?? "") +
			assetVarsStyle(card.assets, o.resolveAsset),
		glass: gridStyleOf(card),
		width: card.width,
	};
	const frame = FRAMES[kind] as (
		p: CardPropsByKind[K],
		children: VNode | VNode[],
		extra?: FrameExtra,
	) => VNode;
	return { vnode: frame(o.props, children, extra), css: parts.join("\n") };
}

// ── 一整张卡的 HTML ──────────────────────────────────────────────────────────

/** 这份清单里该卡种的条目;没有就回落出厂默认皮肤的同一种卡。 */
export function cardOfManifest(manifest: CardSkinManifest, kind: CardSkinKind): CardSkinCard {
	// biome-ignore lint/style/noNonNullAssertion: 出厂默认皮肤七种卡齐全,是最后一道回落
	return manifest.cards[kind] ?? DEFAULT_CARD_SKIN.cards[kind]!;
}

export interface SkinCardHtmlOptions {
	/** `<title>`(截图不显示,排障时看得见)。 */
	title?: string;
	/** CSS 家族名;自带字体时传 `USER_FONT_FAMILY`。 */
	font?: string;
	/** 一整条 `@font-face`(宿主解析出来的)。 */
	fontFace?: string;
	/** 仅 dynamic 卡:原始动态,视频 / 图廊那两组契约字段从它取。 */
	raw?: Dynamic;
	/** 包内资产名 → data URL。**同步**:调用方须先把该皮肤用到的资产预取成表。 */
	resolveAsset?: (name: string) => string | undefined;
	/** 用户为**这套**皮肤拧过的旋钮值(宿主按皮肤 id 取好再传)。 */
	knobValues?: CardSkinKnobOverrides;
	/** 字体 / 图两档旋钮的解析结果(见 {@link resolveKnobAssets})。 */
	knobAssets?: ResolvedKnobAssets;
}

/**
 * 一份皮肤 + 一张卡的 props → **完整 HTML**。
 *
 * 出图(`ImageRenderer`)与预览路由(`routes/cards.ts` 那条绕开渲染器的 SSR 路)共用
 * 这一处 —— 两边各拼一份的话,必然出现「预览是这套皮肤、推出去是另一副样子」,而两边
 * 都说不出哪儿错了(字体那条链就这么漏过一次)。
 *
 * 卡宽取皮肤定的 `card.width`,不再是写死的 600 / 430 / 290 / 720。
 */
export async function renderCardWithSkin<K extends CardSkinKind>(
	kind: K,
	props: CardPropsByKind[K],
	manifest: CardSkinManifest,
	options: SkinCardHtmlOptions = {},
): Promise<string> {
	const card = cardOfManifest(manifest, kind);
	const { vnode, css } = renderSkinnedCard({
		kind,
		card,
		props,
		raw: options.raw,
		resolveAsset: options.resolveAsset,
		fonts: manifest.fonts,
		knobs: manifest.knobs,
		knobValues: options.knobValues,
		knobAssets: options.knobAssets,
	});
	// **出血**:卡外那圈只为辉光存在的余量(ADR-0014 决策 19 的 🔗)。
	//
	// 做成外框**外面**一层壳,而不是给 `html` 加内边距 —— 外壳里有
	// `* { box-sizing: border-box }`,`html` 一旦既定宽又带 padding,那 padding 是
	// **从里面吃掉**的,卡当场被挤窄(600 → 544)。所以 `htmlWidth` 也要把两边的量加回去。
	//
	// 壳的样式走 inline 而不是进 `extraCss`:这两个数是渲染器按清单算出来的,不经皮肤 CSS
	// 那道清洗门,inline 就不必在门上再开一个「只有我们自己能用」的选择器。
	// 顺带,预览路由与出图共用这个函数,壳做在 HTML 里,编辑器里看到的辉光与推出去的那张
	// 自动对齐 —— 这正是这条特性要解决的那件事。
	const bleed = card.bleed && card.bleed.size > 0 ? card.bleed : undefined;
	const framed = bleed
		? h(
				"div",
				{
					"data-bn": "bleed",
					style: `padding:${bleed.size}px;background:${bleed.color}`,
				},
				[vnode],
			)
		: vnode;

	return await renderCard(
		{ render: (): VNode => framed },
		{},
		{
			title: options.title,
			font: options.font,
			fontFace: options.fontFace,
			htmlWidth: card.width + (bleed ? bleed.size * 2 : 0),
			extraCss: css,
		},
	);
}

// ── 包内资产的引用面 ─────────────────────────────────────────────────────────

/** 自定义块里 `src="asset:<名>"` 的那一种引用。 */
const ASSET_REF_RE = /src="asset:([^"]*)"/g;

/**
 * 这张卡会用到哪些**包内资产**(名字,即 `asset:` 后面那截)。
 *
 * 渲染器的 `resolveAsset` 是**同步**的(替换发生在字符串替换的回调里),而宿主读盘是
 * 异步的 —— 所以调用方得先按这份名单把资产预取成表,再给一个同步的查表函数。
 */
export function skinAssetRefs(card: CardSkinCard, fonts?: readonly CardSkinFont[]): string[] {
	const names = new Set<string>();
	const addVars = (vars: CardSkinAssetVars | undefined): void => {
		for (const ref of Object.values(vars ?? {})) names.add(ref.slice(ASSET_PREFIX.length));
	};
	addVars(card.assets);
	for (const block of card.blocks) {
		addVars(block.assets);
		if (block.kind !== "custom") continue;
		for (const m of block.html.matchAll(ASSET_REF_RE)) names.add(m[1]);
	}
	for (const f of fonts ?? []) names.add(f.asset.slice(ASSET_PREFIX.length));
	return [...names];
}
