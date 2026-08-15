import type { ActiveSkinResponse, SkinMode } from "@bilibili-notify/contract";
import { type ReactNode, useEffect, useLayoutEffect } from "react";
import { api } from "../services/api";
import {
	applySkinCss,
	applySkinVars,
	clearSkinCss,
	clearSkinVars,
	composeSkinCss,
	composeSkinVars,
	decorationStyle,
	resolveSkinMode,
	skinKillSwitchActive,
} from "../services/skin";
import { useSessionStore } from "../store/session";
import { effectiveSkin, useSkinStore } from "../store/skin";
import { useThemeStore } from "../store/theme";

export function skinAssetUrl(id: string, name: string): string {
	return `/api/skins/${id}/assets/${name.slice("assets/".length)}`;
}

/** 此刻生效的皮肤及其当前模式;没换装/逃生舱下为 null。装饰层/banner/文案槽共用。 */
export function useCurrentSkinMode(): { id: string; mode: SkinMode } | null {
	const active = useSkinStore((s) => s.active);
	const preview = useSkinStore((s) => s.preview);
	const killSwitch = useSkinStore((s) => s.killSwitch);
	const resolved = useThemeStore((s) => s.resolved);
	const skin = effectiveSkin({ active, preview, killSwitch });
	if (!skin) return null;
	return { id: skin.id, mode: resolveSkinMode(skin.manifest, resolved).mode };
}

/** 贴纸装饰层:fixed 全屏、点击穿透,件数少(≤6)且不进布局流。 */
function SkinDecorations() {
	const current = useCurrentSkinMode();
	const decorations = current?.mode.decorations;
	if (!current || !decorations?.length) return null;
	return (
		<div
			data-skin-decorations
			aria-hidden
			className="pointer-events-none fixed inset-0 z-30 overflow-hidden"
		>
			{decorations.map((d, i) => (
				<img
					// biome-ignore lint/suspicious/noArrayIndexKey: 装饰件无 id,列表来自 manifest 静态数组,不重排
					key={`${d.image}-${i}`}
					src={skinAssetUrl(current.id, d.image)}
					alt=""
					className="absolute max-w-none"
					style={decorationStyle(d)}
				/>
			))}
		</div>
	);
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
			clearSkinCss();
			useSkinStore.getState().setLockedTheme(null);
			return;
		}
		const { mode, theme, locked } = resolveSkinMode(skin.manifest, resolved);
		applySkinVars(
			root,
			composeSkinVars(mode, (name) => skinAssetUrl(skin.id, name)),
		);
		// 自定义 CSS:与变量同一拍注入;hook → 真实选择器的翻译只发生在这里。
		applySkinCss(composeSkinCss(skin.manifest, theme));
		useSkinStore.getState().setLockedTheme(locked ? theme : null);
	}, [active, preview, killSwitch, resolved]);

	return (
		<>
			{children}
			<SkinDecorations />
		</>
	);
}
