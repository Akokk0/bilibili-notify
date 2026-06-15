/**
 * per-UP 灵动岛草稿投影 —— 把 Subscription 的 `overrides` + `specialUsers`
 * 映射成「扁平 code 结构」,使 walkTreeDiff 产出的 dot-path 与 FIELD_LABELS 的
 * code 对齐(section 分组 / 值格式化 / `[data-code]` 跳转锚点全部命中)。
 *
 * 对齐规则与全局灵动岛(Rules.tsx 的 islandDraft/islandBaseline)一致:
 * - **code 无前缀的 slice 打平**(filters / cardStyle / imageGroup):字段直接
 *   作为顶层 key(blockKeywords / cardColorStart / enable …)。
 * - **code 带前缀的 slice 保 nested**(schedule / templates / ai):整段挂在
 *   对应 key 下,walkTreeDiff 递归出 `schedule.X` / `templates.X` / `ai.X`。
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
		...overrides.cardStyle,
		...overrides.imageGroup,
		schedule: overrides.schedule,
		templates: overrides.templates,
		ai: overrides.ai,
		specialUsers,
	};
}
