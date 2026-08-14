import type { SkinManifest } from "@bilibili-notify/contract";
import { create } from "zustand";
import type { ResolvedTheme } from "./theme";

export interface ActiveSkin {
	id: string;
	manifest: SkinManifest;
}

export interface SkinState {
	/** 服务端已启用的皮肤(GET /api/skins/active)。 */
	active: ActiveSkin | null;
	/** 试穿中的皮肤(不落盘,刷新即失);优先于 active,也无视 killSwitch —— 逃生舱下还得能挑新皮肤。 */
	preview: ActiveSkin | null;
	/** `?skin=off`:本次会话强制默认装。 */
	killSwitch: boolean;
	/** 单套皮肤锁定的模式;ThemeRoot 以它覆盖用户偏好,主题切换钮据此置灰。 */
	lockedTheme: ResolvedTheme | null;
	setActive: (active: ActiveSkin | null) => void;
	setPreview: (preview: ActiveSkin | null) => void;
	setKillSwitch: (killSwitch: boolean) => void;
	setLockedTheme: (lockedTheme: ResolvedTheme | null) => void;
}

export const useSkinStore = create<SkinState>((set) => ({
	active: null,
	preview: null,
	killSwitch: false,
	lockedTheme: null,
	setActive: (active) => set({ active }),
	setPreview: (preview) => set({ preview }),
	setKillSwitch: (killSwitch) => set({ killSwitch }),
	setLockedTheme: (lockedTheme) => set({ lockedTheme }),
}));

/** 此刻真正生效的皮肤:preview > killSwitch(关皮肤)> active。 */
export function effectiveSkin(s: Pick<SkinState, "active" | "preview" | "killSwitch">) {
	return s.preview ?? (s.killSwitch ? null : s.active);
}
