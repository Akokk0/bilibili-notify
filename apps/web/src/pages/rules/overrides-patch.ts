/**
 * per-UP `overrides` 的 PATCH 线格式构造。
 *
 * store 的 deepMerge 约定(store.ts SY1):patch 里**键缺失 = 「不改」**,显式
 * **`null` = 「清除该键」**。关闭某覆盖框时 PerUpEditor 的 setSlice 已把整段 slice
 * 从草稿删除,但若直接把 `draft.overrides` 当 body 发出,`JSON.stringify` 会连同
 * 「被删的键」一起丢掉 → 服务端当「不改」→ 旧 slice 残留 → 读回与草稿永不相等,
 * 灵动岛刚报「已保存」又立刻跳「有未保存改动」(diff 永不归零)。
 *
 * 这里对「baseline 有、draft 已删」的 slice 显式回填 `null`,让服务端真正删除;
 * 仍存在的 slice 原样保留,baseline 本就没有的 slice 不下发 null(无需清除)。
 */

import type { OverridesShape } from "../../types/domain";

/** 线格式:每个 slice 可显式为 `null`(清除哨兵)。 */
export type OverridesPatch = { [K in keyof OverridesShape]?: OverridesShape[K] | null };

export function buildOverridesPatch(draft: OverridesShape, base: OverridesShape): OverridesPatch {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(draft)) {
		if (v !== undefined) out[k] = v;
	}
	for (const k of Object.keys(base)) {
		// baseline 有、draft 已删(或显式 undefined)→ 回填清除哨兵。
		if (!(k in out)) out[k] = null;
	}
	return out as OverridesPatch;
}
