/**
 * skin.json 校验层。类型与语义字段清单在 `@bilibili-notify/contract`(skin.ts);
 * 这里负责把不可信输入变成 SkinManifest:非法拒绝(errors)、未知字段忽略并告警
 * (warnings)、缺字段留空由前端回默认装。
 *
 * 值最终会注入页面 CSS 变量,所以一切颜色/背景值都过注入面防御:禁 url()(外联
 * 隐私泄露面)、var()(读内部变量)、分号/大括号/注释符(逃逸声明块)。
 */

import {
	SKIN_COLOR_TOKEN_MAP,
	SKIN_SCHEMA_VERSION,
	type SkinManifest,
	type SkinMode,
} from "@bilibili-notify/contract";
import { z } from "zod";

export type ParseSkinResult =
	| { ok: true; skin: SkinManifest; warnings: string[] }
	| { ok: false; errors: string[] };

// ---- 值语法校验 -----------------------------------------------------------

const FORBIDDEN_SUBSTRINGS = ["url(", "var(", "expression", ";", "{", "}", "@", "\\", "/*"];

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN_RE = /^(rgb|rgba|hsl|hsla|oklch|oklab)\(\s*[0-9a-z%.,\s/-]*\)$/i;
const GRADIENT_HEAD_RE = /^(linear|radial|conic)-gradient\(/i;
const GRADIENT_BODY_RE = /^[a-z0-9#%.,()\s/-]+$/i;

function hasForbidden(v: string): boolean {
	const low = v.toLowerCase();
	return FORBIDDEN_SUBSTRINGS.some((s) => low.includes(s));
}

/** 纯色:hex / transparent / rgb·hsl·oklch 函数色。 */
function isColor(v: string): boolean {
	if (hasForbidden(v)) return false;
	const t = v.trim();
	return HEX_RE.test(t) || t === "transparent" || COLOR_FN_RE.test(t);
}

/** 整页背景:纯色或渐变(可多层逗号叠加,整串限安全字符集)。 */
function isBackground(v: string): boolean {
	if (hasForbidden(v)) return false;
	const t = v.trim();
	if (isColor(t)) return true;
	return GRADIENT_HEAD_RE.test(t) && GRADIENT_BODY_RE.test(t);
}

// ---- mode 解析 ------------------------------------------------------------

const KNOWN_COLOR_KEYS = new Set(Object.keys(SKIN_COLOR_TOKEN_MAP));
const KNOWN_MODE_KEYS = new Set(["colors", "page", "wallpaper", "glass", "fonts", "radius"]);

/** 只认包内 assets 一级目录下的图片文件;路径穿越连正则都进不来。zip 层复用同一把尺。 */
export const WALLPAPER_IMAGE_RE = /^assets\/[A-Za-z0-9._-]+\.(webp|jpe?g|png)$/i;
const WALLPAPER_FITS = new Set(["cover", "contain", "tile"]);
const POSITION_RE = /^[a-z0-9%\s]{1,40}$/i;
/** 字体名:任意语言文字/数字/空格/点/连字符;引号等标点进不来,合成层自己加引号。 */
const FONT_NAME_RE = /^[\p{L}\p{N}\s._-]{1,50}$/u;

function numberIn(v: unknown, min: number, max: number): v is number {
	return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;
}

function parseMode(
	raw: Record<string, unknown>,
	path: string,
	errors: string[],
	warnings: string[],
): SkinMode {
	const mode: SkinMode = {};

	if (raw.colors !== undefined) {
		if (typeof raw.colors !== "object" || raw.colors === null || Array.isArray(raw.colors)) {
			errors.push(`${path}.colors: 必须是对象`);
		} else {
			const colors: Record<string, string> = {};
			for (const [key, value] of Object.entries(raw.colors)) {
				if (!KNOWN_COLOR_KEYS.has(key)) {
					warnings.push(`${path}.colors.${key}: 不认识的颜色键,已忽略`);
					continue;
				}
				if (typeof value !== "string" || !isColor(value)) {
					errors.push(`${path}.colors.${key}: 不是合法颜色值(hex/rgb/hsl/oklch/transparent)`);
					continue;
				}
				colors[key] = value.trim();
			}
			if (Object.keys(colors).length > 0) mode.colors = colors as SkinMode["colors"];
		}
	}

	if (raw.page !== undefined) {
		const page = asRecord(raw.page);
		if (!page) {
			errors.push(`${path}.page: 必须是对象`);
		} else if (page.background !== undefined) {
			if (typeof page.background !== "string" || !isBackground(page.background)) {
				errors.push(`${path}.page.background: 不是合法背景值(纯色或渐变)`);
			} else {
				mode.page = { background: page.background.trim() };
			}
		}
	}

	if (raw.wallpaper !== undefined) {
		const wp = asRecord(raw.wallpaper);
		if (!wp) {
			errors.push(`${path}.wallpaper: 必须是对象`);
		} else {
			const out: NonNullable<SkinMode["wallpaper"]> = {};
			if (wp.image !== undefined) {
				if (
					typeof wp.image !== "string" ||
					wp.image.includes("..") ||
					!WALLPAPER_IMAGE_RE.test(wp.image)
				) {
					errors.push(`${path}.wallpaper.image: 只能引用包内 assets/<文件名>.webp|jpg|png`);
				} else {
					out.image = wp.image;
				}
			}
			if (wp.fit !== undefined) {
				if (typeof wp.fit !== "string" || !WALLPAPER_FITS.has(wp.fit)) {
					errors.push(`${path}.wallpaper.fit: 只能是 cover / contain / tile`);
				} else {
					out.fit = wp.fit as NonNullable<SkinMode["wallpaper"]>["fit"];
				}
			}
			if (wp.position !== undefined) {
				if (typeof wp.position !== "string" || !POSITION_RE.test(wp.position)) {
					errors.push(`${path}.wallpaper.position: 只收关键词/百分比(如 "center top")`);
				} else {
					out.position = wp.position.trim();
				}
			}
			if (wp.overlay !== undefined) {
				if (!numberIn(wp.overlay, 0, 0.8)) {
					errors.push(`${path}.wallpaper.overlay: 必须是 0~0.8 的数字`);
				} else {
					out.overlay = wp.overlay;
				}
			}
			if (Object.keys(out).length > 0) mode.wallpaper = out;
		}
	}

	if (raw.glass !== undefined) {
		const glass = asRecord(raw.glass);
		if (!glass) {
			errors.push(`${path}.glass: 必须是对象`);
		} else {
			const out: NonNullable<SkinMode["glass"]> = {};
			for (const key of ["background", "border", "strongBackground", "strongBorder"] as const) {
				const v = glass[key];
				if (v === undefined) continue;
				if (typeof v !== "string" || !isColor(v)) {
					errors.push(`${path}.glass.${key}: 不是合法颜色值`);
				} else {
					out[key] = v.trim();
				}
			}
			for (const key of ["blur", "strongBlur"] as const) {
				const v = glass[key];
				if (v === undefined) continue;
				if (!numberIn(v, 0, 40)) {
					errors.push(`${path}.glass.${key}: 必须是 0~40 的数字(px)`);
				} else {
					out[key] = v;
				}
			}
			if (Object.keys(out).length > 0) mode.glass = out;
		}
	}

	if (raw.fonts !== undefined) {
		const fonts = asRecord(raw.fonts);
		if (!fonts) {
			errors.push(`${path}.fonts: 必须是对象`);
		} else if (fonts.body !== undefined) {
			if (
				!Array.isArray(fonts.body) ||
				fonts.body.length === 0 ||
				fonts.body.length > 8 ||
				!fonts.body.every((f) => typeof f === "string" && FONT_NAME_RE.test(f))
			) {
				errors.push(`${path}.fonts.body: 必须是 1~8 个字体名(仅文字/数字/空格/点/连字符)`);
			} else {
				mode.fonts = { body: fonts.body.map((f) => (f as string).trim()) };
			}
		}
	}

	if (raw.radius !== undefined) {
		const radius = asRecord(raw.radius);
		if (!radius) {
			errors.push(`${path}.radius: 必须是对象`);
		} else {
			const out: NonNullable<SkinMode["radius"]> = {};
			if (radius.card !== undefined) {
				if (!numberIn(radius.card, 0, 32)) {
					errors.push(`${path}.radius.card: 必须是 0~32 的数字(px)`);
				} else {
					out.card = radius.card;
				}
			}
			if (radius.pill !== undefined) {
				if (!numberIn(radius.pill, 0, 999)) {
					errors.push(`${path}.radius.pill: 必须是 0~999 的数字(px)`);
				} else {
					out.pill = radius.pill;
				}
			}
			if (Object.keys(out).length > 0) mode.radius = out;
		}
	}

	for (const key of Object.keys(raw)) {
		if (!KNOWN_MODE_KEYS.has(key)) warnings.push(`${path}.${key}: 不认识的字段,已忽略`);
	}

	return mode;
}

// ---- manifest 骨架 --------------------------------------------------------

const ManifestSchema = z.looseObject({
	schemaVersion: z.literal(SKIN_SCHEMA_VERSION, {
		error: `schemaVersion 必须是 ${SKIN_SCHEMA_VERSION}(不认识的版本,可能需要升级本体)`,
	}),
	name: z.string({ error: "name 必须是字符串" }).min(1, "name 不能为空").max(50, "name 最长 50 字"),
	author: z.string().max(50, "author 最长 50 字").optional(),
	description: z.string().max(200, "description 最长 200 字").optional(),
	modes: z.looseObject({
		light: z.looseObject({}).optional(),
		dark: z.looseObject({}).optional(),
	}),
});

export function parseSkinManifest(input: unknown): ParseSkinResult {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, errors: ["skin.json 顶层必须是对象"] };
	}
	const parsed = ManifestSchema.safeParse(input);
	if (!parsed.success) {
		return {
			ok: false,
			errors: parsed.error.issues.map((i) =>
				i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
			),
		};
	}
	const raw = parsed.data;
	if (!raw.modes.light && !raw.modes.dark) {
		return { ok: false, errors: ["modes 至少要给 light / dark 其中一套"] };
	}

	const errors: string[] = [];
	const warnings: string[] = [];
	const KNOWN_TOP_KEYS = ["schemaVersion", "name", "author", "description", "modes"];
	for (const key of Object.keys(input)) {
		if (!KNOWN_TOP_KEYS.includes(key)) warnings.push(`${key}: 不认识的字段,已忽略`);
	}
	const modes: SkinManifest["modes"] = {};
	if (raw.modes.light) modes.light = parseMode(raw.modes.light, "modes.light", errors, warnings);
	if (raw.modes.dark) modes.dark = parseMode(raw.modes.dark, "modes.dark", errors, warnings);
	if (errors.length > 0) return { ok: false, errors };

	const skin: SkinManifest = {
		schemaVersion: SKIN_SCHEMA_VERSION,
		name: raw.name,
		...(raw.author !== undefined ? { author: raw.author } : {}),
		...(raw.description !== undefined ? { description: raw.description } : {}),
		modes,
	};
	return { ok: true, skin, warnings };
}
