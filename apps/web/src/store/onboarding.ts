import { create } from "zustand";

/**
 * 「重新开启新手指引」的跨组件信号。
 *
 * 入口在系统页(GlassBox 小节),导览本体挂在 App 根 —— 两者不在一棵子树里,
 * 而「重开」除了写回 `onboarding.skipped=false` 还要把**这台浏览器**收着的卡
 * 展开(不展开的话点了按钮毫无动静)。配置走 PATCH + invalidate 已有通道;
 * 展开这半拍走这里:seq 自增一次 = 一次重开手势,TourCompanion 监听后展开。
 */
export const useOnboardingReopen = create<{ seq: number; reopen: () => void }>((set) => ({
	seq: 0,
	reopen: () => set((s) => ({ seq: s.seq + 1 })),
}));
