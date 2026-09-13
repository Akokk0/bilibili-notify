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

import {
	CARD_SKIN_FIELDS,
	CARD_SKIN_LIMITS,
	CARD_SKIN_SELF_HOOK,
	CARD_SKIN_VARIABLES,
	type CardSkinBlock,
	type CardSkinCard,
	type CardSkinKind,
	DEFAULT_CARD_LAYOUT,
	DIVIDER_TYPE,
} from "@bilibili-notify/internal";
import type { VNode } from "vue";
import { DYNAMIC_BLOCKS } from "../blocks/dynamic";
import { type CardPropsByKind, FRAMES, type FrameExtra } from "../blocks/frames";
import { GUARD_BLOCKS } from "../blocks/guard";
import { LIVE_BLOCKS } from "../blocks/live";
import { ROAST_BOARD_BLOCKS, ROAST_SOLO_BLOCKS } from "../blocks/roast";
import { SC_BLOCKS } from "../blocks/sc";
import type { BlockRenderer } from "../blocks/types";
import { WORDCLOUD_BLOCKS } from "../blocks/wordcloud";
import type { DynamicCardProps } from "../templates/dynamic-card";
import type { Dynamic } from "../types";
import { buildCardData, type CardData, readCardField } from "./card-data";

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

/** 玻璃层白纱的各卡基线(与 `blocks/frames.tsx` 同一组数字,变量注入时要用)。 */
const GLASS_OPACITY_BASE: Record<CardSkinKind, number> = {
	live: 0.82,
	dynamic: 0.82,
	sc: 0.75,
	guard: 0.75,
	roastBoard: 0.86,
	roastSolo: 0.86,
	wordcloud: 0.82,
};

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

