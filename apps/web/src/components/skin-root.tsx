import type { ActiveSkinResponse, SkinEffects, SkinMode } from "@bilibili-notify/contract";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo } from "react";
import { api } from "../services/api";
import {
	applySkinCss,
	applySkinVars,
	clearSkinCss,
	clearSkinVars,
	composeEffectsCss,
	composeSkinCss,
	composeSkinVars,
	composeWallpaperCss,
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

/** 此刻生效的皮肤及其当前模式;没换装/逃生舱下为 null。装饰层/文案槽共用。 */
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

/** 粒子默认色:樱花粉 / 雪白 / 星尘金。 */
const PARTICLE_DEFAULT_COLOR: Record<string, string> = {
	sakura: "#ffb7c5",
	snow: "rgba(255,255,255,0.9)",
	stardust: "#ffe9a8",
};

function ParticleField({ cfg }: { cfg: NonNullable<SkinEffects["particles"]> }) {
	// 随机参数一次生成、mount 内稳定 —— 每帧重算会让粒子跳位。
	const items = useMemo(() => {
		const count = Math.round((cfg.density ?? 0.6) * 40);
		return Array.from({ length: count }, (_, i) => ({
			left: `${(i * 37 + Math.random() * 23) % 100}%`,
			size: 6 + Math.random() * (cfg.kind === "stardust" ? 4 : 8),
			duration: 9 + Math.random() * 9,
			delay: -Math.random() * 18,
			opacity: 0.5 + Math.random() * 0.5,
		}));
	}, [cfg.density, cfg.kind]);

	const color = cfg.color ?? PARTICLE_DEFAULT_COLOR[cfg.kind] ?? "#ffffff";
	return (
		<>
			{items.map((p, i) => {
				const style: CSSProperties = {
					left: p.left,
					top: 0,
					width: p.size,
					height: cfg.kind === "sakura" ? p.size * 0.85 : p.size,
					background: color,
					opacity: p.opacity,
					// sakura 是花瓣形,其余圆点;stardust 额外一圈光晕 + 闪烁
					borderRadius: cfg.kind === "sakura" ? "62% 6% 62% 6%" : "50%",
					...(cfg.kind === "stardust" ? { boxShadow: `0 0 ${p.size}px ${color}` } : {}),
					animation:
						cfg.kind === "stardust"
							? `bn-skin-fall ${p.duration}s linear ${p.delay}s infinite, bn-skin-twinkle ${2 + (i % 3)}s ease-in-out infinite`
							: `bn-skin-fall ${p.duration}s linear ${p.delay}s infinite`,
				};
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: 粒子无身份,列表长度只随配置变
					<span key={i} data-skin-particle className="absolute" style={style} />
				);
			})}
		</>
	);
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
	if (!fx || (!fx.particles && !fx.bokeh)) return null;
	return (
		<div
			data-skin-effects
			aria-hidden
			className="pointer-events-none fixed inset-0 z-20 overflow-hidden"
		>
			{fx.bokeh ? <BokehField colors={fx.bokeh.colors} /> : null}
			{fx.particles ? <ParticleField cfg={fx.particles} /> : null}
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
		const assetUrl = (name: string) => skinAssetUrl(skin.id, name);
		applySkinVars(root, composeSkinVars(mode, assetUrl, theme));
		// 自定义 CSS + 壁纸糊化层 + 动效预设产物:与变量同一拍进同一个 style 标签;
		// hook → 真实选择器的翻译只发生在这里。
		applySkinCss(
			[
				composeSkinCss(skin.manifest, theme),
				composeWallpaperCss(mode, assetUrl, theme),
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
			<SkinDecorations />
		</>
	);
}
