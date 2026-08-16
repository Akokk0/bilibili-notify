/**
 * 皮肤合成层:SkinMode(语义字段)→ CSS 变量表 → documentElement 注入。
 * 预览与正式应用共用这一套函数(定案);变量值在服务端已过注入面校验,
 * 这里用 setProperty 注入 —— DOM API 不解析分号逃逸,是第二道保险。
 */

import {
	SKIN_COLOR_TOKEN_MAP,
	SKIN_CSS_HOOK_MAP,
	type SkinManifest,
	type SkinMode,
} from "@bilibili-notify/contract";
import type { ResolvedTheme } from "../store/theme";

export type SkinVars = Record<string, string>;

/** 需要引号的字体名:含空格或任何非 ASCII 字符。 */
function quoteFontName(name: string): string {
	return /^[A-Za-z0-9-]+$/.test(name) ? name : `"${name}"`;
}

/**
 * 壁纸背景层清单:遮罩纱 + 图。纱色跟模式走 —— 亮色蒙白纱、暗色蒙黑纱,
 * 黑纱压高饱和亮壁纸只会更浑浊(玻璃叠玻璃议题的定案之一)。
 */
function buildWallpaperLayers(
	wp: NonNullable<SkinMode["wallpaper"]> & { image: string },
	assetUrl: (name: string) => string,
	theme: ResolvedTheme,
): string {
	const fit = wp.fit ?? "cover";
	const position = wp.position ?? "center";
	const layers: string[] = [];
	if (wp.overlay !== undefined && wp.overlay > 0) {
		const base = theme === "light" ? "255, 255, 255" : "0, 0, 0";
		const o = `rgba(${base}, ${wp.overlay})`;
		layers.push(`linear-gradient(${o}, ${o})`);
	}
	const image = `url("${assetUrl(wp.image)}")`;
	layers.push(
		fit === "tile"
			? `${image} ${position} repeat`
			: `${image} ${position} / ${fit === "contain" ? "contain" : "cover"} no-repeat`,
	);
	return layers.join(", ");
}

export function composeSkinVars(
	mode: SkinMode,
	assetUrl: (name: string) => string,
	theme: ResolvedTheme,
): SkinVars {
	const vars: SkinVars = {};

	if (mode.colors) {
		for (const [key, cssVar] of Object.entries(SKIN_COLOR_TOKEN_MAP)) {
			const value = mode.colors[key as keyof typeof SKIN_COLOR_TOKEN_MAP];
			if (value) vars[cssVar] = value;
		}
	}

	if (mode.page?.background) vars["--bn-page-bg"] = mode.page.background;

	if (mode.wallpaper?.image) {
		const wp = { ...mode.wallpaper, image: mode.wallpaper.image };
		// blur>0 时壁纸交给 composeWallpaperCss 的 body::before 糊化层;
		// --bn-page-bg 留给 page.background/默认底色,垫在糊化层后面。
		if (!(wp.blur !== undefined && wp.blur > 0)) {
			vars["--bn-page-bg"] = buildWallpaperLayers(wp, assetUrl, theme);
		}
	}

	if (mode.glass) {
		const g = mode.glass;
		if (g.background) vars["--bn-glass-bg"] = g.background;
		if (g.border) vars["--bn-glass-border"] = g.border;
		if (g.strongBackground) vars["--bn-glass-strong-bg"] = g.strongBackground;
		if (g.strongBorder) vars["--bn-glass-strong-border"] = g.strongBorder;
		if (g.blur !== undefined) vars["--bn-glass-blur"] = `${g.blur}px`;
		if (g.strongBlur !== undefined) vars["--bn-glass-strong-blur"] = `${g.strongBlur}px`;
	}

	if (mode.fonts?.body?.length) {
		const stack = mode.fonts.body.map(quoteFontName);
		vars["--font-cjk"] = [...stack, "system-ui", "sans-serif"].join(", ");
	}

	if (mode.radius?.card !== undefined) vars["--radius-bn-card"] = `${mode.radius.card}px`;
	if (mode.radius?.pill !== undefined) vars["--radius-bn-pill"] = `${mode.radius.pill}px`;

	if (mode.shadows?.card) vars["--shadow-bn-card"] = mode.shadows.card;
	if (mode.shadows?.elev) vars["--shadow-bn-elev"] = mode.shadows.elev;

	// AI 聊天页:皮肤生效即整体接管(chat 根摘 data-chat-theme、四色预设隐藏),
	// 所以变量必须全套输出 —— styles.css 的 bn-chat-accent-* 族没有 fallback。
	// 派生链:chat.accent → colors.accent → 品牌粉;chat 段只是精调入口。
	{
		const chat = mode.chat ?? {};
		const accent = chat.accent ?? mode.colors?.accent ?? "#fb7299";
		// hsl/oklch 解析不了时退品牌粉分量(soft 层会偏粉,已知限制;hex/rgb 覆盖绝大多数)
		const rgb = toRgbTriple(accent) ?? "251, 114, 153";
		vars["--bn-chat-dot"] = accent;
		vars["--bn-chat-accent-rgb"] = rgb;
		vars["--bn-chat-accent-2"] = chat.accentSecondary ?? accent;
		// 空态大标题背后那团光:从 accent 合成,浓度两套跟模式走(与四色预设同律)
		vars["--bn-chat-glow"] =
			theme === "light"
				? `radial-gradient(closest-side, rgba(${rgb}, 0.32), rgba(${rgb}, 0.14) 46%, rgba(255, 255, 255, 0) 78%)`
				: `radial-gradient(closest-side, rgba(${rgb}, 0.2), rgba(${rgb}, 0.09) 46%, rgba(0, 0, 0, 0) 78%)`;
		// 背景:缺省 transparent 透出皮肤整页底;chat 壁纸(无 blur)合成进来,
		// 配了 background 就垫在壁纸最底(纯色包成渐变才能当 background 层)
		const base = chat.background ?? "transparent";
		const wp = chat.wallpaper;
		if (wp?.image && !(wp.blur !== undefined && wp.blur > 0)) {
			const layers = buildWallpaperLayers({ ...wp, image: wp.image }, assetUrl, theme);
			vars["--bn-chat-bg"] =
				base === "transparent"
					? layers
					: `${layers}, ${base.includes("gradient(") ? base : `linear-gradient(${base}, ${base})`}`;
		} else {
			vars["--bn-chat-bg"] = base;
		}
	}

	return vars;
}

