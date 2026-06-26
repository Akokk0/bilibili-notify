import { z } from "zod";

/**
 * 卡片版式描述符的 schema 版本。v2:块从 `{id,visible}` 升级为带 `type` + 可选上下
 * 边距,并支持可插入/删除的分割线块(type=divider)。v4:动态卡新增 `additional`
 * 内容块(附加内容:预约 / 商品 / 通用卡,从正文里拆出可单独排版)。v5:动态卡移除独立
 * `topic` 块(话题标签无单独排版价值,内联进正文块顶部)。v6:边距收敛为单一 `marginTop`
 * (= 该块上方的间距);卡片框架统一提供固定的首块上 / 末块下边距,用户只需调块间间距。
 * 旧存档的 topic 块由 reconcile 当未知块丢弃。结构演进时递增,配合 `normalizeCardLayout`。
 */
export const CARD_LAYOUT_VERSION = 6;

/** 分割线块的 type。可在版式里任意位置插入多条、可删除。 */
export const DIVIDER_TYPE = "divider";

/**
 * 单个卡片块。`type` 是语义(内容块为其语义名 / 分割线为 "divider"),渲染器据此
 * 找片段;`id` 是实例唯一标识(内容块 id===type 各一份;分割线可多份,各有唯一 id)。
 * `visible` 控显隐,顺序由数组位置决定。`marginTop` 为该块**上方**的额外间距(px,可选;
 * 缺省走模版内置间距)。首块的上 / 末块的下边距由卡片框架固定,不经此字段。
 */
export const CardBlockSchema = z.preprocess(
	// v1→v2 迁移:老块 `{id,visible}` 缺 type,从 id 回填(v1 全是内容块、id===语义),
	// 避免老 globals.json 在 v2 schema 下 parse 失败让独立端启动挂。
	(b) => {
		if (b && typeof b === "object" && !("type" in b) && "id" in b) {
			return { ...(b as Record<string, unknown>), type: (b as { id: unknown }).id };
		}
		return b;
	},
	// v6 起只有 marginTop;老存档的 marginBottom 由 z.object 默认剥除(不报错)。
	z.object({
		id: z.string(),
		type: z.string(),
		visible: z.boolean(),
		marginTop: z.number().int().optional(),
	}),
);
export type CardBlock = z.infer<typeof CardBlockSchema>;

/**
 * 上舰卡受限 2D 版式:`badgeSide` 决定徽章(舰长大图)整体靠左还是靠右,
 * `blocks`(姓名 / 文字 / 可插分割线)在另一侧上下排,顺序由数组位置决定。
 */
export const GuardLayoutSchema = z.object({
	badgeSide: z.enum(["left", "right"]),
	blocks: z.array(CardBlockSchema),
});
export type GuardLayout = z.infer<typeof GuardLayoutSchema>;

/**
 * 四种卡片(词云不做)的版式描述符。live 三态(开播 / 直播中 / 下播)共用一套,
 * 某态无数据的块由渲染器按现有逻辑自动收起。dynamic / sc 是垂直栈,guard 受限 2D。
 */
export const CardLayoutSchema = z.object({
	version: z.number().int().default(CARD_LAYOUT_VERSION),
	live: z.array(CardBlockSchema),
	dynamic: z.array(CardBlockSchema),
	sc: z.array(CardBlockSchema),
	guard: GuardLayoutSchema,
});
export type CardLayout = z.infer<typeof CardLayoutSchema>;

/**
 * 内容块:id===type,默认显示。`mt` 是该块**上方**间距(px),作为 UI 默认值与渲染依据
 * (0 留空,UI 走 `?? 0` 显示)。首块的 mt 在渲染时被框架固定值覆盖,仅作占位。
 */
const c = (type: string, mt = 0): CardBlock => ({
	id: type,
	type,
	visible: true,
	...(mt ? { marginTop: mt } : {}),
});
/** 分割线实例:唯一 id,默认显示。`mt` 为分割线上方间距(下方间距由后续块的 mt 出)。 */
const div = (n: number, mt = 0): CardBlock => ({
	id: `divider-${n}`,
	type: DIVIDER_TYPE,
	visible: true,
	...(mt ? { marginTop: mt } : {}),
});

