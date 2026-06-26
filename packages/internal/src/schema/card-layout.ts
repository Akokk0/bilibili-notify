import { z } from "zod";

/**
 * 卡片版式描述符的 schema 版本。v2:块从 `{id,visible}` 升级为带 `type` + 可选上下
 * 边距,并支持可插入/删除的分割线块(type=divider)。v4:动态卡新增 `additional`
 * 内容块(附加内容:预约 / 商品 / 通用卡,从正文里拆出可单独排版)。结构演进时递增,
 * 配合 `normalizeCardLayout` 做向前兼容迁移(按 type 对齐已知内容块、补齐缺失块)。
 */
export const CARD_LAYOUT_VERSION = 4;

/** 分割线块的 type。可在版式里任意位置插入多条、可删除。 */
export const DIVIDER_TYPE = "divider";

/**
 * 单个卡片块。`type` 是语义(内容块为其语义名 / 分割线为 "divider"),渲染器据此
 * 找片段;`id` 是实例唯一标识(内容块 id===type 各一份;分割线可多份,各有唯一 id)。
 * `visible` 控显隐,顺序由数组位置决定。`marginTop/marginBottom` 为该块上下额外
 * 边距(px,可选;缺省走模版内置间距)。
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
	z.object({
		id: z.string(),
		type: z.string(),
		visible: z.boolean(),
		marginTop: z.number().int().optional(),
		marginBottom: z.number().int().optional(),
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
 * 内容块:id===type,默认显示。`mt/mb` 是该块上 / 下间距(px),把原本写死在模版里的
 * pt/pb 迁到这里作默认值 —— UI 直接展示、渲染直接用(0 留空,走 UI 的 `?? 0` 显示)。
 */
const c = (type: string, mt = 0, mb = 0): CardBlock => ({
	id: type,
	type,
	visible: true,
	...(mt ? { marginTop: mt } : {}),
	...(mb ? { marginBottom: mb } : {}),
});
/** 分割线实例:唯一 id,默认显示(竖向间距由模版的 divider builder 内置出)。 */
const div = (n: number): CardBlock => ({ id: `divider-${n}`, type: DIVIDER_TYPE, visible: true });

/**
 * 默认版式,**1:1 复刻当前各卡的块顺序、间距与分割线、全部可见**(guard 除外,按受限
 * 2D 重画)。各内容块的上下间距(px)显式列出,作为 UI 默认值与渲染依据。
 */
export const DEFAULT_CARD_LAYOUT: CardLayout = {
	version: CARD_LAYOUT_VERSION,
	live: [
		c("cover", 14, 0),
		c("header", 14, 10),
		c("title", 0, 10),
		div(1),
		c("stats", 10, 0),
		c("follower", 6, 10),
		c("desc", 6, 10),
	],
	dynamic: [
		c("header", 14, 12),
		div(1),
		c("topic", 12, 0),
		c("content", 12, 12),
		c("additional", 0, 12),
		div(2),
		c("stats", 12, 12),
	],
	sc: [c("amount", 0, 15), div(1), c("sender", 0, 12), c("message")],
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
		// v<3 迁移:间距从内置 pt/pb 迁进 layout 之前存的内容块没有间距值,渲染会挤
		// 在一起;从默认回填该 type 的上下间距。当前版本不回填(尊重用户显式置 0)。
		if (migrateSpacing && b.marginTop === undefined && b.marginBottom === undefined) {
			const def = defaults.find((d) => d.type === b.type);
			if (def && (def.marginTop !== undefined || def.marginBottom !== undefined)) {
				kept.push({ ...b, marginTop: def.marginTop, marginBottom: def.marginBottom });
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
	// 间距迁移仅对「间距搬进 layout」之前(v<3)的存档生效,回填默认上下间距。
	const migrateSpacing = (stored.version ?? 1) < 3;
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
