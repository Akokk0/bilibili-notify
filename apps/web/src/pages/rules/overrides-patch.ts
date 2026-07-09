/**
 * per-UP `overrides` 的 PATCH 线格式构造。
 *
 * store 的 deepMerge 约定(store.ts SY1):patch 里**键缺失 = 「不改」**,显式
 * **`null` = 「清除该键」**,且 deepMerge 本身是递归的 —— 任意深度的键都能单独
 * 清除。这里的 diff 必须对称地递归下去,不能只清到 slice 这一层:filters /
 * templates 这类 slice 会被多个 PerUpEditor section 分域共写同一个嵌套对象
 * (例如 filters 由「动态过滤」与「直播阈值」两个 section 分别写各自的字段;
 * templates 由 summary/msg/dynamicMsg/guard/specialUser 五个 section 共写)。
 * 只清自己那部分字段、slice 本身仍非空时,若把 draft 的该 slice 整段原样下发,
 * 被删的字段只是「没提」而非显式 null —— 服务端 deepMerge 当「不改」→ 旧值
 * 残留,关闭的覆盖开关保存后又"复活",灵动岛也因为读回值对不上草稿而重新显示
 * 未保存改动。
 *
 * 因此 diffToPatch 递归对比 draft 与 baseline:两边都是 plain object 才递归
 * 逐字段 diff;其余(标量 / 数组 / 类型不对齐)一律整体当叶子,draft 有就原样
 * 下发,draft 缺而 baseline 有就回填清除哨兵 null,两边都没有就不下发。
 */

import type { OverridesShape } from "../../types/domain";

/** 深度可空版本:任意层级的键都可能显式为 `null`(清除哨兵);数组整体当叶子。 */
type DeepPatch<T> = T extends readonly unknown[]
	? T | null
	: T extends object
		? { [K in keyof T]?: DeepPatch<T[K]> | null }
		: T | null;

/** 线格式:每个 slice(及其内部任意深度的字段)都可显式为 `null`。 */
export type OverridesPatch = {
	[K in keyof OverridesShape]?: DeepPatch<NonNullable<OverridesShape[K]>> | null;
};

function isPlainObject(x: unknown): x is Record<string, unknown> {
	if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
	const proto = Object.getPrototypeOf(x);
	return proto === Object.prototype || proto === null;
}

function diffToPatch(base: unknown, draft: unknown): unknown {
	if (draft === undefined) return base === undefined ? undefined : null;
	if (isPlainObject(base) && isPlainObject(draft)) {
		const out: Record<string, unknown> = {};
		for (const k of new Set([...Object.keys(base), ...Object.keys(draft)])) {
			const d = diffToPatch(base[k], draft[k]);
			if (d !== undefined) out[k] = d;
		}
		return out;
	}
	return draft;
}

export function buildOverridesPatch(draft: OverridesShape, base: OverridesShape): OverridesPatch {
	const out: Record<string, unknown> = {};
	const draftRec = draft as Record<string, unknown>;
	const baseRec = base as Record<string, unknown>;
	for (const k of new Set([...Object.keys(draftRec), ...Object.keys(baseRec)])) {
		const d = diffToPatch(baseRec[k], draftRec[k]);
		if (d !== undefined) out[k] = d;
	}
	return out as OverridesPatch;
}
