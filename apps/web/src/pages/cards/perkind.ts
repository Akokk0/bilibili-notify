/**
 * 按卡片类型的样式编辑(web 侧,镜像 internal 的 resolveCardStyleForKind 语义)。
 * `byKind` 是各类型对基准 `cardStyle` 的字段级覆盖;生效样式 = 基准 merge 该类型覆盖。
 * web 刻意只镜像类型、不在运行时引入 @bilibili-notify/internal,故这里独立实现。
 */

import type { CardKind, CardStyle, CardStyleByKind } from "../../types/globals";

export type { CardKind, CardStyleByKind };

/** 某类型的生效样式 = 基准 merge 该类型覆盖(字段级,覆盖层未定义的字段继承基准)。 */
export function resolveKindStyle(
	base: CardStyle,
	byKind: CardStyleByKind | undefined,
	kind: CardKind,
): CardStyle {
	return { ...base, ...(byKind?.[kind] ?? {}) };
}

/** 在某类型上改一个字段 → 写进该类型的覆盖层(不可变,不动其它类型)。 */
export function setKindField<K extends keyof CardStyle>(
	byKind: CardStyleByKind,
	kind: CardKind,
	key: K,
	value: CardStyle[K],
): CardStyleByKind {
	return { ...byKind, [kind]: { ...(byKind[kind] ?? {}), [key]: value } };
}

/** 「应用到所有卡片」:把当前类型的生效样式提升为基准,清空全部 per-kind 覆盖。 */
export function applyToAllKinds(
	base: CardStyle,
	byKind: CardStyleByKind,
	kind: CardKind,
): { base: CardStyle; byKind: CardStyleByKind } {
	return { base: resolveKindStyle(base, byKind, kind), byKind: {} };
}
