import { z } from "zod";

/**
 * 卡片版式描述符的 schema 版本。结构演进(新增 / 重命名块)时递增,配合
 * `normalizeCardLayout` 做向前兼容迁移。
 */
export const CARD_LAYOUT_VERSION = 1;

/**
 * 单个卡片块。`id` 是预定义块标识(渲染器据此找对应片段),`visible` 控制显隐,
 * **顺序由数组位置决定**——拖拽排序即重排数组。用户拖不出我们没预埋的块。
 */
export const CardBlockSchema = z.object({
	id: z.string(),
	visible: z.boolean(),
});
export type CardBlock = z.infer<typeof CardBlockSchema>;

/**
 * 上舰卡受限 2D 版式:`badgeSide` 决定徽章(舰长大图 / 头像)整体靠左还是靠右,
 * `blocks`(姓名 / 文字)在另一侧上下排,顺序由数组位置决定。上舰卡是唯一不走
 * 纯垂直栈的卡,故单列一套结构。
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

const allVisible = (...ids: string[]): CardBlock[] => ids.map((id) => ({ id, visible: true }));

/**
 * 把一份(可能陈旧的)块数组对齐到当前已知块集:保留已知块的顺序与显隐,丢弃未知
 * 块,缺失的已知块按 `defaults` 的顺序追加到末尾(沿用其默认显隐)。
 */
function reconcileBlocks(stored: CardBlock[], defaults: CardBlock[]): CardBlock[] {
	const knownIds = new Set(defaults.map((b) => b.id));
	const kept = stored.filter((b) => knownIds.has(b.id));
	const keptIds = new Set(kept.map((b) => b.id));
	const appended = defaults.filter((b) => !keptIds.has(b.id));
	return [...kept, ...appended];
}

/**
 * 向前兼容迁移:把持久化的版式描述符对齐到当前内置块集。未知块丢弃、新块追加
 * (默认显示)、已知块保留用户的顺序与显隐。version 归一到 `CARD_LAYOUT_VERSION`。
 */
export function normalizeCardLayout(stored: CardLayout, defaults: CardLayout): CardLayout {
	return {
		version: CARD_LAYOUT_VERSION,
		live: reconcileBlocks(stored.live, defaults.live),
		dynamic: reconcileBlocks(stored.dynamic, defaults.dynamic),
		sc: reconcileBlocks(stored.sc, defaults.sc),
		guard: {
			badgeSide: stored.guard?.badgeSide ?? defaults.guard.badgeSide,
			blocks: reconcileBlocks(stored.guard?.blocks ?? [], defaults.guard.blocks),
		},
	};
}

/**
 * 默认版式,**1:1 复刻当前各卡的块顺序、全部可见**——老用户升级后卡片观感不变
 * (guard 除外,它按受限 2D 重画,见设计稿)。
 */
export const DEFAULT_CARD_LAYOUT: CardLayout = {
	version: CARD_LAYOUT_VERSION,
	live: allVisible("cover", "header", "title", "stats", "follower", "desc"),
	dynamic: allVisible("header", "topic", "content", "stats"),
	sc: allVisible("amount", "divider", "sender", "message"),
	guard: {
		badgeSide: "right",
		blocks: allVisible("name", "text"),
	},
};
