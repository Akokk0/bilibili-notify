/**
 * 皮肤编辑器的纯函数层:draft(SkinManifest)的不可变修改与表单值互转。
 * 约定「空值即删除」—— 编辑器里清空一个字段等于「回默认装」,draft 里不留
 * 空串/空对象,这样保存的 manifest 与手写的一样干净,服务端校验也不会被空串绊倒。
 */

import type { SkinColorKey, SkinManifest, SkinMode, SkinTextSlot } from "@bilibili-notify/contract";

/**
 * 明暗两套的中文名。皮肤这一块**只认这一份** —— 同一套皮肤在库列表叫「深色」、
 * 在编辑器里叫别的,主人只会以为那是两回事。
 */
export const MODE_LABEL: Record<"light" | "dark", string> = { light: "浅色", dark: "深色" };

/** 去掉 undefined 与空串成员(数字 0 是合法值,保留);清空后整个 section 就地消失。 */
export function cleanSection<T extends Record<string, unknown>>(obj: T): T | undefined {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined || value === "") continue;
		out[key] = value;
	}
	return Object.keys(out).length > 0 ? (out as T) : undefined;
}

/** 不可变地写一套 mode 的某个 section;value 为 undefined 即删除。mode 不存在时不造新套。 */
export function setModeSection<K extends keyof SkinMode>(
	manifest: SkinManifest,
	mode: "light" | "dark",
	section: K,
	value: SkinMode[K] | undefined,
): SkinManifest {
	const prev = manifest.modes[mode];
	if (!prev) return manifest;
	const nextMode: SkinMode = { ...prev };
	if (value === undefined) delete nextMode[section];
	else nextMode[section] = value;
	return { ...manifest, modes: { ...manifest.modes, [mode]: nextMode } };
}

/** 写文案槽;空串删槽;texts 清空后整个字段消失(与「没配过」同构)。 */
export function setManifestText(
	manifest: SkinManifest,
	slot: SkinTextSlot,
	value: string,
): SkinManifest {
	const texts = { ...(manifest.texts ?? {}) };
	if (value === "") delete texts[slot];
	else texts[slot] = value;
	const next = { ...manifest };
	if (Object.keys(texts).length > 0) next.texts = texts;
	else delete next.texts;
	return next;
}

/** 编辑器颜色区的分组与中文标签;测试保证与 SKIN_COLOR_TOKEN_MAP 恰好一一对应。 */
export const COLOR_GROUPS: ReadonlyArray<{
	label: string;
	keys: ReadonlyArray<{ key: SkinColorKey; label: string }>;
}> = [
	{
		label: "主色",
		keys: [
			{ key: "accent", label: "主强调色" },
			{ key: "accentSoft", label: "主强调·柔" },
			{ key: "accentAlt", label: "副强调色" },
			{ key: "accentAltSoft", label: "副强调·柔" },
			{ key: "accentAltBright", label: "副强调·亮" },
			{ key: "highlight", label: "高亮点缀" },
		],
	},
	{
		label: "文字",
		keys: [
			{ key: "textPrimary", label: "正文" },
			{ key: "textSecondary", label: "次要" },
			{ key: "textTertiary", label: "辅助" },
			{ key: "textDisabled", label: "禁用" },
		],
	},
	{
		label: "表面与边框",
		keys: [
			{ key: "surface", label: "表面" },
			{ key: "surfaceStrong", label: "表面·强" },
			{ key: "surfaceMuted", label: "表面·弱" },
			{ key: "field", label: "输入框底" },
			{ key: "border", label: "边框" },
			{ key: "borderSubtle", label: "边框·淡" },
			{ key: "hoverMuted", label: "悬停底" },
			{ key: "listRow", label: "行条底" },
			{ key: "listRowBorder", label: "行条描边" },
			{ key: "codeBg", label: "代码底" },
			{ key: "overlay", label: "遮罩" },
		],
	},
	{
		label: "状态色",
		keys: [
			{ key: "danger", label: "危险" },
			{ key: "dangerSoft", label: "危险·底" },
			{ key: "dangerText", label: "危险·字" },
			{ key: "dangerBorder", label: "危险·框" },
			{ key: "success", label: "成功" },
			{ key: "successSoft", label: "成功·底" },
			{ key: "successText", label: "成功·字" },
			{ key: "successBorder", label: "成功·框" },
			{ key: "warning", label: "警告" },
			{ key: "warningSoft", label: "警告·底" },
			{ key: "warningText", label: "警告·字" },
			{ key: "warningBorder", label: "警告·框" },
		],
	},
];

/** #rgb / #rrggbb / #rrggbbaa → #rrggbb(原生取色器只认 6 位);其他写法 → null。 */
export function toHex6(value: string): string | null {
	const t = value.trim().toLowerCase();
	if (/^#[0-9a-f]{3}$/.test(t)) {
		return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
	}
	if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(t)) return t.slice(0, 7);
	return null;
}

const RGBA_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([0-9.]+)\s*)?\)$/i;
const HEX_ALPHA_RE = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;

/**
 * 颜色的 alpha 通道 ——「玻璃片透明度」滑杆(与推送卡片/AI 聊天那对同名同义)
 * 的读端。支持 rgb()/rgba()/#rrggbb(aa);hsl/oklch 等认不出 → null。
 */
export function colorAlphaOf(color: string | undefined): number | null {
	if (!color) return null;
	const t = color.trim();
	const m = RGBA_RE.exec(t);
	if (m) return m[4] !== undefined ? Number(m[4]) : 1;
	const h = HEX_ALPHA_RE.exec(t);
	if (h) return h[2] !== undefined ? Number.parseInt(h[2], 16) / 255 : 1;
	return null;
}

/** 保色相只换 alpha,统一产 rgba();色相解析不出时用 fallbackRgb("r, g, b")。 */
export function withColorAlpha(
	color: string | undefined,
	alpha: number,
	fallbackRgb: string,
): string {
	const a = Math.round(alpha * 100) / 100;
	const t = color?.trim() ?? "";
	const m = RGBA_RE.exec(t);
	if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})`;
	const h = HEX_ALPHA_RE.exec(t);
	if (h) {
		const n = Number.parseInt(h[1], 16);
		return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
	}
	return `rgba(${fallbackRgb}, ${a})`;
}

export function fontsToText(fonts: string[] | undefined): string {
	return fonts?.join(", ") ?? "";
}

export function textToFonts(text: string): string[] | undefined {
	const list = text
		.split(",")
		.map((f) => f.trim())
		.filter(Boolean);
	return list.length > 0 ? list : undefined;
}

/** 单套皮肤缺的那一侧;双套 → null。 */
export function missingModeOf(manifest: SkinManifest): "light" | "dark" | null {
	if (!manifest.modes.light) return "light";
	if (!manifest.modes.dark) return "dark";
	return null;
}

/** 把已有那套深拷贝到缺失侧(补套的起点是「和现在一样」,再由用户微调)。 */
export function addMissingMode(manifest: SkinManifest): SkinManifest {
	const missing = missingModeOf(manifest);
	if (!missing) return manifest;
	const source = manifest.modes.light ?? manifest.modes.dark ?? {};
	const copy = JSON.parse(JSON.stringify(source)) as SkinMode;
	return { ...manifest, modes: { ...manifest.modes, [missing]: copy } };
}
