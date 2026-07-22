/**
 * per-UP `overrides` 的 PATCH 线格式构造 —— 现在只是给 `buildPatch` 套一层域类型。
 *
 * 递归 diff 的实现与那段「为什么必须显式 null」的来龙去脉都在
 * `@bilibili-notify/internal/patch`(零依赖子路径,apps/web 与 astrbot/page 共用
 * 同一份 —— 从前两端各写各的,修好一边永远漏另一边)。
 */

import { buildPatch, type DeepPatch } from "@bilibili-notify/internal/patch";
import type { OverridesShape } from "../../types/domain";

/** 线格式:每个 slice(及其内部任意深度的字段)都可显式为 `null`。 */
export type OverridesPatch = {
	[K in keyof OverridesShape]?: DeepPatch<NonNullable<OverridesShape[K]>> | null;
};

export function buildOverridesPatch(draft: OverridesShape, base: OverridesShape): OverridesPatch {
	return buildPatch(draft, base) as OverridesPatch;
}
