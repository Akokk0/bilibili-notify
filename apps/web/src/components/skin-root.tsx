import type { ActiveSkinResponse } from "@bilibili-notify/contract";
import { type ReactNode, useEffect, useLayoutEffect } from "react";
import { api } from "../services/api";
import {
	applySkinVars,
	clearSkinVars,
	composeSkinVars,
	resolveSkinMode,
	skinKillSwitchActive,
} from "../services/skin";
import { effectiveSkin, useSkinStore } from "../store/skin";
import { useThemeStore } from "../store/theme";

export function skinAssetUrl(id: string, name: string): string {
	return `/api/skins/${id}/assets/${name.slice("assets/".length)}`;
}

/**
 * 皮肤应用层。只写 documentElement 的 CSS 变量与 skin store 的 lockedTheme;
 * `dataset.theme` 的唯一 writer 是 ThemeRoot(它读 lockedTheme)—— 两个 effect
 * 抢同一个属性的竞态从结构上消掉。
 */
export function SkinRoot({ children }: { children: ReactNode }) {
	const active = useSkinStore((s) => s.active);
	const preview = useSkinStore((s) => s.preview);
	const killSwitch = useSkinStore((s) => s.killSwitch);
	const resolved = useThemeStore((s) => s.resolved);

	useLayoutEffect(() => {
		useSkinStore.getState().setKillSwitch(skinKillSwitchActive(window.location.search));
		void api
			.get<ActiveSkinResponse>("/api/skins/active")
			.then((res) => useSkinStore.getState().setActive(res.active))
			.catch(() => {
				// 拉不到当前皮肤(未登录/网络抖动)就先默认装;登录后 AuthGate 重挂载会再拉。
			});
	}, []);

	useEffect(() => {
		const root = document.documentElement;
		const skin = effectiveSkin({ active, preview, killSwitch });
		if (!skin) {
			clearSkinVars(root);
			useSkinStore.getState().setLockedTheme(null);
			return;
		}
		const { mode, theme, locked } = resolveSkinMode(skin.manifest, resolved);
		applySkinVars(
			root,
			composeSkinVars(mode, (name) => skinAssetUrl(skin.id, name)),
		);
		useSkinStore.getState().setLockedTheme(locked ? theme : null);
	}, [active, preview, killSwitch, resolved]);

	return <>{children}</>;
}
