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

/** 四种卡片类型的固定全集 —— 下发时要逐个表态,不能只报有覆盖的那几个。 */
const ALL_KINDS = ["live", "dynamic", "sc", "guard"] as const satisfies readonly CardKind[];

/**
 * 把「按类型覆盖」摊平成完整四键:有覆盖的给对象,没有的显式给 `null`。**保存前
 * 必须过这一道**,否则关掉的类型关不掉。
 *
 * 配置 PATCH 走 JSON Merge Patch 语义 —— **键消失 = 该字段不改**,只有显式 `null`
 * 才是删除(服务端 `config/store.ts` 的 deepMerge)。而关掉一个类型在前端是 `delete`
 * 掉那个键,于是直接回传这个 map 时,「关掉直播卡的单独样式」在网络上等于什么都
 * 没说:请求 200、后端原样留着旧覆盖,刷新回来开关又是开的 —— 用户看到的就是
 * 「关不掉」。
 */
export function explicitByKind(
	byKind: CardStyleByKind,
): Record<CardKind, CardStyleByKind[CardKind] | null> {
	return Object.fromEntries(ALL_KINDS.map((k) => [k, byKind[k] ?? null])) as Record<
		CardKind,
		CardStyleByKind[CardKind] | null
	>;
}

/** 「应用到所有卡片」:把当前类型的生效样式提升为基准,清空全部 per-kind 覆盖。 */
export function applyToAllKinds(
	base: CardStyle,
	byKind: CardStyleByKind,
	kind: CardKind,
): { base: CardStyle; byKind: CardStyleByKind } {
	return { base: resolveKindStyle(base, byKind, kind), byKind: {} };
}
