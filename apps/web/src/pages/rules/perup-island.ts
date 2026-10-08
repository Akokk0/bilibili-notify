/**
 * per-UP 灵动岛草稿投影 —— 把 Subscription 的 `overrides` + `specialUsers`
 * 映射成「扁平 code 结构」,使 walkTreeDiff 产出的 dot-path 与 FIELD_LABELS 的
 * code 对齐(section 分组 / 值格式化 / `[data-code]` 跳转锚点全部命中)。
 *
 * 对齐规则与全局灵动岛(Rules.tsx 的 islandDraft/islandBaseline)一致:
 * - **code 无前缀的 slice 打平**(filters):字段直接作为顶层 key(blockKeywords …)。
 * - cardStyle / cardSkin 不在此投影 —— 卡片覆盖已迁到 /cards 页,由 Cards 的
 *   灵动岛(pageKey "cards")独立跟踪。
 * - **code 带前缀的 slice 保 nested**(imageGroup / schedule / liveStart / liveStreaming / superchat / membership / templates / ai):
 *   整段挂在对应 key 下,walkTreeDiff 递归出 `schedule.X` / `liveStart.X` / `liveStreaming.X` / `superchat.minAmount` /
 *   `membership.minRank.guard` / `templates.X` / `ai.X`。
 * - `specialUsers` 作为整数组叶子(walkTreeDiff 把数组当叶子整体比较)。
 *
 * `overrides.features` 不在此页编辑(由 UP 对话框管理),刻意排除。
 */

import type { OverridesShape, SpecialUser } from "../../types/domain";

export function projectPerUpIsland(
	overrides: OverridesShape,
	specialUsers: SpecialUser[],
): Record<string, unknown> {
	return {
		...overrides.filters,
		// 没有图集覆盖时给一个空对象而不是 undefined:开 / 关整段覆盖时 diff 照旧按格报(`imageGroup.enabled` /
		// `imageGroup.mergeForward` 各一条),不会塌成一条没有名字的整段 `imageGroup`。
		imageGroup: overrides.imageGroup ?? {},
		schedule: overrides.schedule,
		liveStart: overrides.liveStart,
		liveStreaming: overrides.liveStreaming,
		superchat: overrides.superchat,
		membership: overrides.membership,
		templates: overrides.templates,
		ai: overrides.ai,
		messageLayout: overrides.messageLayout,
		specialUsers,
	};
}
