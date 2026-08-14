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
import { useSessionStore } from "../store/session";
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

	// /api/skins/* 在登录门之内 —— 冷启动未登录时拉必 401,得等 authed 翻 true 再拉,
	// 否则「登录后皮肤不生效,刷新才好」。authRequired=false 的部署首个 effect 就拉。
	const authed = useSessionStore((s) => s.authed);
	const authRequired = useSessionStore((s) => s.authRequired);

	useLayoutEffect(() => {
		useSkinStore.getState().setKillSwitch(skinKillSwitchActive(window.location.search));
	}, []);

	useEffect(() => {
		if (authRequired && !authed) return;
		void api
			.get<ActiveSkinResponse>("/api/skins/active")
			.then((res) => useSkinStore.getState().setActive(res.active))
			.catch(() => {
				// 网络抖动就先默认装;下次 authed 状态变化会再试。
			});
	}, [authed, authRequired]);

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