/** 块级 CSS:`self` → 该块的 class;其余挂点 → 该块内带这个挂点的元素。 */
function translateBlockCss(css: string, cls: string): string {
	return css.replace(HOOK_SELECTOR_RE, (_m, hook: string) =>
		hook === CARD_SKIN_SELF_HOOK ? `.${cls}` : `.${cls} [data-bn~="${hook}"]`,
	);
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
 * 值从**同一份 props** 算,所以 `var(--bn-card-glass-opacity)` 与外框自己画的白纱恒等。
 * 字体不在 props 里(它经 `renderCard` 的 `font` 进来),所以不写 `--bn-card-font`。
 */
function frameVariables(kind: CardSkinKind, props: unknown): string {
	const p = props as {
		cardColorStart?: string;
		cardColorEnd?: string;
		colorStart?: string;
		colorEnd?: string;
		bgColor?: readonly [string, string];
		glassOpacity?: number;
		glassClear?: boolean;
	};
	const start = p.cardColorStart ?? p.colorStart ?? p.bgColor?.[0] ?? "";
	const end = p.cardColorEnd ?? p.colorEnd ?? p.bgColor?.[1] ?? "";
	const opacity = p.glassClear ? 0 : (p.glassOpacity ?? GLASS_OPACITY_BASE[kind]);
	const blur = p.glassClear ? 0 : 10;
	const V = CARD_SKIN_VARIABLES;
	return (
		`${V.colorStart.css}:${start};${V.colorEnd.css}:${end};` +
		`${V.glassOpacity.css}:${opacity};${V.glassBlur.css}:${blur}px;`
	);
}

// ── 块 ────────────────────────────────────────────────────────────────────────

/** 块表吃的 props:除动态卡外就是卡片 props 本身。 */
function blockPropsOf(o: SkinRenderOptions): unknown {
	if (o.kind !== "dynamic") return o.props;
	const p = o.props as DynamicCardProps;
	// 转发 inset 里的内部动态仍按**旧版式**递归装配(`DYNAMIC_BLOCKS.content` 的那条递归)。
	// 内部动态跟着皮肤走是编辑器那一步的事;今天先保持与模板同一份 layout,出图逐字节不变。
	return { node: p.node, layout: p.layout ?? DEFAULT_CARD_LAYOUT.dynamic };
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

/** 块的 wrapper 样式:网格坐标(行号已压过)+ `min-width:0`(不写的话超宽内容会把这一列撑爆)。 */
function gridStyle(block: CardSkinBlock, row: number): string {
	const { column, span, rowSpan } = block.grid;
	return `grid-row:${row} / span ${rowSpan ?? 1};grid-column:${column} / span ${span};min-width:0`;
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
 * 按皮肤装配一张卡。
 *
 * 顺序是刻意的:先按 `showIf` 与「块自己有没有数据」筛,再按 `renderBlocks` 那三条规矩
 * 收分割线,最后才压行号 —— 反过来的话,被收起的块会在网格里留一行空白,而 `gap` 会把
 * 那行空白撑成看得见的缝。
 */
export function renderSkinnedCard<K extends CardSkinKind>(
	o: SkinRenderOptions<K>,
): SkinRenderResult {
	const { kind, card } = o;
	// 契约数据只算一次:`showIf` 与所有自定义块的占位符共用它。(重载签名按 kind 分支,
	// 这里 kind 是运行时值,按同一份实现的宽签名调。)
	const data = (buildCardData as (k: CardSkinKind, p: unknown, raw?: Dynamic) => CardData)(
		kind,
		o.props,
		o.raw,
	);
	const table = BLOCK_TABLES[kind] as Record<string, BlockRenderer<unknown>>;
	const props = blockPropsOf(o as SkinRenderOptions);

	// ① 筛:showIf 为假、内置块没数据(返回 null)的整块不画。
	const kept: PlacedBlock[] = [];
	for (const block of card.blocks) {
		if (block.showIf && !readCardField(data, block.showIf)) continue;
		if (block.kind === "custom") {
			kept.push({
				block,
				inner: null,
				html: renderCustomHtml(block.html, kind, data, o.resolveAsset),
				isDivider: false,
				selfLabelled: false,
			});
			continue;
		}
		const inner = table[block.builtin]?.(props);
		if (inner == null) continue;
		kept.push({
			block,
			inner,
			isDivider: block.builtin === DIVIDER_TYPE,
			selfLabelled: Boolean((inner.props as Record<string, unknown> | null)?.["data-block"]),
		});
	}

	// ② 收分割线:开头抑制、前一块不是内容块就抑制、末尾弹出(与 `renderBlocks` 同一套)。
	const placed: PlacedBlock[] = [];
	let lastWasContent = false;
	for (const item of kept) {
		if (item.isDivider) {
			if (!lastWasContent) continue;
			lastWasContent = false;
		} else {
			lastWasContent = true;
		}
		placed.push(item);
	}
	if (placed.length > 0 && placed[placed.length - 1].isDivider) placed.pop();

	// ③ 压行:剩下的块按出现顺序把 row 重编成 1..n,免得被收起的块留下吃 gap 的空行。
	const rowMap = new Map<number, number>();
	for (const { block } of placed) {
		if (!rowMap.has(block.grid.row)) rowMap.set(block.grid.row, rowMap.size + 1);
	}

	// ④ 铺 wrapper + 翻译 CSS。
	const parts: string[] = [];
	if (card.css) parts.push(translateRootCss(card.css));
	const children = placed.map((item) => {
		const cls = blockClass(item.block.id);
		if (item.block.css) parts.push(translateBlockCss(item.block.css, cls));
		return wrapBlock(item, cls, gridStyle(item.block, rowMap.get(item.block.grid.row) ?? 1));
	});

	const gap = `${card.gap?.row ?? 0}px ${card.gap?.column ?? 0}px`;
	const extra: FrameExtra = {
		frame: frameVariables(kind, o.props),
		glass:
			`display:grid;grid-template-columns:repeat(${CARD_SKIN_LIMITS.columns}, minmax(0, 1fr));` +
			`width:100%;gap:${gap};`,
		width: card.width,
	};
	const frame = FRAMES[kind] as (
		p: CardPropsByKind[K],
		children: VNode | VNode[],
		extra?: FrameExtra,
	) => VNode;
	return { vnode: frame(o.props, children, extra), css: parts.join("\n") };
}
