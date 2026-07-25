import { create } from "zustand";

/**
 * 女仆 AI 聊天的**界面态** —— 开没开、侧栏收没收、用哪套主题色。
 *
 * 会话内容不在这里:那些是服务端的东西,由 react-query 管(见 services/aiChat)。
 * 这里只放「刷新一次就该忘掉」和「跨会话记住」两类纯 UI 状态,分界线是
 * {@link CHAT_THEME_KEY} —— 只有主题色写进 localStorage。
 *
 * 开合态刻意**不**持久化:聊天是整页覆盖的,持久化的话主人上次退出时忘了关,
 * 下次打开 dashboard 会直接糊上一整屏聊天,找不到自己的控制台。
 */

export const CHAT_THEMES = ["lime", "violet", "sky", "peach"] as const;
export type ChatTheme = (typeof CHAT_THEMES)[number];

/** 主题色的中文名,设置弹层里显示。 */
export const CHAT_THEME_LABELS: Record<ChatTheme, string> = {
	lime: "青柠",
	violet: "紫罗兰",
	sky: "天青",
	peach: "蜜桃",
};

const CHAT_THEME_KEY = "bn.aiChat.theme";
const DEFAULT_THEME: ChatTheme = "lime";

/** localStorage 里的值 → 合法主题名。认不出来一律回落默认,不让脏值把页面画瞎。 */
export function normalizeChatTheme(value: unknown): ChatTheme {
	return CHAT_THEMES.includes(value as ChatTheme) ? (value as ChatTheme) : DEFAULT_THEME;
}

/**
 * 读回上次选的主题色。
 *
 * localStorage 在隐私模式 / 某些内嵌 WebView 里读写都会抛,所以整段包 try —— 一个
 * 记不住的偏好设置不该让整个聊天打不开。
 */
function loadTheme(): ChatTheme {
	try {
		return normalizeChatTheme(localStorage.getItem(CHAT_THEME_KEY));
	} catch {
		return DEFAULT_THEME;
	}
}

export interface AiChatState {
	/** 整页聊天是否展开。false = 只显示右下角那颗胶囊。 */
	open: boolean;
	/** 左侧会话栏是否展开。 */
	rail: boolean;
	theme: ChatTheme;
	/** 当前打开的会话 id;null = 还没选(显示空态问候页)。 */
	activeId: string | null;
	setOpen: (next: boolean) => void;
	setRail: (next: boolean | ((prev: boolean) => boolean)) => void;
	setTheme: (next: ChatTheme) => void;
	setActiveId: (next: string | null) => void;
}

export const useAiChatStore = create<AiChatState>((set) => ({
	open: false,
	rail: true,
	theme: loadTheme(),
	activeId: null,
	setOpen: (next) => set({ open: next }),
	setRail: (next) => set((s) => ({ rail: typeof next === "function" ? next(s.rail) : next })),
	setTheme: (next) => {
		set({ theme: next });
		try {
			localStorage.setItem(CHAT_THEME_KEY, next);
		} catch {
			// 存不住就算了,本次会话内仍然生效。
		}
	},
	setActiveId: (next) => set({ activeId: next }),
}));