/** hex(#rgb/#rgba/#rrggbb/#rrggbbaa) 或 rgb()/rgba() → "r, g, b" 分量;解析不了 → null。 */
function toRgbTriple(color: string): string | null {
	const t = color.trim();
	let m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(t);
	if (m?.[1]) {
		const h = m[1];
		return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)).join(", ");
	}
	m = /^#([0-9a-f]{3})(?:[0-9a-f])?$/i.exec(t);
	if (m?.[1]) {
		const h = m[1];
		return [0, 1, 2].map((i) => Number.parseInt(`${h[i]}${h[i]}`, 16)).join(", ");
	}
	m = /^rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})/i.exec(t);
	if (m) return `${m[1]}, ${m[2]}, ${m[3]}`;
	return null;
}

export interface ResolvedSkinMode {
	mode: SkinMode;
	theme: ResolvedTheme;
	locked: boolean;
}

/** 双套跟随请求模式;单套锁定到皮肤给的那套(切换钮随之置灰)。 */
export function resolveSkinMode(skin: SkinManifest, requested: ResolvedTheme): ResolvedSkinMode {
	const { light, dark } = skin.modes;
	if (light && dark) {
		return { mode: requested === "dark" ? dark : light, theme: requested, locked: false };
	}
	if (dark) return { mode: dark, theme: "dark", locked: true };
	if (light) return { mode: light, theme: "light", locked: true };
	// 校验层保证至少一套;真到这里就当没皮肤。
	return { mode: {}, theme: requested, locked: false };
}

/** 上次注入过的键,换皮肤/清皮肤时按这份清单移除 —— 别让残留变量叠在新皮肤上。 */
const injected = new WeakMap<HTMLElement, string[]>();

export function applySkinVars(el: HTMLElement, vars: SkinVars): void {
	clearSkinVars(el);
	for (const [key, value] of Object.entries(vars)) {
		el.style.setProperty(key, value);
	}
	injected.set(el, Object.keys(vars));
}

export function clearSkinVars(el: HTMLElement): void {
	for (const key of injected.get(el) ?? []) {
		el.style.removeProperty(key);
	}
	injected.delete(el);
}

/** `?skin=off`:本次会话强制默认装(不改服务端状态),皮肤糊了界面时的逃生舱。 */
export function skinKillSwitchActive(search: string): boolean {
	return new URLSearchParams(search).get("skin") === "off";
}

// ---- 自定义 CSS ------------------------------------------------------------

/**
 * hook → 真实选择器的注入时翻译。存盘的皮肤 CSS 永远是 hook 形式
 * (`[data-bn="glass"]`),内部选择器重构只改 SKIN_CSS_HOOK_MAP,存量皮肤跟着走。
 * 输入是服务端清洗后的产物,格式可控(css-tree 序列化,引号或裸标识符两种);
 * 未知 hook 原样保留 —— 属性选择器命中不了任何元素,天然无害。
 */
export function translateSkinCssHooks(css: string): string {
	return css.replace(/\[data-bn[~|]?="?([A-Za-z0-9-]+)"?\]/g, (raw, hook: string) => {
		const real = SKIN_CSS_HOOK_MAP[hook as keyof typeof SKIN_CSS_HOOK_MAP];
		return real ?? raw;
	});
}

/** 顶层共用 + 当前模式追加(后到的覆盖先到的),输出已完成 hook 翻译。 */
export function composeSkinCss(manifest: SkinManifest, mode: "light" | "dark"): string {
	const parts = [manifest.css, manifest.modes[mode]?.css].filter(
		(s): s is string => typeof s === "string" && s !== "",
	);
	return translateSkinCssHooks(parts.join("\n"));
}