/**
 * 默认版式,复刻当前各卡的块顺序、分割线与全部可见(guard 按受限 2D 重画)。每块的
 * **上方**间距(px)显式列出 —— 块间间距 = 下方块的 mt;首块上 / 末块下边距由卡片框架
 * 固定(容器内边距),不在此列出。作为 UI 默认值与渲染依据。
 */
export const DEFAULT_CARD_LAYOUT: CardLayout = {
	version: CARD_LAYOUT_VERSION,
	live: [
		c("cover"),
		c("header", 14),
		c("title", 10),
		div(1, 10),
		c("stats", 10),
		c("follower", 6),
		c("desc", 16),
	],
	dynamic: [
		c("header"),
		div(1, 12),
		c("content", 12),
		c("additional", 12),
		div(2, 12),
		c("stats", 12),
	],
	sc: [c("amount"), div(1, 15), c("sender", 12), c("message", 12)],
	guard: {
		badgeSide: "right",
		blocks: [c("name"), c("text")],
	},
};

/**
 * 把一份(可能陈旧的)块数组对齐到当前已知内容块集(按 `type`):保留已知内容块与
 * **全部分割线**的顺序、显隐、边距;丢弃未知内容块与重复内容块;缺失的已知内容块
 * 按 `defaults` 顺序追加到末尾。分割线由用户自由增删,不参与「补齐」。
 */
function reconcileBlocks(
	stored: CardBlock[],
	defaults: CardBlock[],
	migrateSpacing: boolean,
): CardBlock[] {
	const knownContentTypes = new Set(
		defaults.filter((b) => b.type !== DIVIDER_TYPE).map((b) => b.type),
	);
	const seen = new Set<string>();
	const kept: CardBlock[] = [];
	for (const b of stored) {
		if (b.type === DIVIDER_TYPE) {
			kept.push(b);
			continue;
		}
		if (!knownContentTypes.has(b.type) || seen.has(b.type)) continue;
		seen.add(b.type);
		// 单上边距模型(v6)之前的存档:边距语义变了(原上+下 → 仅上方间距),没有 marginTop
		// 的块从默认回填该 type 的上方间距,避免迁移后挤在一起。当前版本不回填(尊重显式 0)。
		if (migrateSpacing && b.marginTop === undefined) {
			const def = defaults.find((d) => d.type === b.type);
			if (def?.marginTop !== undefined) {
				kept.push({ ...b, marginTop: def.marginTop });
				continue;
			}
		}
		kept.push(b);
	}
	const appended = defaults.filter((b) => b.type !== DIVIDER_TYPE && !seen.has(b.type));
	return [...kept, ...appended];
}

/**
 * 向前兼容迁移:把持久化的版式描述符对齐到当前内置块集。未知内容块丢弃、缺失的
 * 内置内容块追加(默认显示)、已知内容块与分割线保留用户的顺序 / 显隐 / 边距。
 * version 归一到 `CARD_LAYOUT_VERSION`。
 */
export function normalizeCardLayout(stored: CardLayout, defaults: CardLayout): CardLayout {
	// 间距迁移对单上边距模型(v6)之前的存档生效:回填缺失的上方间距。
	const migrateSpacing = (stored.version ?? 1) < 6;
	return {
		version: CARD_LAYOUT_VERSION,
		live: reconcileBlocks(stored.live, defaults.live, migrateSpacing),
		dynamic: reconcileBlocks(stored.dynamic, defaults.dynamic, migrateSpacing),
		sc: reconcileBlocks(stored.sc, defaults.sc, migrateSpacing),
		guard: {
			badgeSide: stored.guard?.badgeSide ?? defaults.guard.badgeSide,
			blocks: reconcileBlocks(stored.guard?.blocks ?? [], defaults.guard.blocks, migrateSpacing),
		},
	};
}
