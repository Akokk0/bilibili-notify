/**
 * DraftIsland — 灵动岛草稿机制(Phase B 骨架)。
 *
 * 设计目标:把现状各页右上角的「未保存 + 丢弃 + 保存」内联条收敛到全局漂浮
 * 灵动岛,居中底部 + safe-area + 跟随 FloatingAiBar 状态垂直堆叠;5 态(idle
 * / dirty / saving / saved / error)+ expand panel 展示字段级 diff。
 *
 * Phase 拆分(plan 见 memory/draft-island-plan.md):
 * - Phase B(本步):mount 占位 + motion 依赖就位,无视觉
 * - Phase C:接 useDirtyDraft hook + zustand draft-store + walkTreeDiff
 * - Phase D:chip 5 态视觉(AnimatePresence mode="wait" 切换 sub-component)
 * - Phase E:expand panel + DiffList + click 跳转字段(data-code 锚点)
 * - Phase F:Rules / Cards / Ai / System 4 页接入 useDirtyDraft 替换内联条
 *
 * 当前实现:return null,确保挂载点稳定,后续阶段只改本组件内部不动 App.tsx。
 */
export function DraftIsland(): null {
	return null;
}
