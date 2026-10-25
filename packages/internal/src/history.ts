/**
 * 推送历史状态与保留期 —— 历史行的状态词表、聚合谓词和图片保留档位。
 *
 * 零依赖:只许 `import type`,值级 import 只能指向零依赖名单里的同伴。
 * 面板与 contract 经 `@bilibili-notify/internal/history` 取值。
 */

/**
 * 一行历史的状态(六态,释义见 `schema/history.ts` 的 `PushStatusSchema`)。词表在这儿(schema 用它
 * enum),两个谓词也在这儿 —— 服务端的按日聚合与面板上的乐观补丁吃的是同一份口径,各写一遍的话,
 * 再加一态时只会改一边:KPI 两头对不上,而门禁一点都不红。
 */
export const PUSH_STATUSES = [
	"delivered",
	"partial",
	"failed",
	"no-targets",
	"silenced",
	"filtered",
] as const;

/**
 * 算不算「推到了某个地方」—— 进不进「今日推送」与趋势图。无目标行没推到任何地方;被静音 / 免扰
 * 挡下的行一条都没发,也不算(补发成功后它变成 `delivered`,那时才算);被过滤的作品压根不是推送,
 * 只是留痕,永远不算。
 */
export function countsAsDelivery(status: (typeof PUSH_STATUSES)[number]): boolean {
	return status !== "no-targets" && status !== "silenced" && status !== "filtered";
}

/**
 * 算不算「今日失败」。部分失败(本体到了、附加没到)也算 —— 有件事该看一眼。被挡下的、被过滤的
 * 都不是失败。
 */
export function countsAsFailure(status: (typeof PUSH_STATUSES)[number]): boolean {
	return status === "failed" || status === "partial";
}

/**
 * 图片与重推原件保留天数只许这七档(ADR-0022 决策 9 下 10-04 的 🔗),从长到短。设置的 schema 与面板的段选读同一份。
 * 推送记录的文字不在其内:文字不设上限。
 */
export const HISTORY_RETENTION_DAY_OPTIONS = [90, 60, 30, 15, 7, 3, 1] as const;
export type HistoryRetentionDays = (typeof HISTORY_RETENTION_DAY_OPTIONS)[number];
/** 与 0.x 的默认一致。 */
export const DEFAULT_HISTORY_RETENTION_DAYS: HistoryRetentionDays = 30;
