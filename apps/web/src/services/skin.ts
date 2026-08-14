/**
 * 皮肤合成层:SkinMode(语义字段)→ CSS 变量表 → documentElement 注入。
 * 预览与正式应用共用这一套函数(定案);变量值在服务端已过注入面校验,
 * 这里用 setProperty 注入 —— DOM API 不解析分号逃逸,是第二道保险。
 */

import {
	SKIN_COLOR_TOKEN_MAP,
	type SkinDecoration,
	type SkinManifest,
	type SkinMode,
} from "@bilibili-notify/contract";
import type { CSSProperties } from "react";
import type { ResolvedTheme } from "../store/theme";

export type SkinVars = Record<string, string>;

/** 需要引号的字体名:含空格或任何非 ASCII 字符。 */
function quoteFontName(name: string): string {
	return /^[A-Za-z0-9-]+$/.test(name) ? name : `"${name}"`;
}

export function composeSkinVars(mode: SkinMode, assetUrl: (name: string) => string): SkinVars {
	const vars: SkinVars = {};

	if (mode.colors) {
		for (const [key, cssVar] of Object.entries(SKIN_COLOR_TOKEN_MAP)) {
			const value = mode.colors[key as keyof typeof SKIN_COLOR_TOKEN_MAP];
			if (value) vars[cssVar] = value;
		}
	}

	if (mode.page?.background) vars["--bn-page-bg"] = mode.page.background;

	if (mode.wallpaper?.image) {
		const wp = mode.wallpaper;
		const imageName = mode.wallpaper.image;
		const fit = wp.fit ?? "cover";
		const position = wp.position ?? "center";
		const layers: string[] = [];
		if (wp.overlay !== undefined && wp.overlay > 0) {
			const o = `rgba(0, 0, 0, ${wp.overlay})`;
			layers.push(`linear-gradient(${o}, ${o})`);
		}
		const image = `url("${assetUrl(imageName)}")`;
		layers.push(
			fit === "tile"
				? `${image} ${position} repeat`
				: `${image} ${position} / ${fit === "contain" ? "contain" : "cover"} no-repeat`,
		);
		vars["--bn-page-bg"] = layers.join(", ");
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

	return vars;
}

/** 九宫格锚点 → fixed 定位样式;offset 与居中位移一起进 transform。 */
export function decorationStyle(d: SkinDecoration): CSSProperties {
	const [v, h] = ((): [string, string] => {
		switch (d.anchor) {
			case "top-left":
				return ["top", "left"];
			case "top":
				return ["top", "center"];
			case "top-right":
				return ["top", "right"];
			case "left":
				return ["middle", "left"];
			case "center":
				return ["middle", "center"];
			case "right":
				return ["middle", "right"];
			case "bottom-left":
				return ["bottom", "left"];
			case "bottom":
				return ["bottom", "center"];
			default:
				return ["bottom", "right"];
		}
	})();
	const style: CSSProperties = { width: d.width, opacity: d.opacity };
	let tx = `${d.offsetX ?? 0}px`;
	let ty = `${d.offsetY ?? 0}px`;
	if (v === "top") style.top = 0;
	else if (v === "bottom") style.bottom = 0;
	else {
		style.top = "50%";
		ty = `calc(-50% + ${ty})`;
	}
	if (h === "left") style.left = 0;
	else if (h === "right") style.right = 0;
	else {
		style.left = "50%";
		tx = `calc(-50% + ${tx})`;
	}
	style.transform = `translate(${tx}, ${ty})`;
	return style;
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
