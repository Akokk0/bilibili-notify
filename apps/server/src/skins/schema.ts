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
	SKIN_TEXT_SLOTS,
	type SkinEffects,
	type SkinManifest,
	type SkinMode,
} from "@bilibili-notify/contract";
import { z } from "zod";
import { sanitizeSkinCss } from "./css-sanitizer.js";

export type ParseSkinResult =
	| { ok: true; skin: SkinManifest; warnings: string[] }
	| { ok: false; errors: string[] };

// ---- 值语法校验 -----------------------------------------------------------

const FORBIDDEN_SUBSTRINGS = ["url(", "var(", "expression", ";", "{", "}", "@", "\\", "/*"];

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN_RE = /^(rgb|rgba|hsl|hsla|oklch|oklab)\(\s*[0-9a-z%.,\s/-]*\)$/i;
const GRADIENT_HEAD_RE = /^(repeating-)?(linear|radial|conic)-gradient\(/i;
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
const KNOWN_MODE_KEYS = new Set([
	"colors",
	"page",
	"wallpaper",
	"chat",
	"glass",
	"fonts",
	"radius",
	"shadows",
	"css",
	"effects",
]);
const MAX_BOKEH_COLORS = 4;
/** 阴影语法:与渐变同一把安全尺(数字/px/颜色函数/逗号),再叠 FORBIDDEN 黑名单。 */
const SHADOW_RE = /^[a-z0-9#%.,()\s/-]{1,200}$/i;

/** 只认包内 assets 一级目录下的图片文件;路径穿越连正则都进不来。zip 层复用同一把尺。 */
export const WALLPAPER_IMAGE_RE = /^assets\/[A-Za-z0-9._-]+\.(webp|jpe?g|png)$/i;
const WALLPAPER_FITS = new Set(["cover", "contain", "tile"]);
const POSITION_RE = /^[a-z0-9%\s]{1,40}$/i;
/** 字体名:任意语言文字/数字/空格/点/连字符;引号等标点进不来,合成层自己加引号。 */
const FONT_NAME_RE = /^[\p{L}\p{N}\s._-]{1,50}$/u;

/** 字体栈保留几个。超出的截掉 —— 回退链有 8 个已经绰绰有余。 */
const MAX_FONTS = 8;

/**
 * css 字段的统一入口:清洗后存产物,warnings 挂 path 前缀透传;
 * 清洗后为空 = 与没写同构(不留空串字段)。
 */
function parseCssField(
	raw: unknown,
	path: string,
	errors: string[],
	warnings: string[],
): string | undefined {
	if (typeof raw !== "string") {
		errors.push(`${path}: 必须是 CSS 字符串`);
		return undefined;
	}
	const res = sanitizeSkinCss(raw);
	if (!res.ok) {
		errors.push(...res.errors.map((e) => `${path}: ${e}`));
		return undefined;
	}
	warnings.push(...res.warnings.map((w) => `${path}: ${w}`));
	return res.css !== "" ? res.css : undefined;
}

function numberIn(v: unknown, min: number, max: number): v is number {
	return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;
}

/** 壁纸段解析:整页 wallpaper 与 chat.wallpaper 同构,共用这一把尺。 */
function parseWallpaper(
	raw: unknown,
	path: string,
	errors: string[],
): SkinMode["wallpaper"] | undefined {
	const wp = asRecord(raw);
	if (!wp) {
		errors.push(`${path}: 必须是对象`);
		return undefined;
	}
	const out: NonNullable<SkinMode["wallpaper"]> = {};
	if (wp.image !== undefined) {
		if (
			typeof wp.image !== "string" ||
			wp.image.includes("..") ||
			!WALLPAPER_IMAGE_RE.test(wp.image)
		) {
			errors.push(`${path}.image: 只能引用包内 assets/<文件名>.webp|jpg|png`);
		} else {
			out.image = wp.image;
		}
	}
	if (wp.fit !== undefined) {
		if (typeof wp.fit !== "string" || !WALLPAPER_FITS.has(wp.fit)) {
			errors.push(`${path}.fit: 只能是 cover / contain / tile`);
		} else {
			out.fit = wp.fit as NonNullable<SkinMode["wallpaper"]>["fit"];
		}
	}
	if (wp.position !== undefined) {
		if (typeof wp.position !== "string" || !POSITION_RE.test(wp.position)) {
			errors.push(`${path}.position: 只收关键词/百分比(如 "center top")`);
		} else {
			out.position = wp.position.trim();
		}
	}
	if (wp.overlay !== undefined) {
		if (!numberIn(wp.overlay, 0, 0.8)) {
			errors.push(`${path}.overlay: 必须是 0~0.8 的数字`);
		} else {
			out.overlay = wp.overlay;
		}
	}
	if (wp.blur !== undefined) {
		if (!numberIn(wp.blur, 0, 40)) {
			errors.push(`${path}.blur: 必须是 0~40 的数字(px)`);
		} else {
			out.blur = wp.blur;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
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
		const wp = parseWallpaper(raw.wallpaper, `${path}.wallpaper`, errors);
		if (wp) mode.wallpaper = wp;
	}

	if (raw.chat !== undefined) {
		const chat = asRecord(raw.chat);
		if (!chat) {
			errors.push(`${path}.chat: 必须是对象`);
		} else {
			// chat 段只管背景:强调色派生自 colors.accent、玻璃件直用 glass 段,
			// 不另设一套参数。老包里的 accent/accentSecondary 静默忽略。
			const out: NonNullable<SkinMode["chat"]> = {};
			if (chat.background !== undefined) {
				if (typeof chat.background !== "string" || !isBackground(chat.background)) {
					errors.push(`${path}.chat.background: 不是合法背景值(纯色或渐变)`);
				} else {
					out.background = chat.background.trim();
				}
			}
			if (chat.wallpaper !== undefined) {
				const wp = parseWallpaper(chat.wallpaper, `${path}.chat.wallpaper`, errors);
				if (wp) out.wallpaper = wp;
			}
			if (Object.keys(out).length > 0) mode.chat = out;
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
			/**
			 * 字体栈**宽容收**:超长截断、CSS 原文的引号剥掉,只有真出现注入字符
			 * 才拒整包。
			 *
			 * 分寸在这里:一串十来个名字的中文字体栈是 AI 照 CSS 习惯写出来的格式
			 * 毛病(真机踩过,白烧一趟两分半的生成),截到 8 个毫发无伤;而 `url(`、
			 * 分号这类东西不是笔误是攻击信号,静默剔掉等于把它藏起来 —— 那种照旧拒。
			 */
			const list = Array.isArray(fonts.body) ? fonts.body : null;
			const names = list?.every((f) => typeof f === "string")
				? (list as string[]).map((f) =>
						f
							.trim()
							.replace(/^["']|["']$/g, "")
							.trim(),
					)
				: null;
			if (!names || names.length === 0 || !names.every((f) => FONT_NAME_RE.test(f))) {
				errors.push(`${path}.fonts.body: 必须是 1~8 个字体名(仅文字/数字/空格/点/连字符)`);
			} else {
				if (names.length > MAX_FONTS) {
					warnings.push(`${path}.fonts.body: 超过 ${MAX_FONTS} 个字体名,已截断`);
				}
				mode.fonts = { body: names.slice(0, MAX_FONTS) };
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

	// decorations(贴纸装饰层)已下线(主人真机验收后砍掉):存量皮肤里的它
	// 走 KNOWN_MODE_KEYS 的未知字段告警 + 忽略,优雅降级。

	if (raw.shadows !== undefined) {
		const shadows = asRecord(raw.shadows);
		if (!shadows) {
			errors.push(`${path}.shadows: 必须是对象`);
		} else {
			const out: NonNullable<SkinMode["shadows"]> = {};
			for (const key of ["card", "elev"] as const) {
				const v = shadows[key];
				if (v === undefined) continue;
				if (typeof v !== "string" || hasForbidden(v) || !SHADOW_RE.test(v)) {
					errors.push(`${path}.shadows.${key}: 不是合法阴影值`);
				} else {
					out[key] = v.trim();
				}
			}
			if (Object.keys(out).length > 0) mode.shadows = out;
		}
	}

	// banner(首页 hero 横幅)已下线(主人拍板不要这个入口):存量皮肤里的它
	// 走下方 KNOWN_MODE_KEYS 的未知字段告警 + 忽略,优雅降级。

	if (raw.css !== undefined) {
		const css = parseCssField(raw.css, `${path}.css`, errors, warnings);
		if (css !== undefined) mode.css = css;
	}

	if (raw.effects !== undefined) {
		const fx = asRecord(raw.effects);
		if (!fx) {
			errors.push(`${path}.effects: 必须是对象`);
		} else {
			const out: SkinEffects = {};

			if (fx.glassShine !== undefined) {
				const g = asRecord(fx.glassShine);
				if (!g) {
					errors.push(`${path}.effects.glassShine: 必须是对象(可为空对象)`);
				} else if (g.color !== undefined && (typeof g.color !== "string" || !isColor(g.color))) {
					errors.push(`${path}.effects.glassShine.color: 不是合法颜色值`);
				} else {
					out.glassShine = g.color !== undefined ? { color: (g.color as string).trim() } : {};
				}
			}

			if (fx.bokeh !== undefined) {
				const b = asRecord(fx.bokeh);
				if (
					!b ||
					!Array.isArray(b.colors) ||
					b.colors.length === 0 ||
					b.colors.length > MAX_BOKEH_COLORS ||
					!b.colors.every((c) => typeof c === "string" && isColor(c))
				) {
					errors.push(`${path}.effects.bokeh.colors: 必须是 1~${MAX_BOKEH_COLORS} 个合法颜色`);
				} else {
					out.bokeh = { colors: b.colors.map((c) => (c as string).trim()) };
				}
			}

			for (const key of Object.keys(fx)) {
				// backgroundFlow(卡顿)与 particles(主人砍掉)均已移除:存量皮肤里的它们
				// 走这里的未知字段告警 + 忽略,优雅降级。
				if (!["glassShine", "bokeh"].includes(key)) {
					warnings.push(`${path}.effects.${key}: 不认识的字段,已忽略`);
				}
			}
			if (Object.keys(out).length > 0) mode.effects = out;
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
	const KNOWN_TOP_KEYS = [
		"schemaVersion",
		"name",
		"author",
		"description",
		"modes",
		"texts",
		"css",
	];
	for (const key of Object.keys(input)) {
		if (!KNOWN_TOP_KEYS.includes(key)) warnings.push(`${key}: 不认识的字段,已忽略`);
	}

	let texts: SkinManifest["texts"];
	const rawTexts = (input as Record<string, unknown>).texts;
	if (rawTexts !== undefined) {
		const rec = asRecord(rawTexts);
		if (!rec) {
			errors.push("texts: 必须是对象");
		} else {
			const out: Record<string, string> = {};
			for (const [slot, value] of Object.entries(rec)) {
				if (!(SKIN_TEXT_SLOTS as readonly string[]).includes(slot)) {
					warnings.push(`texts.${slot}: 不认识的文案槽位,已忽略`);
					continue;
				}
				if (typeof value !== "string" || value.length === 0 || value.length > 60) {
					errors.push(`texts.${slot}: 必须是 1~60 字的字符串`);
					continue;
				}
				out[slot] = value;
			}
			if (Object.keys(out).length > 0) texts = out as SkinManifest["texts"];
		}
	}

	let css: string | undefined;
	const rawCss = (input as Record<string, unknown>).css;
	if (rawCss !== undefined) css = parseCssField(rawCss, "css", errors, warnings);

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
		...(texts !== undefined ? { texts } : {}),
		...(css !== undefined ? { css } : {}),
	};
	return { ok: true, skin, warnings };
}
