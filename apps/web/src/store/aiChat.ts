import { create } from "zustand";

/**
 * 女仆 AI 聊天的**界面态** —— 侧栏收没收、开着哪个会话。
 *
 * 会话内容不在这里:那些是服务端的东西,由 react-query 管(见 services/aiChat)。
 *
 * 观感设置(主题色/玻璃质感)也不在这里:四色预设与聊天玻璃滑杆都已砍,
 * 默认装只有一套默认主题样式(styles.css 的 :root 定义、玻璃族吃 --bn-glass-*
 * token),换观感一律走皮肤包(皮肤编辑器)。
 *
 * 开合态也不在这里:聊天是一条路由(/chat),开没开由 URL 说了算 ——
 * 刷新、返回键、书签都归浏览器管,store 不该再攥一份会跑偏的副本。
 */

export interface AiChatState {
	/** 左侧会话栏是否展开。 */
	rail: boolean;
	/** 当前打开的会话 id;null = 还没选(显示空态问候页)。 */
	activeId: string | null;
	setRail: (next: boolean | ((prev: boolean) => boolean)) => void;
	setActiveId: (next: string | null) => void;
}

export const useAiChatStore = create<AiChatState>((set) => ({
	rail: true,
	activeId: null,
	setRail: (next) => set((s) => ({ rail: typeof next === "function" ? next(s.rail) : next })),
	setActiveId: (next) => set({ activeId: next }),
}));
