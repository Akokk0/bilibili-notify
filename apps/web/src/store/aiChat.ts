import { create } from "zustand";

/**
 * 女仆 AI 聊天的**界面态** —— 侧栏收没收、用哪套主题色、玻璃调到哪档。
 *
 * 会话内容不在这里:那些是服务端的东西,由 react-query 管(见 services/aiChat)。
 * 这里只放「刷新一次就该忘掉」和「跨会话记住」两类纯 UI 状态,分界线是
 * {@link CHAT_THEME_KEY} —— 只有主题色写进 localStorage。
 *
 * 开合态也不在这里:聊天是一条路由(/chat),开没开由 URL 说了算 ——
 * 刷新、返回键、书签都归浏览器管,store 不该再攥一份会跑偏的副本。
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

/**
 * 玻璃片默认透明度 —— 与推送卡片的玻璃片基线同一个数(`cardStyle.glassOpacity`
 * 打开开关时给的也是它)。两处用同一个默认,主人调完卡片再看聊天不会觉得错位。
 */
export const DEFAULT_GLASS_OPACITY = 0.82;
const CHAT_GLASS_OPACITY_KEY = "bn.aiChat.glassOpacity";
const CHAT_GLASS_CLEAR_KEY = "bn.aiChat.glassClear";

/** localStorage 里的值 → 合法主题名。认不出来一律回落默认,不让脏值把页面画瞎。 */
export function normalizeChatTheme(value: unknown): ChatTheme {
	return CHAT_THEMES.includes(value as ChatTheme) ? (value as ChatTheme) : DEFAULT_THEME;
}

/**
 * localStorage 里的值 → 合法透明度。
 *
 * 存进去的是字符串,而且这是**外部输入** —— 主人手改过、旧版本写过别的格式都有
 * 可能。认不出来回落默认,认得出来但越界就夹回 0..1:alpha 算出个负数会把整块
 * 面板画瞎,而那时候主人连设置面板都看不见了,没法自己调回来。
 */
export function normalizeGlassOpacity(value: unknown): number {
	// 只认字符串和数,别的一律当没设过。**不能写 Number(value)** —— `Number(null)`
	// 是 0,而 null 正是 localStorage 没存过时的返回值,那样第一次打开聊天就是
	// 一片全透明,而且主人还以为自己什么都没动。
	const n =
		typeof value === "string"
			? Number.parseFloat(value)
			: typeof value === "number"
				? value
				: Number.NaN;
	if (!Number.isFinite(n)) return DEFAULT_GLASS_OPACITY;
	return Math.min(1, Math.max(0, n));
}

/**
 * 读写 localStorage 的两个包装。
 *
 * localStorage 在隐私模式 / 某些内嵌 WebView 里读写**都会抛**,所以一律包 try ——
 * 一个记不住的偏好设置不该让整个聊天打不开。存不住的话本次会话内仍然生效。
 */
function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
function writeStored(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// 存不住就算了。
	}
}

function loadTheme(): ChatTheme {
	return normalizeChatTheme(readStored(CHAT_THEME_KEY));
}

export interface AiChatState {
	/** 左侧会话栏是否展开。 */
	rail: boolean;
	theme: ChatTheme;
	/** 玻璃片透明度,0..1。{@link AiChatState.glassClear} 为 true 时这个值留着但不生效。 */
	glassOpacity: number;
	/**
	 * 完全透明:玻璃片透光 + **去掉磨砂模糊**,底下的东西完全清晰透出。
	 * 与 {@link AiChatState.glassOpacity} 二选一,为 true 时优先。
	 */
	glassClear: boolean;
	/** 当前打开的会话 id;null = 还没选(显示空态问候页)。 */
	activeId: string | null;
	setRail: (next: boolean | ((prev: boolean) => boolean)) => void;
	setTheme: (next: ChatTheme) => void;
	setGlassOpacity: (next: number) => void;
	setGlassClear: (next: boolean) => void;
	setActiveId: (next: string | null) => void;
}

export const useAiChatStore = create<AiChatState>((set) => ({
	rail: true,
	theme: loadTheme(),
	glassOpacity: normalizeGlassOpacity(readStored(CHAT_GLASS_OPACITY_KEY)),
	glassClear: readStored(CHAT_GLASS_CLEAR_KEY) === "1",
	activeId: null,
	setRail: (next) => set((s) => ({ rail: typeof next === "function" ? next(s.rail) : next })),
	setTheme: (next) => {
		set({ theme: next });
		writeStored(CHAT_THEME_KEY, next);
	},
	setGlassOpacity: (next) => {
		const value = normalizeGlassOpacity(next);
		// 顺手关掉完全透明。它优先级更高,开着它拉滑块画面纹丝不动 —— 主人只会
		// 觉得滑块坏了,而不会想到是被另一个开关压着。
		set({ glassOpacity: value, glassClear: false });
		writeStored(CHAT_GLASS_OPACITY_KEY, String(value));
		writeStored(CHAT_GLASS_CLEAR_KEY, "0");
	},
	setGlassClear: (next) => {
		// 只翻这个开关,glassOpacity **原样留着**:关掉之后要能回到原来那一档,
		// 清零的话主人关了个寂寞,只能重新拉一遍滑块。
		set({ glassClear: next });
		writeStored(CHAT_GLASS_CLEAR_KEY, next ? "1" : "0");
	},
	setActiveId: (next) => set({ activeId: next }),
}));
