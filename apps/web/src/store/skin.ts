import type { SkinManifest, SkinTextSlot } from "@bilibili-notify/contract";
import { create } from "zustand";
import { type ResolvedTheme, useThemeStore } from "./theme";

export interface ActiveSkin {
	id: string;
	manifest: SkinManifest;
}

/**
 * 试穿/预览中的皮肤。
 *
 * `mode` 是**编辑器点名正在编哪一套**:双套皮肤不点名时,预览按当前主题选套 ——
 * 主人在浅色页上改的每一笔都落进了看不见的那一套(真机症状:「壁纸在,纱和糊
 * 怎么调都不出来」,那张壁纸其实是深色那套的)。试穿不点名,照旧跟主题走。
 */
export interface PreviewSkin extends ActiveSkin {
	mode?: ResolvedTheme;
}

/** 深浅色各一个启用槽;槽空 = 该模式默认装。 */
export interface ActiveSkinSlots {
	light: ActiveSkin | null;
	dark: ActiveSkin | null;
}

export const EMPTY_SLOTS: ActiveSkinSlots = { light: null, dark: null };

export interface SkinState {
	/** 服务端已启用的双槽皮肤(GET /api/skins/active)。 */
	active: ActiveSkinSlots;
	/** 试穿中的皮肤(不落盘,刷新即失);优先于 active,也无视 killSwitch —— 逃生舱下还得能挑新皮肤。 */
	preview: PreviewSkin | null;
	/** `?skin=off`:本次会话强制默认装。 */
	killSwitch: boolean;
	/** 试穿单套皮肤锁定的模式;ThemeRoot 以它覆盖用户偏好,主题切换钮据此置灰。 */
	lockedTheme: ResolvedTheme | null;
	/** 编辑器开着:它借 preview 通道做实时预览,试穿浮条(SkinPreviewBar)让位。 */
	editing: boolean;
	setActive: (active: ActiveSkinSlots) => void;
	setPreview: (preview: PreviewSkin | null) => void;
	setKillSwitch: (killSwitch: boolean) => void;
	setLockedTheme: (lockedTheme: ResolvedTheme | null) => void;
	setEditing: (editing: boolean) => void;
}

export const useSkinStore = create<SkinState>((set) => ({
	active: EMPTY_SLOTS,
	preview: null,
	killSwitch: false,
	lockedTheme: null,
	editing: false,
	setActive: (active) => set({ active }),
	setPreview: (preview) => set({ preview }),
	setKillSwitch: (killSwitch) => set({ killSwitch }),
	setLockedTheme: (lockedTheme) => set({ lockedTheme }),
	setEditing: (editing) => set({ editing }),
}));

/** 此刻真正生效的皮肤:preview > killSwitch(关皮肤)> 当前主题槽的皮肤。 */
export function effectiveSkin(
	s: Pick<SkinState, "active" | "preview" | "killSwitch">,
	theme: ResolvedTheme,
) {
	return s.preview ?? (s.killSwitch ? null : s.active[theme]);
}

/** 当前生效皮肤的文案槽(manifest 级,跨明暗共用);没换装或槽位缺省 → null。 */
export function skinTextOf(
	s: Pick<SkinState, "active" | "preview" | "killSwitch">,
	theme: ResolvedTheme,
	slot: SkinTextSlot,
): string | null {
	return effectiveSkin(s, theme)?.manifest.texts?.[slot] ?? null;
}

/** 组件侧读文案槽;槽位值为 null 时用产品默认文案。 */
export function useSkinText(slot: SkinTextSlot): string | null {
	const theme = useThemeStore((s) => s.resolved);
	return useSkinStore((s) => skinTextOf(s, theme, slot));
}