/**
 * 壁纸糊化层:wallpaper.blur > 0 时壁纸(含纱)整体搬进 body::before 固定层
 * 做静态高斯模糊 —— 一次成像、无逐帧动画。负 inset 按 2×blur 外扩,遮掉模糊
 * 的边缘透底;z-index:-1 让它画在 body 底色之上、页面内容之下。
 * 与动效 CSS 同为可信内置产物,拼进同一个 style 标签。
 */
export function composeWallpaperCss(
	mode: SkinMode,
	assetUrl: (name: string) => string,
	theme: ResolvedTheme,
): string {
	const wp = mode.wallpaper;
	if (!wp?.image || wp.blur === undefined || wp.blur <= 0) return "";
	const layers = buildWallpaperLayers({ ...wp, image: wp.image }, assetUrl, theme);
	return `body::before{content:"";position:fixed;inset:-${wp.blur * 2}px;z-index:-1;pointer-events:none;background:${layers};filter:blur(${wp.blur}px)}`;
}

/**
 * 动效预设 → 内置 CSS。这段是**我们自己写的可信产物**(不过白名单),与皮肤
 * 自定义 CSS 拼进同一个 style 标签。所有动画包在 prefers-reduced-motion:
 * no-preference 里;光斑层在 reduce 偏好下整层隐藏(不动的光斑只是色块)。
 */
export function composeEffectsCss(mode: SkinMode): string {
	const fx = mode.effects;
	if (!fx) return "";
	const anim: string[] = [];

	if (fx.glassShine) {
		// 只动 box-shadow:不碰 position/transform,零布局回归面。
		// 动画值会覆盖 utility 的 box-shadow,所以每帧都把元素自己的 --tw-* 合成链
		// 合回来(自定义属性动画覆盖不到,hover 切 elev 也跟着走),基础三层影保住,
		// 流光只是追加的最外层;裸 .bn-glass(没配 shadow-bn-*)兜底 0 0 #0000。
		const c = fx.glassShine.color ?? "var(--color-bn-pink)";
		const base =
			"var(--tw-inset-shadow, 0 0 #0000), var(--tw-inset-ring-shadow, 0 0 #0000), var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow, 0 0 #0000)";
		anim.push(
			".bn-glass{animation:bn-skin-glass-shine 7s ease-in-out infinite}",
			`@keyframes bn-skin-glass-shine{0%,100%{box-shadow:${base}, 0 -10px 28px -14px ${c}}25%{box-shadow:${base}, 10px 0 28px -14px ${c}}50%{box-shadow:${base}, 0 10px 28px -14px ${c}}75%{box-shadow:${base}, -10px 0 28px -14px ${c}}}`,
		);
	}

	if (fx.bokeh) {
		anim.push(
			"@keyframes bn-skin-drift{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(6vw,-5vh) scale(1.15)}66%{transform:translate(-5vw,5vh) scale(0.9)}}",
		);
	}

	const parts: string[] = [];
	if (anim.length > 0) {
		parts.push(`@media (prefers-reduced-motion: no-preference){${anim.join("")}}`);
	}
	if (fx.bokeh) {
		parts.push("@media (prefers-reduced-motion: reduce){[data-skin-effects]{display:none}}");
	}
	return parts.join("\n");
}

/**
 * chat 专属壁纸的糊化层:与整页 composeWallpaperCss 同哲学 —— blur > 0 时
 * 壁纸(含纱)搬进 chat 根([data-bn-chat-root],fixed 满屏、自带 stacking
 * context)的 ::before 做静态高斯模糊;z-index:-1 画在根背景之上、内容之下。
 */
export function composeChatWallpaperCss(
	mode: SkinMode,
	assetUrl: (name: string) => string,
	theme: ResolvedTheme,
): string {
	const wp = mode.chat?.wallpaper;
	if (!wp?.image || wp.blur === undefined || wp.blur <= 0) return "";
	const layers = buildWallpaperLayers({ ...wp, image: wp.image }, assetUrl, theme);
	return `[data-bn-chat-root]::before{content:"";position:absolute;inset:-${wp.blur * 2}px;z-index:-1;pointer-events:none;background:${layers};filter:blur(${wp.blur}px)}`;
}

const SKIN_STYLE_ID = "bn-skin-css";

/** 皮肤 CSS 注入:单例 <style>,重复调用覆盖内容;空串等价于清除。 */
export function applySkinCss(css: string): void {
	if (css === "") {
		clearSkinCss();
		return;
	}
	let el = document.getElementById(SKIN_STYLE_ID);
	if (!(el instanceof HTMLStyleElement)) {
		el = document.createElement("style");
		el.id = SKIN_STYLE_ID;
		document.head.appendChild(el);
	}
	el.textContent = css;
}

export function clearSkinCss(): void {
	document.getElementById(SKIN_STYLE_ID)?.remove();
}
