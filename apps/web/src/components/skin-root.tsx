import type { SkinMode } from "@bilibili-notify/contract";
import { type ReactNode, useEffect, useLayoutEffect } from "react";
import {
	applySkinCss,
	applySkinVars,
	clearSkinCss,
	clearSkinVars,
	composeChatWallpaperCss,
	composeEffectsCss,
	composeFontFaceCss,
	composeSkinCss,
	composeSkinVars,
	composeWallpaperCss,
	resolveSkinMode,
	skinKillSwitchActive,
} from "../services/skin";
import { syncActiveSkinToStore } from "../services/skin-active";
import { useSessionStore } from "../store/session";
import { type ActiveSkin, effectiveSkin, type SkinState, useSkinStore } from "../store/skin";
import type { ResolvedTheme } from "../store/theme";
import { useThemeStore } from "../store/theme";

export function skinAssetUrl(id: string, name: string): string {
	return `/api/skins/${id}/assets/${name.slice("assets/".length)}`;
}

/**
 * 此刻生效的皮肤 + 应渲染的模式。锁模式只属于试穿:preview 是单套皮肤时锁到
 * 它有的那套看效果;active 槽皮肤永远渲染当前主题对应的槽,不锁 —— 槽空=默认装。
 *
 * 编辑器会在 preview 上**点名正在编哪一套**,那一套优先于当前主题并锁住主题 ——
 * 不然双套皮肤在浅色页上改的每一笔都落进了看不见的那一套(见 {@link PreviewSkin})。
 */
function resolveCurrent(
	s: Pick<SkinState, "active" | "preview" | "killSwitch">,
	resolved: ResolvedTheme,
): { skin: ActiveSkin; mode: SkinMode; theme: ResolvedTheme; locked: boolean } | null {
	const skin = effectiveSkin(s, resolved);
	if (!skin) return null;
	if (s.preview) {
		// 点名的那套若压根不存在(刚删掉一色),当没点名 —— 回落比空白一片强。
		const named = s.preview.mode ? skin.manifest.modes[s.preview.mode] : undefined;
		if (named && s.preview.mode) {
			return { skin, mode: named, theme: s.preview.mode, locked: true };
		}
		const r = resolveSkinMode(skin.manifest, resolved);
		return { skin, mode: r.mode, theme: r.theme, locked: r.locked };
	}
	return { skin, mode: skin.manifest.modes[resolved] ?? {}, theme: resolved, locked: false };
}

/** 此刻生效的皮肤及其当前模式;没换装/逃生舱下为 null。装饰层/文案槽共用。 */
export function useCurrentSkinMode(): { id: string; mode: SkinMode } | null {
	const active = useSkinStore((s) => s.active);
	const preview = useSkinStore((s) => s.preview);
	const killSwitch = useSkinStore((s) => s.killSwitch);
	const resolved = useThemeStore((s) => s.resolved);
	const current = resolveCurrent({ active, preview, killSwitch }, resolved);
	if (!current) return null;
	return { id: current.skin.id, mode: current.mode };
}

/** 悬浮光斑:大尺寸柔光团慢速漂移;位置按序落在四个角落区。 */
const BOKEH_SPOTS = [
	{ left: "8%", top: "12%" },
	{ left: "72%", top: "18%" },
	{ left: "18%", top: "68%" },
	{ left: "70%", top: "70%" },
] as const;

function BokehField({ colors }: { colors: string[] }) {
	return (
		<>
			{colors.slice(0, BOKEH_SPOTS.length).map((color, i) => {
				const spot = BOKEH_SPOTS[i];
				const size = `${34 + i * 8}vmin`;
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: 光斑按位与颜色一一对应
						key={i}
						data-skin-bokeh
						className="absolute rounded-full"
						style={{
							left: spot.left,
							top: spot.top,
							width: size,
							height: size,
							background: `radial-gradient(circle, ${color}, transparent 70%)`,
							filter: "blur(28px)",
							opacity: 0.32,
							animation: `bn-skin-drift ${18 + i * 6}s ease-in-out ${-i * 5}s infinite`,
						}}
					/>
				);
			})}
		</>
	);
}

/** 动效层(粒子/光斑):fixed 全屏、点击穿透;reduce 偏好下由注入 CSS 整层隐藏。 */
function SkinEffectsLayer() {
	const current = useCurrentSkinMode();
	const fx = current?.mode.effects;
	if (!fx?.bokeh) return null;
	return (
		<div
			data-skin-effects
			aria-hidden
			className="pointer-events-none fixed inset-0 z-20 overflow-hidden"
		>
			<BokehField colors={fx.bokeh.colors} />
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
		void syncActiveSkinToStore().catch(() => {
			// 网络抖动就先默认装;下次 authed 状态变化会再试。
		});
	}, [authed, authRequired]);

	useEffect(() => {
		const root = document.documentElement;
		const current = resolveCurrent({ active, preview, killSwitch }, resolved);
		if (!current) {
			clearSkinVars(root);
			clearSkinCss();
			useSkinStore.getState().setLockedTheme(null);
			return;
		}
		const { skin, mode, theme, locked } = current;
		const assetUrl = (name: string) => skinAssetUrl(skin.id, name);
		applySkinVars(root, composeSkinVars(mode, assetUrl, theme));
		// 自定义 CSS + 壁纸糊化层 + 自带字体 + 动效预设产物:与变量同一拍进同一个
		// style 标签;hook → 真实选择器的翻译只发生在这里。
		applySkinCss(
			[
				composeSkinCss(skin.manifest, theme),
				composeWallpaperCss(mode, assetUrl, theme),
				composeChatWallpaperCss(mode, assetUrl, theme),
				// @font-face 与 --font-cjk 是一对,少接一半就是「选得动、就是不生效」。
				composeFontFaceCss(mode, assetUrl),
				composeEffectsCss(mode),
			]
				.filter((s) => s !== "")
				.join("\n"),
		);
		useSkinStore.getState().setLockedTheme(locked ? theme : null);
	}, [active, preview, killSwitch, resolved]);

	return (
		<>
			{children}
			<SkinEffectsLayer />
		</>
	);
}
